import type { IDataObject } from 'n8n-workflow';

const paymentLinkFields = [
	'id',
	'name',
	'description',
	'imageUrl',
	'type',
	'price',
	'currency',
	'collectEmail',
	'collectName',
	'collectDateOfBirth',
	'collectAddress',
	'collectPhoneNumber',
	'trialPeriod',
	'recurringInterval',
	'recurringIntervalCount',
	'metadata',
	'paymentMetadata',
	'enabled',
	'createdAt',
	'updatedAt',
	'payments',
	'collectedUsd',
	'lastPaymentAt',
];
const subscriptionFields = ['id', 'status', 'customerId', 'expiresAt', 'createdAt', 'updatedAt'];
const customerFields = [
	'id',
	'email',
	'name',
	'clientReferenceId',
	'phone',
	'metadata',
	'language',
	'createdAt',
	'updatedAt',
];
const invoiceFields = [
	'id',
	'paylinkId',
	'customerId',
	'subscriptionId',
	'chainId',
	'token',
	'network',
	'symbol',
	'requiredAmount',
	'amountReceived',
	'amountUsd',
	'feeAmount',
	'feeUsd',
	'networkFeeAmount',
	'networkFeeUsd',
	'feePayer',
	'feePercent',
	'status',
	'expiresAt',
	'createdAt',
	'updatedAt',
];

function selectFields(value: IDataObject, fields: string[]): IDataObject {
	return Object.fromEntries(
		fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]),
	);
}

function responseObject(value: unknown): IDataObject {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Yolfi returned an invalid subscription response');
	return value as IDataObject;
}

export function paymentLinkOutput(data: IDataObject): IDataObject {
	return selectFields(data, paymentLinkFields);
}

export function subscriptionOutput(data: IDataObject): IDataObject {
	// Keep a stable merchant-facing output, including for nested API relations.
	const output = selectFields(data, subscriptionFields);
	if (data.customer !== undefined)
		output.customer =
			data.customer === null ? null : selectFields(responseObject(data.customer), customerFields);
	if (data.invoices !== undefined) {
		if (!Array.isArray(data.invoices))
			throw new Error('Yolfi returned an invalid subscription response');
		output.invoices = data.invoices.map((value) => {
			const invoice = responseObject(value);
			const result = selectFields(invoice, invoiceFields);
			if (invoice.paylink !== undefined)
				result.paylink =
					invoice.paylink === null ? null : paymentLinkOutput(responseObject(invoice.paylink));
			return result;
		});
	}
	return output;
}
