import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { yolfiApiRequest, yolfiApiTest } from './GenericFunctions';
import { yolfiProperties } from './descriptions';
import { paymentLinkOutput, subscriptionOutput } from './Output';

const supportedCurrencies = new Set(['USD', 'EUR', 'CNY', 'RUB', 'INR', 'TRY', 'KRW', 'JPY']);
const paymentLinkFilters = new Set(['all', 'disabled', 'one-time', 'recurring']);
const customerSorts = new Set(['newest', 'name', 'spent', 'payments', 'last-payment']);

function isObject(value: unknown): value is IDataObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(
	context: IExecuteFunctions,
	parameter: string,
	itemIndex: number,
	maximumLength = 255,
): string {
	const value = context.getNodeParameter(parameter, itemIndex);
	if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) {
		throw new NodeOperationError(
			context.getNode(),
			`${parameter} must be a non-empty string of at most ${maximumLength} characters`,
			{ itemIndex },
		);
	}
	return value.trim();
}

function decimalAmount(context: IExecuteFunctions, parameter: string, itemIndex: number): string {
	const value = requiredString(context, parameter, itemIndex, 64);
	const [whole, fraction = ''] = value.split('.');
	if (
		!/^\d+(?:\.\d+)?$/.test(value) ||
		(!/[1-9]/.test(whole) && !/[1-9]/.test(fraction.slice(0, 2)))
	) {
		throw new NodeOperationError(
			context.getNode(),
			`${parameter} must be a decimal string of at least 0.01`,
			{
				itemIndex,
			},
		);
	}
	return value;
}

function readCurrency(context: IExecuteFunctions, itemIndex: number): string {
	const value = context.getNodeParameter('currency', itemIndex);
	if (typeof value !== 'string' || !supportedCurrencies.has(value)) {
		throw new NodeOperationError(context.getNode(), 'Choose a supported pricing currency', {
			itemIndex,
		});
	}
	return value;
}

function readMetadata(context: IExecuteFunctions, value: unknown, itemIndex: number): IDataObject {
	let metadata: unknown = value;
	if (typeof metadata === 'string') {
		try {
			metadata = JSON.parse(metadata);
		} catch {
			throw new NodeOperationError(context.getNode(), 'Metadata must be a valid JSON object', {
				itemIndex,
			});
		}
	}
	if (
		!isObject(metadata) ||
		(Object.getPrototypeOf(metadata) !== Object.prototype &&
			Object.getPrototypeOf(metadata) !== null) ||
		Object.keys(metadata).length > 20
	) {
		throw new NodeOperationError(
			context.getNode(),
			'Metadata must be a JSON object with at most 20 entries',
			{
				itemIndex,
			},
		);
	}
	for (const [key, entry] of Object.entries(metadata)) {
		if (
			!/^[a-zA-Z0-9_-]{1,64}$/.test(key) ||
			!(
				(typeof entry === 'string' && entry.length <= 500) ||
				(typeof entry === 'number' && Number.isFinite(entry)) ||
				typeof entry === 'boolean'
			)
		) {
			throw new NodeOperationError(
				context.getNode(),
				'Metadata keys must use 1-64 letters, digits, underscores, or hyphens; values must be strings of at most 500 characters, finite numbers, or booleans',
				{ itemIndex },
			);
		}
	}
	return metadata;
}

function copyStrings(
	context: IExecuteFunctions,
	source: IDataObject,
	target: IDataObject,
	limits: Record<string, number>,
	itemIndex: number,
): void {
	for (const [key, maximum] of Object.entries(limits)) {
		if (source[key] === undefined) continue;
		const value = source[key];
		if (typeof value !== 'string' || value.trim().length > maximum) {
			throw new NodeOperationError(
				context.getNode(),
				`${key} must be a string of at most ${maximum} characters`,
				{
					itemIndex,
				},
			);
		}
		if (value.trim()) target[key] = value.trim();
	}
}

function responseObject(
	context: IExecuteFunctions,
	envelope: IDataObject,
	itemIndex: number,
): IDataObject {
	if (!isObject(envelope.data)) {
		throw new NodeOperationError(
			context.getNode(),
			'Yolfi returned an unexpected response object',
			{
				itemIndex,
			},
		);
	}
	return envelope.data;
}

function withCheckoutUrl(
	context: IExecuteFunctions,
	data: IDataObject,
	itemIndex: number,
): IDataObject {
	if (typeof data.id !== 'string' || !data.id) {
		throw new NodeOperationError(context.getNode(), 'Yolfi returned a payment link without an ID', {
			itemIndex,
		});
	}
	return {
		...paymentLinkOutput(data),
		checkoutUrl: `https://pay.yolfi.com/${encodeURIComponent(data.id)}`,
	};
}

async function getMany(
	context: IExecuteFunctions,
	resource: 'customer' | 'paymentLink',
	itemIndex: number,
): Promise<IDataObject[]> {
	const returnAll = context.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll ? Infinity : context.getNodeParameter('limit', itemIndex, 50);
	if (
		typeof limit !== 'number' ||
		(!returnAll && (!Number.isInteger(limit) || limit < 1 || limit > 10000))
	) {
		throw new NodeOperationError(
			context.getNode(),
			'Limit must be an integer between 1 and 10,000',
			{
				itemIndex,
			},
		);
	}
	const options = context.getNodeParameter(
		resource === 'customer' ? 'customerListOptions' : 'paymentLinkListOptions',
		itemIndex,
		{},
	) as IDataObject;
	const query: IDataObject = {};
	if (resource === 'paymentLink') {
		const filter = options.filter ?? 'all';
		if (typeof filter !== 'string' || !paymentLinkFilters.has(filter)) {
			throw new NodeOperationError(context.getNode(), 'Choose a supported payment link filter', {
				itemIndex,
			});
		}
		query.filter = filter;
	} else {
		const sort = options.sort ?? 'newest';
		if (typeof sort !== 'string' || !customerSorts.has(sort)) {
			throw new NodeOperationError(context.getNode(), 'Choose a supported customer ordering', {
				itemIndex,
			});
		}
		query.sort = sort;
		copyStrings(context, options, query, { search: 1000 }, itemIndex);
	}
	const pageSize = Math.min(100, limit);
	query[resource === 'customer' ? 'pageSize' : 'rows'] = pageSize;
	const results: IDataObject[] = [];
	let targetTotal: number | undefined;
	let previousPage: string | undefined;
	for (let page = 1; ; page++) {
		const envelope = await yolfiApiRequest.call(
			context,
			'GET',
			resource === 'customer' ? '/private/customers' : '/private/paylinks',
			undefined,
			{ ...query, page },
		);
		if (!Array.isArray(envelope.data) || !envelope.data.every(isObject)) {
			throw new NodeOperationError(
				context.getNode(),
				'Yolfi returned an unexpected list response',
				{
					itemIndex,
				},
			);
		}
		if (targetTotal === undefined) {
			if (
				typeof envelope.total !== 'number' ||
				!Number.isSafeInteger(envelope.total) ||
				envelope.total < 0
			) {
				throw new NodeOperationError(
					context.getNode(),
					'Yolfi returned an invalid pagination total',
					{
						itemIndex,
					},
				);
			}
			targetTotal = envelope.total;
		}
		const entries = envelope.data as IDataObject[];
		if (entries.length === 0) break;
		const pageFingerprint = JSON.stringify(entries.map((entry) => entry.id));
		if (previousPage === pageFingerprint) {
			throw new NodeOperationError(context.getNode(), 'Yolfi pagination did not advance', {
				itemIndex,
			});
		}
		previousPage = pageFingerprint;
		results.push(...entries.slice(0, limit - results.length));
		if (results.length >= limit || entries.length < pageSize || page * pageSize >= targetTotal)
			break;
	}
	return results;
}

export class Yolfi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Yolfi',
		name: 'yolfi',
		icon: { light: 'file:yolfi.svg', dark: 'file:yolfi.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Create crypto checkouts and payment links, and retrieve Yolfi customers and subscriptions',
		defaults: { name: 'Yolfi' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'yolfiApi', required: true, testedBy: 'yolfiApiTest' }],
		properties: yolfiProperties,
	};

	methods = { credentialTest: { yolfiApiTest } };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				if ((resource === 'customer' || resource === 'paymentLink') && operation === 'getMany') {
					const entries = await getMany(this, resource, itemIndex);
					for (const entry of entries) {
						output.push({
							json: resource === 'paymentLink' ? withCheckoutUrl(this, entry, itemIndex) : entry,
							pairedItem: { item: itemIndex },
						});
					}
					continue;
				}
				let envelope: IDataObject;
				if (resource === 'checkoutSession' && operation === 'create') {
					const idempotencyKey = requiredString(this, 'idempotencyKey', itemIndex, 200);
					if (idempotencyKey.length < 16) {
						throw new NodeOperationError(
							this.getNode(),
							'Idempotency Key must contain 16-200 characters',
							{
								itemIndex,
							},
						);
					}
					const body: IDataObject = {
						amount: decimalAmount(this, 'amount', itemIndex),
						currency: readCurrency(this, itemIndex),
					};
					const options = this.getNodeParameter('checkoutOptions', itemIndex, {}) as IDataObject;
					copyStrings(
						this,
						options,
						body,
						{
							cancelUrl: 2048,
							clientReferenceId: 255,
							customerEmail: 255,
							customerName: 255,
							description: 1000,
							merchantOrderId: 255,
							successUrl: 2048,
						},
						itemIndex,
					);
					if (options.metadata !== undefined)
						body.metadata = readMetadata(this, options.metadata, itemIndex);
					if (options.expiresInMinutes !== undefined) {
						const expires = options.expiresInMinutes;
						if (
							typeof expires !== 'number' ||
							!Number.isInteger(expires) ||
							expires < 5 ||
							expires > 1440
						) {
							throw new NodeOperationError(
								this.getNode(),
								'Expires In Minutes must be an integer from 5 to 1,440',
								{
									itemIndex,
								},
							);
						}
						body.expiresInMinutes = expires;
					}
					envelope = await yolfiApiRequest.call(
						this,
						'POST',
						'/checkout-sessions',
						body,
						undefined,
						{
							'Idempotency-Key': idempotencyKey,
						},
					);
				} else if (resource === 'checkoutSession' && operation === 'get') {
					const id = requiredString(this, 'checkoutSessionId', itemIndex);
					envelope = await yolfiApiRequest.call(
						this,
						'GET',
						`/checkout-sessions/${encodeURIComponent(id)}`,
					);
				} else if (resource === 'paymentLink' && operation === 'create') {
					const body: IDataObject = {
						name: requiredString(this, 'name', itemIndex),
						price: decimalAmount(this, 'price', itemIndex),
						currency: readCurrency(this, itemIndex),
						type: 'ONE_TIME',
						collectEmail: this.getNodeParameter('collectEmail', itemIndex, true) as boolean,
					};
					const options = this.getNodeParameter('paymentLinkOptions', itemIndex, {}) as IDataObject;
					copyStrings(this, options, body, { description: 1000, imageUrl: 2048 }, itemIndex);
					if (options.collectName !== undefined) body.collectName = options.collectName;
					if (options.paymentMetadata !== undefined) {
						body.paymentMetadata = readMetadata(this, options.paymentMetadata, itemIndex);
					}
					envelope = await yolfiApiRequest.call(this, 'POST', '/private/paylinks/create', body);
				} else if (resource === 'paymentLink' && operation === 'get') {
					const id = requiredString(this, 'paymentLinkId', itemIndex);
					envelope = await yolfiApiRequest.call(
						this,
						'GET',
						`/private/paylinks/${encodeURIComponent(id)}`,
					);
				} else if (resource === 'paymentLink' && operation === 'disable') {
					const id = requiredString(this, 'paymentLinkId', itemIndex);
					envelope = await yolfiApiRequest.call(this, 'POST', '/private/paylinks/disable', { id });
				} else if (resource === 'customer' && operation === 'get') {
					const id = requiredString(this, 'customerId', itemIndex);
					envelope = await yolfiApiRequest.call(
						this,
						'GET',
						`/private/customers/${encodeURIComponent(id)}`,
					);
				} else if (resource === 'subscription' && operation === 'get') {
					const id = requiredString(this, 'subscriptionId', itemIndex);
					envelope = await yolfiApiRequest.call(
						this,
						'GET',
						`/subscriptions/${encodeURIComponent(id)}`,
					);
				} else {
					throw new NodeOperationError(this.getNode(), 'Unsupported Yolfi resource or operation', {
						itemIndex,
					});
				}
				const data = responseObject(this, envelope, itemIndex);
				output.push({
					json:
						resource === 'paymentLink'
							? withCheckoutUrl(this, data, itemIndex)
							: resource === 'subscription'
								? subscriptionOutput(data)
								: data,
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					output.push({
						json: { error: error instanceof Error ? error.message : 'Yolfi operation failed' },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				if (error instanceof NodeApiError) {
					throw new NodeApiError(
						this.getNode(),
						{},
						{
							message: error.message,
							description: error.description ?? undefined,
							httpCode: error.httpCode ?? undefined,
							itemIndex,
						},
					);
				}
				throw new NodeOperationError(
					this.getNode(),
					error instanceof Error ? error : new Error('Yolfi operation failed'),
					{
						itemIndex,
						description:
							error instanceof NodeOperationError ? (error.description ?? undefined) : undefined,
					},
				);
			}
		}
		return [output];
	}
}
