import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { yolfiApiRequest } from '../dist/nodes/Yolfi/GenericFunctions.js';
import { YolfiApi } from '../dist/credentials/YolfiApi.credentials.js';
import { Yolfi } from '../dist/nodes/Yolfi/Yolfi.node.js';
import { YolfiTrigger } from '../dist/nodes/YolfiTrigger/YolfiTrigger.node.js';

function context(response) {
	const calls = [];
	return {
		calls,
		getNode: () => ({
			name: 'Yolfi',
			type: 'n8n-nodes-yolfi.yolfi',
			typeVersion: 1,
			parameters: {},
			position: [0, 0],
		}),
		helpers: {
			async httpRequestWithAuthentication(name, options) {
				calls.push({ name, options });
				return response;
			},
		},
	};
}

test('authenticates on the fixed HTTPS API with bounded timeout and no redirects', async () => {
	const ctx = context({ success: true, data: { id: 'fixture' } });
	assert.deepEqual(await yolfiApiRequest.call(ctx, 'GET', '/checkout-sessions/fixture'), {
		success: true,
		data: { id: 'fixture' },
	});
	assert.equal(ctx.calls[0].name, 'yolfiApi');
	assert.equal(ctx.calls[0].options.url, 'https://app.yolfi.com/api/checkout-sessions/fixture');
	assert.equal(ctx.calls[0].options.disableFollowRedirect, true);
	assert.equal(ctx.calls[0].options.timeout, 30000);
});

test('rejects HTTP-200 domain failures and malformed responses', async () => {
	for (const response of [
		{ success: false, message: 'be-error-no-organization' },
		{},
		null,
		'<html>login</html>',
		[],
	]) {
		await assert.rejects(() =>
			yolfiApiRequest.call(context(response), 'GET', '/private/organization/current'),
		);
	}
});

test('never sends an API credential to a caller-supplied absolute URL', async () => {
	for (const path of ['https://evil.example', '//evil.example', '/https://evil.example']) {
		const ctx = context({ success: true });
		await assert.rejects(() => yolfiApiRequest.call(ctx, 'GET', path));
		assert.equal(ctx.calls.length, 0);
	}
});

test('HTTP failures retain useful status codes without retaining credentials or response details', async () => {
	for (const status of [302, 400, 401, 403, 404, 409, 429, 500, undefined]) {
		const failure = Object.assign(new Error('fixture-private-error-message'), {
			statusCode: status,
			config: { headers: { Authorization: 'Bearer fixture-private-api-key' } },
			request: { body: { customerEmail: 'fixture-private-buyer@example.com' } },
			response: {
				data: { message: 'fixture-private-server-message', stack: 'fixture-private-stack' },
			},
		});
		for (const error of [failure, { ...failure, message: failure.message }]) {
			const ctx = context();
			ctx.helpers.httpRequestWithAuthentication = async () => {
				throw error;
			};
			await assert.rejects(
				() => yolfiApiRequest.call(ctx, 'GET', '/private/organization/webhook-endpoints'),
				(result) => {
					assert.match(result.message, /Yolfi API request failed/);
					assert.equal(result.httpCode, status === undefined ? null : String(status));
					assert.doesNotMatch(JSON.stringify(result), /fixture-private/);
					assert.doesNotMatch(inspect(result, { depth: 20 }), /fixture-private/);
					return true;
				},
			);
		}
	}
});

test('domain failures expose only a numeric support code and never raw server messages', async () => {
	for (const code of [11003, { privateDetails: 'fixture-private-code' }, 'fixture-private-code']) {
		await assert.rejects(
			() =>
				yolfiApiRequest.call(
					context({
						success: false,
						code,
						message: 'fixture-private-server-message',
						data: { customerEmail: 'fixture-private-buyer@example.com' },
					}),
					'GET',
					'/private/customers/missing',
				),
			(result) => {
				assert.doesNotMatch(inspect(result, { depth: 20 }), /fixture-private/);
				if (code === 11003) assert.match(result.description, /11003/);
				return true;
			},
		);
	}
});

test('both nodes use the standard password-protected credential and a bounded read-only test', () => {
	const credential = new YolfiApi();
	assert.equal(
		credential.properties.find((item) => item.name === 'apiKey').typeOptions.password,
		true,
	);
	assert.equal(
		credential.authenticate.properties.headers.Authorization,
		'=Bearer {{$credentials.apiKey}}',
	);
	assert.equal(credential.test.request.baseURL, 'https://app.yolfi.com/api');
	assert.equal(credential.test.request.url, '/private/organization/current');
	assert.equal(credential.test.request.method, 'GET');
	assert.equal(credential.test.request.json, true);
	assert.equal(credential.test.request.timeout, 30000);
	assert.equal(credential.test.request.disableFollowRedirect, true);
	assert.ok(
		credential.test.rules.some(
			(rule) =>
				rule.type === 'responseSuccessBody' &&
				rule.properties.key === 'success' &&
				rule.properties.value === false,
		),
	);
	for (const node of [new Yolfi(), new YolfiTrigger()]) {
		assert.deepEqual(node.description.credentials, [{ name: 'yolfiApi', required: true }]);
	}
});
