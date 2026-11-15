import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes } from 'n8n-workflow';
import { yolfiApiRequest, yolfiApiTest } from '../Yolfi/GenericFunctions';

const WEBHOOK_PATH = '/private/organization/webhook-endpoints';
type TriggerContext = IHookFunctions | IWebhookFunctions;

function getEndpointState(context: TriggerContext): IDataObject {
	const data = context.getWorkflowStaticData('node');
	// n8n supplies an isolated static-data object for test registrations and their
	// callbacks. Cleanup runs in "internal" mode even for test webhooks, so execution
	// mode must not be used to choose between live and test endpoint state.
	if (
		!data.yolfiEndpoint ||
		typeof data.yolfiEndpoint !== 'object' ||
		Array.isArray(data.yolfiEndpoint)
	) {
		data.yolfiEndpoint = {};
	}
	return data.yolfiEndpoint as IDataObject;
}

function clearEndpointState(state: IDataObject): void {
	delete state.id;
	delete state.name;
	delete state.url;
	delete state.signingSecret;
}

function endpointName(context: IHookFunctions, mode: 'test' | 'production'): string {
	return `n8n:${context.getWorkflow().id}:${context.getNode().id}:${mode}`.slice(0, 255);
}

function ownsEndpoint(context: IHookFunctions, state: IDataObject, endpoint: IDataObject): boolean {
	// Workflow exports can include static data. A copied ID alone is not ownership,
	// including when another n8n instance restores the same workflow and node IDs.
	return (
		(endpoint.name === endpointName(context, 'test') ||
			endpoint.name === endpointName(context, 'production')) &&
		(state.name === undefined || state.name === endpoint.name) &&
		endpoint.url === state.url &&
		endpoint.url === context.getNodeWebhookUrl('default') &&
		endpoint.adapter === 'NONE'
	);
}

export function verifyYolfiSignature(
	rawBody: unknown,
	signature: unknown,
	secret: unknown,
): boolean {
	if (
		(!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') ||
		typeof signature !== 'string' ||
		typeof secret !== 'string' ||
		!secret
	)
		return false;
	// Require a canonical SHA-256 Base64 signature, rather than accepting partially decoded data.
	if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
	const actual = Buffer.from(signature, 'base64');
	const expected = createHmac('sha256', secret).update(rawBody).digest();
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class YolfiTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Yolfi Trigger',
		name: 'yolfiTrigger',
		icon: { light: 'file:../Yolfi/yolfi.svg', dark: 'file:../Yolfi/yolfi.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Start a workflow on a signed Yolfi payment or subscription event',
		defaults: { name: 'Yolfi Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'yolfiApi', required: true, testedBy: 'yolfiApiTest' }],
		webhooks: [
			{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' },
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['payment.confirmed'],
				options: [
					{
						name: 'Invoice Created',
						value: 'invoice.created',
						description: 'A payment invoice was created after a buyer selected a payment method',
					},
					{
						name: 'Invoice Overdue',
						value: 'invoice.overdue',
						description: 'A payment invoice expired without full payment',
					},
					{
						name: 'Payment Confirmed',
						value: 'payment.confirmed',
						description: 'A payment was confirmed by Yolfi',
					},
					{
						name: 'Subscription Cancelled',
						value: 'subscription.cancelled',
						description: 'A subscription was cancelled',
					},
					{
						name: 'Subscription Overdue',
						value: 'subscription.overdue',
						description: 'A subscription renewal became overdue',
					},
				],
			},
			{
				displayName: 'Include Test Events',
				name: 'includeTestEvents',
				type: 'boolean',
				default: false,
				description: 'Whether to include signed test events sent from the Yolfi dashboard',
			},
			{
				displayName:
					'Yolfi creates a separate webhook endpoint for this trigger. Use a publicly reachable HTTPS n8n URL. Deliveries can repeat; deduplicate by the signed event ID before fulfillment.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
		],
	};

	methods = { credentialTest: { yolfiApiTest } };

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const state = getEndpointState(this);
				if (typeof state.id !== 'string') return false;
				const response = await yolfiApiRequest.call(this, 'GET', WEBHOOK_PATH);
				if (!Array.isArray(response.data))
					throw new NodeApiError(
						this.getNode(),
						{},
						{ message: 'Yolfi returned an invalid webhook list' },
					);
				const endpoint = (response.data as IDataObject[]).find((item) => item.id === state.id);
				if (!endpoint || !ownsEndpoint(this, state, endpoint)) {
					clearEndpointState(state);
					return false;
				}
				if (endpoint.enabled !== true || !state.signingSecret) {
					// Only replace an endpoint bound to this trigger and callback URL.
					await yolfiApiRequest.call(
						this,
						'DELETE',
						`${WEBHOOK_PATH}/${encodeURIComponent(state.id)}`,
					);
					clearEndpointState(state);
					return false;
				}
				return true;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const url = this.getNodeWebhookUrl('default');
				if (!url || !url.startsWith('https://'))
					throw new NodeApiError(
						this.getNode(),
						{},
						{ message: 'Configure a public HTTPS webhook URL for your n8n instance' },
					);
				const state = getEndpointState(this);
				const mode = this.getMode() === 'manual' ? 'test' : 'production';
				const name = endpointName(this, mode);
				// The API can create an endpoint even when its response is lost. Recover
				// only this trigger's exact identity before creating another endpoint.
				const existingResponse = await yolfiApiRequest.call(this, 'GET', WEBHOOK_PATH);
				if (!Array.isArray(existingResponse.data)) {
					throw new NodeApiError(
						this.getNode(),
						{},
						{ message: 'Yolfi returned an invalid webhook list' },
					);
				}
				const matches = (existingResponse.data as IDataObject[]).filter(
					(item) => item && item.name === name && item.url === url && item.adapter === 'NONE',
				);
				if (matches.length > 1) {
					throw new NodeApiError(
						this.getNode(),
						{},
						{
							message: 'Multiple Yolfi webhooks match this trigger',
							description: `Open Yolfi Settings > Webhooks and keep exactly one native endpoint named ${name} with URL ${url}, then retry activation`,
						},
					);
				}
				let endpoint: IDataObject | undefined;
				if (matches.length === 1) {
					const existing = matches[0];
					if (typeof existing.id !== 'string' || !existing.id) {
						throw new NodeApiError(
							this.getNode(),
							{},
							{ message: 'Yolfi returned a webhook without an ID' },
						);
					}
					// Secrets are only returned on creation or rotation. Repeating rotation
					// safely recovers even when a previous rotation response was lost.
					const rotated = await yolfiApiRequest.call(
						this,
						'POST',
						`${WEBHOOK_PATH}/${encodeURIComponent(existing.id)}/rotate-secret`,
					);
					const secret = (rotated.data as IDataObject | undefined)?.signingSecret;
					if (typeof secret !== 'string' || !secret) {
						throw new NodeApiError(
							this.getNode(),
							{},
							{ message: 'Yolfi did not return a webhook signing secret' },
						);
					}
					if (existing.enabled !== true) {
						await yolfiApiRequest.call(
							this,
							'PUT',
							`${WEBHOOK_PATH}/${encodeURIComponent(existing.id)}`,
							{
								enabled: true,
							},
						);
					}
					endpoint = { id: existing.id, signingSecret: secret };
				} else {
					const response = await yolfiApiRequest.call(this, 'POST', WEBHOOK_PATH, {
						name,
						url,
						adapter: 'NONE',
						enabled: true,
					});
					endpoint = response.data as IDataObject | undefined;
				}
				if (
					typeof endpoint?.id !== 'string' ||
					typeof endpoint.signingSecret !== 'string' ||
					!endpoint.signingSecret
				)
					throw new NodeApiError(
						this.getNode(),
						{},
						{ message: 'Yolfi did not return a webhook ID and signing secret' },
					);
				state.id = endpoint.id;
				state.name = name;
				state.url = url;
				state.signingSecret = endpoint.signingSecret;
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				const state = getEndpointState(this);
				if (typeof state.id !== 'string') return true;
				// Listing distinguishes an already removed endpoint from an authentication/transport error.
				const response = await yolfiApiRequest.call(this, 'GET', WEBHOOK_PATH);
				if (!Array.isArray(response.data))
					throw new NodeApiError(
						this.getNode(),
						{},
						{ message: 'Yolfi returned an invalid webhook list' },
					);
				const endpoint = (response.data as IDataObject[]).find((item) => item.id === state.id);
				if (endpoint && ownsEndpoint(this, state, endpoint)) {
					await yolfiApiRequest.call(
						this,
						'DELETE',
						`${WEBHOOK_PATH}/${encodeURIComponent(state.id)}`,
					);
				}
				clearEndpointState(state);
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const request = this.getRequestObject();
		const state = getEndpointState(this);
		const signature = request.headers['x-yolfi-signature'];
		const rawBody: unknown = request.rawBody;
		if (!verifyYolfiSignature(rawBody, signature, state.signingSecret)) {
			this.getResponseObject().status(401).send('Invalid Yolfi signature');
			return { noWebhookResponse: true };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(
				Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : (rawBody as string),
			);
		} catch {
			this.getResponseObject().status(400).send('Invalid Yolfi event');
			return { noWebhookResponse: true };
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			this.getResponseObject().status(400).send('Invalid Yolfi event');
			return { noWebhookResponse: true };
		}
		const event = parsed as IDataObject;
		if (
			typeof event.id !== 'string' ||
			!event.id ||
			typeof event.type !== 'string' ||
			typeof event.livemode !== 'boolean' ||
			!event.data ||
			typeof event.data !== 'object' ||
			Array.isArray(event.data)
		) {
			this.getResponseObject().status(400).send('Invalid Yolfi event');
			return { noWebhookResponse: true };
		}
		const headerId = request.headers['x-yolfi-event-id'];
		if (headerId !== undefined && headerId !== event.id) {
			this.getResponseObject().status(400).send('Yolfi event ID does not match the signed payload');
			return { noWebhookResponse: true };
		}
		const events = this.getNodeParameter('events', []) as string[];
		if (!events.includes(event.type as string)) return {};
		if (event.livemode === false && !this.getNodeParameter('includeTestEvents', false)) return {};
		return { workflowData: [this.helpers.returnJsonArray(event)] };
	}
}
