import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IWebhookFunctions,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export const API_BASE_URL = 'https://app.yolfi.com/api';

function requestFailureCode(error: unknown): string | undefined {
	if (!error || typeof error !== 'object') return undefined;
	const failure = error as {
		httpCode?: unknown;
		statusCode?: unknown;
		status?: unknown;
		response?: { status?: unknown };
	};
	for (const candidate of [
		failure.httpCode,
		failure.statusCode,
		failure.status,
		failure.response?.status,
	]) {
		if (
			(typeof candidate === 'number' || typeof candidate === 'string') &&
			/^[345]\d{2}$/.test(String(candidate))
		)
			return String(candidate);
	}
	return undefined;
}

function requestFailureDescription(httpCode?: string): string {
	if (httpCode === '401' || httpCode === '403')
		return 'Check the API key and its organization access';
	if (httpCode === '404') return 'The requested Yolfi resource was not found';
	if (httpCode === '409')
		return 'The request conflicts with existing data. Reuse an idempotency key only for the same checkout request.';
	if (httpCode === '429') return 'Yolfi is rate limiting requests. Wait before retrying.';
	if (httpCode?.startsWith('5'))
		return 'Yolfi could not complete the request. Check its status before retrying a create operation.';
	if (httpCode?.startsWith('4')) return 'Check the request parameters and organization access';
	if (httpCode?.startsWith('3'))
		return 'Yolfi returned a redirect. Authenticated redirects are disabled.';
	return 'Could not complete the Yolfi request. Check connectivity and the operation status before retrying.';
}

export async function yolfiApiRequest(
	this: IExecuteFunctions | IHookFunctions | IWebhookFunctions,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
	headers?: IDataObject,
): Promise<IDataObject> {
	// All callers supply fixed relative routes; credentials must never follow an arbitrary URL.
	if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
		throw new NodeApiError(this.getNode(), {}, { message: 'Invalid Yolfi API route' });
	}
	let response: unknown;
	try {
		response = await this.helpers.httpRequestWithAuthentication.call(this, 'yolfiApi', {
			method,
			url: `${API_BASE_URL}${path}`,
			body,
			qs,
			headers,
			json: true,
			timeout: 30000,
			disableFollowRedirect: true,
		});
	} catch (error) {
		// HTTP errors may carry request headers, customer data and server diagnostics.
		// Retain only a validated status code, never the original error or response.
		const httpCode = requestFailureCode(error);
		throw new NodeApiError(
			this.getNode(),
			{},
			{
				message: 'Yolfi API request failed',
				description: requestFailureDescription(httpCode),
				httpCode,
			},
		);
	}
	if (!response || typeof response !== 'object' || Array.isArray(response)) {
		throw new NodeApiError(
			this.getNode(),
			{},
			{ message: 'Yolfi returned an invalid API response' },
		);
	}
	const envelope = response as IDataObject;
	if (envelope.success !== true) {
		const code = envelope.code;
		const errorCode =
			typeof code === 'number' && Number.isSafeInteger(code) && code > 0 ? ` (code ${code})` : '';
		throw new NodeApiError(
			this.getNode(),
			{},
			{
				message: 'Yolfi API request failed',
				description: `Yolfi did not confirm success${errorCode}. Check the request parameters and organization access.`,
			},
		);
	}
	return envelope;
}
