import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
	YolfiTrigger,
	verifyYolfiSignature,
} from '../dist/nodes/YolfiTrigger/YolfiTrigger.node.js';

const secret = 'fixture-endpoint-secret';
const endpointId = '11111111-1111-4111-8111-111111111111';
const url = 'https://automation.example.com/webhook/workflow-yolfi';
const endpoint = {
	id: endpointId,
	name: 'n8n:workflow-1:node-1:production',
	url,
	adapter: 'NONE',
	enabled: true,
};
const event = {
	id: 'evt_fixture',
	type: 'payment.confirmed',
	created: 1700000000,
	livemode: true,
	data: { amount: '12.34', merchantOrderId: 'order-123' },
};
const signature = (raw, key = secret) => createHmac('sha256', key).update(raw).digest('base64');

function context({
	raw = JSON.stringify(event),
	mode = 'webhook',
	includeTestEvents = false,
	events = ['payment.confirmed'],
	workflowId = 'workflow-1',
	nodeId = 'node-1',
	webhookUrl = url,
	state,
	response,
	request,
} = {}) {
	const staticData = state ?? {
		yolfiEndpoint: { id: endpointId, name: endpoint.name, url, signingSecret: secret },
	};
	const requests = [];
	const httpResponse = {
		statusCode: null,
		body: null,
		status(code) {
			this.statusCode = code;
			return this;
		},
		send(body) {
			this.body = body;
			return this;
		},
	};
	return {
		staticData,
		requests,
		httpResponse,
		getMode: () => mode,
		getNode: () => ({
			id: nodeId,
			name: 'Yolfi Trigger',
			type: 'n8n-nodes-yolfi.yolfiTrigger',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		getWorkflow: () => ({ id: workflowId }),
		getWorkflowStaticData: () => staticData,
		getNodeWebhookUrl: () => webhookUrl,
		getNodeParameter: (name) => (name === 'events' ? events : includeTestEvents),
		getRequestObject: () =>
			request ?? {
				rawBody: raw,
				headers: { 'x-yolfi-signature': signature(raw), 'x-yolfi-event-id': event.id },
			},
		getResponseObject: () => httpResponse,
		helpers: {
			returnJsonArray: (item) => [{ json: item }],
			async httpRequestWithAuthentication(credential, options) {
				requests.push({ credential, ...options });
				if (typeof response === 'function') return response(options);
				return response;
			},
		},
	};
}

test('verifies exact raw bytes, including whitespace and non-ASCII text', () => {
	const raw = '{ "description": "Оплата ฿", "amount": "12.34" }';
	assert.equal(verifyYolfiSignature(Buffer.from(raw), signature(raw), secret), true);
	assert.equal(
		verifyYolfiSignature(JSON.stringify(JSON.parse(raw)), signature(raw), secret),
		false,
	);
	assert.equal(verifyYolfiSignature(raw, signature(raw, 'wrong-secret'), secret), false);
	for (const bad of [undefined, '', 'bad', `${signature(raw)}junk`, [signature(raw)]])
		assert.equal(verifyYolfiSignature(raw, bad, secret), false);
	assert.equal(verifyYolfiSignature({ parsed: true }, signature(raw), secret), false);
	assert.equal(verifyYolfiSignature(raw, signature(raw), ''), false);
});

test('emits a valid selected event without exposing endpoint secrets', async () => {
	const ctx = context();
	const result = await new YolfiTrigger().webhook.call(ctx);
	assert.deepEqual(result.workflowData, [[{ json: event }]]);
	assert.equal(JSON.stringify(result).includes(secret), false);
});

test('fails closed on tampered body, missing raw body, missing secret or wrong event ID', async () => {
	const raw = JSON.stringify(event);
	const cases = [
		{ rawBody: `${raw} `, headers: { 'x-yolfi-signature': signature(raw) } },
		{ body: event, headers: { 'x-yolfi-signature': signature(raw) } },
		{
			rawBody: raw,
			headers: { 'x-yolfi-signature': signature(raw), 'x-yolfi-event-id': 'different' },
		},
	];
	for (const request of cases) {
		const ctx = context({ request });
		assert.equal((await new YolfiTrigger().webhook.call(ctx)).noWebhookResponse, true);
		assert.ok([400, 401].includes(ctx.httpResponse.statusCode));
	}
	const ctx = context({ state: {} });
	assert.equal((await new YolfiTrigger().webhook.call(ctx)).noWebhookResponse, true);
	assert.equal(ctx.httpResponse.statusCode, 401);
});

test('does not start workflows for unselected events or test events by default', async () => {
	const ctx = context({ events: ['subscription.cancelled'] });
	assert.deepEqual(await new YolfiTrigger().webhook.call(ctx), {});
	const raw = JSON.stringify({ ...event, livemode: false });
	assert.deepEqual(await new YolfiTrigger().webhook.call(context({ raw })), {});
	assert.ok(
		(await new YolfiTrigger().webhook.call(context({ raw, includeTestEvents: true }))).workflowData,
	);
});

test('rejects signed invalid JSON and invalid envelopes', async () => {
	for (const raw of [
		'{',
		'null',
		'[]',
		JSON.stringify({ ...event, id: '' }),
		JSON.stringify({ ...event, data: null }),
	]) {
		const ctx = context({ raw });
		assert.equal((await new YolfiTrigger().webhook.call(ctx)).noWebhookResponse, true);
		assert.equal(ctx.httpResponse.statusCode, 400);
	}
});

test('manual registration and internal cleanup use isolated test state without changing a live endpoint', async () => {
	const liveState = {
		yolfiEndpoint: {
			id: 'production-id',
			url: 'https://automation.example.com/webhook/live',
			signingSecret: 'production-secret',
		},
	};
	const testState = {};
	const register = context({
		mode: 'manual',
		state: testState,
		response: (request) =>
			request.method === 'GET'
				? { success: true, data: [] }
				: { success: true, data: { id: endpointId, signingSecret: secret } },
	});
	const trigger = new YolfiTrigger();
	assert.equal(await trigger.webhookMethods.default.create.call(register), true);
	assert.equal(register.requests[1].body.adapter, 'NONE');
	assert.equal(register.requests[1].body.url, url);
	assert.equal(testState.yolfiEndpoint.signingSecret, secret);
	assert.equal(register.requests[0].credential, 'yolfiApi');
	const cleanup = context({
		mode: 'internal',
		state: testState,
		response: (req) =>
			req.method === 'GET'
				? {
						success: true,
						data: [
							{ ...endpoint, name: 'n8n:workflow-1:node-1:test' },
							{ ...endpoint, id: 'production-id' },
						],
					}
				: { success: true },
	});
	assert.equal(await trigger.webhookMethods.default.delete.call(cleanup), true);
	assert.deepEqual(
		cleanup.requests.map((req) => req.method),
		['GET', 'DELETE'],
	);
	assert.ok(cleanup.requests[1].url.endsWith(endpointId));
	assert.deepEqual(testState.yolfiEndpoint, {});
	assert.deepEqual(liveState.yolfiEndpoint, {
		id: 'production-id',
		url: 'https://automation.example.com/webhook/live',
		signingSecret: 'production-secret',
	});
});

test('recovers an endpoint after a lost create response without creating a duplicate', async () => {
	const remote = [];
	const state = {};
	let creations = 0;
	const ctx = context({
		state,
		response: (request) => {
			if (request.method === 'GET') return { success: true, data: remote };
			if (request.url.endsWith('/rotate-secret')) {
				return { success: true, data: { signingSecret: 'recovered-secret' } };
			}
			creations++;
			remote.push({ id: endpointId, ...request.body });
			throw new Error('Fixture response lost after endpoint creation');
		},
	});
	const trigger = new YolfiTrigger();
	await assert.rejects(() => trigger.webhookMethods.default.create.call(ctx));
	assert.equal(await trigger.webhookMethods.default.checkExists.call(ctx), false);
	assert.equal(await trigger.webhookMethods.default.create.call(ctx), true);
	assert.equal(creations, 1);
	assert.equal(remote.length, 1);
	assert.equal(state.yolfiEndpoint.id, endpointId);
	assert.equal(state.yolfiEndpoint.signingSecret, 'recovered-secret');
	assert.deepEqual(
		ctx.requests.map((request) => request.method),
		['GET', 'POST', 'GET', 'POST'],
	);
	assert.ok(ctx.requests[3].url.endsWith(`${endpointId}/rotate-secret`));
});

test('retries secret rotation on the same endpoint after a lost rotation response', async () => {
	const endpoint = {
		id: endpointId,
		name: 'n8n:workflow-1:node-1:production',
		url,
		adapter: 'NONE',
		enabled: true,
	};
	let rotations = 0;
	const ctx = context({
		state: {},
		response: (request) => {
			if (request.method === 'GET') return { success: true, data: [endpoint] };
			assert.ok(request.url.endsWith(`${endpointId}/rotate-secret`));
			rotations++;
			if (rotations === 1) throw new Error('Fixture rotation response lost');
			return { success: true, data: { signingSecret: 'second-rotation-secret' } };
		},
	});
	const trigger = new YolfiTrigger();
	await assert.rejects(() => trigger.webhookMethods.default.create.call(ctx));
	assert.equal(await trigger.webhookMethods.default.create.call(ctx), true);
	assert.equal(rotations, 2);
	assert.equal(ctx.staticData.yolfiEndpoint.signingSecret, 'second-rotation-secret');
	assert.equal(
		ctx.requests.filter(
			(request) => request.method === 'POST' && !request.url.endsWith('/rotate-secret'),
		).length,
		0,
	);
});

test('recovers and enables a disabled exact-match endpoint before persisting its secret', async () => {
	const endpoint = {
		id: endpointId,
		name: 'n8n:workflow-1:node-1:production',
		url,
		adapter: 'NONE',
		enabled: false,
	};
	const ctx = context({
		state: {},
		response: (request) => {
			if (request.method === 'GET') return { success: true, data: [endpoint] };
			if (request.url.endsWith('/rotate-secret'))
				return { success: true, data: { signingSecret: secret } };
			assert.equal(request.method, 'PUT');
			assert.deepEqual(request.body, { enabled: true });
			return { success: true, data: { ...endpoint, enabled: true } };
		},
	});
	assert.equal(await new YolfiTrigger().webhookMethods.default.create.call(ctx), true);
	assert.deepEqual(
		ctx.requests.map((request) => request.method),
		['GET', 'POST', 'PUT'],
	);
	assert.equal(ctx.staticData.yolfiEndpoint.id, endpointId);
	assert.equal(ctx.staticData.yolfiEndpoint.signingSecret, secret);
});

test('stops on duplicate exact matches without rotating or deleting either endpoint', async () => {
	const endpoint = {
		id: endpointId,
		name: 'n8n:workflow-1:node-1:production',
		url,
		adapter: 'NONE',
		enabled: true,
	};
	const ctx = context({
		state: {},
		response: { success: true, data: [endpoint, { ...endpoint, id: 'second-endpoint' }] },
	});
	await assert.rejects(
		() => new YolfiTrigger().webhookMethods.default.create.call(ctx),
		(error) => {
			assert.match(error.message, /Multiple Yolfi webhooks match this trigger/);
			assert.match(error.description, /keep exactly one native endpoint/);
			return true;
		},
	);
	assert.deepEqual(
		ctx.requests.map((request) => request.method),
		['GET'],
	);
	assert.deepEqual(ctx.staticData.yolfiEndpoint, {});
});

test('never recovers an endpoint based on a shared URL, name, or adapter alone', async () => {
	const endpoint = {
		id: endpointId,
		name: 'n8n:workflow-1:node-1:production',
		url,
		adapter: 'NONE',
		enabled: true,
	};
	const unrelated = [
		{ ...endpoint, name: 'n8n:another-workflow:node-1:production' },
		{ ...endpoint, url: 'https://automation.example.com/webhook/another' },
		{ ...endpoint, adapter: 'STRIPE' },
	];
	const ctx = context({
		state: {},
		response: (request) =>
			request.method === 'GET'
				? { success: true, data: unrelated }
				: { success: true, data: { id: 'new-endpoint', signingSecret: secret } },
	});
	assert.equal(await new YolfiTrigger().webhookMethods.default.create.call(ctx), true);
	assert.deepEqual(
		ctx.requests.map((request) => request.method),
		['GET', 'POST'],
	);
	assert.ok(ctx.requests[1].url.endsWith('/webhook-endpoints'));
	assert.equal(ctx.staticData.yolfiEndpoint.id, 'new-endpoint');
});

test('only considers its own enabled native endpoint reusable', async () => {
	const endpoints = [endpoint];
	const ctx = context({ response: { success: true, data: endpoints } });
	assert.equal(await new YolfiTrigger().webhookMethods.default.checkExists.call(ctx), true);
	const legacy = context({
		state: { yolfiEndpoint: { id: endpointId, url, signingSecret: secret } },
		response: { success: true, data: endpoints },
	});
	assert.equal(await new YolfiTrigger().webhookMethods.default.checkExists.call(legacy), true);
	const missing = context({
		response: { success: true, data: [{ ...endpoints[0], id: 'unrelated' }] },
	});
	assert.equal(await new YolfiTrigger().webhookMethods.default.checkExists.call(missing), false);
	assert.equal(missing.requests.length, 1);
});

test('does not reuse another endpoint when signing secret is lost', async () => {
	const state = { yolfiEndpoint: { id: endpointId, url } };
	const ctx = context({
		state,
		response: (req) =>
			req.method === 'GET'
				? {
						success: true,
						data: [endpoint, { id: 'unrelated', url }],
					}
				: { success: true },
	});
	assert.equal(await new YolfiTrigger().webhookMethods.default.checkExists.call(ctx), false);
	assert.equal(ctx.requests[1].method, 'DELETE');
	assert.ok(ctx.requests[1].url.endsWith(endpointId));
	assert.deepEqual(state.yolfiEndpoint, {});
});

test('deactivation deletes only the endpoint owned by this trigger', async () => {
	const ctx = context({
		response: (req) =>
			req.method === 'GET'
				? { success: true, data: [endpoint, { ...endpoint, id: 'other-endpoint' }] }
				: { success: true },
	});
	assert.equal(await new YolfiTrigger().webhookMethods.default.delete.call(ctx), true);
	assert.deepEqual(
		ctx.requests.map((req) => req.method),
		['GET', 'DELETE'],
	);
	assert.ok(ctx.requests[1].url.endsWith(endpointId));
	assert.deepEqual(ctx.staticData.yolfiEndpoint, {});
});

test('copied static data cannot reuse or delete the original workflow endpoint', async () => {
	const trigger = new YolfiTrigger();
	for (const overrides of [
		{ workflowId: 'imported-workflow' },
		{ nodeId: 'copied-node' },
		{ webhookUrl: 'https://another-instance.example.com/webhook/workflow-yolfi' },
	]) {
		for (const operation of ['checkExists', 'delete']) {
			const remote = [{ ...endpoint }];
			const ctx = context({
				...overrides,
				response: (request) => {
					if (request.method === 'GET') return { success: true, data: remote };
					assert.equal(request.method, 'POST');
					assert.ok(request.url.endsWith('/webhook-endpoints'));
					const created = { id: 'copy-endpoint', ...request.body };
					remote.push(created);
					return { success: true, data: { ...created, signingSecret: 'copy-secret' } };
				},
			});
			assert.equal(
				await trigger.webhookMethods.default[operation].call(ctx),
				operation === 'delete',
			);
			assert.deepEqual(ctx.staticData.yolfiEndpoint, {});
			assert.deepEqual(
				ctx.requests.map((request) => request.method),
				['GET'],
			);
			assert.equal(await trigger.webhookMethods.default.create.call(ctx), true);
			assert.equal(remote.length, 2);
			assert.deepEqual(remote[0], endpoint);
			assert.equal(ctx.staticData.yolfiEndpoint.id, 'copy-endpoint');
		}
	}
});

test('changed remote ownership is detached without deleting the endpoint', async () => {
	for (const changed of [
		{ name: 'manually-managed' },
		{ url: 'https://automation.example.com/webhook/another' },
		{ adapter: 'STRIPE' },
	]) {
		for (const operation of ['checkExists', 'delete']) {
			const ctx = context({ response: { success: true, data: [{ ...endpoint, ...changed }] } });
			assert.equal(
				await new YolfiTrigger().webhookMethods.default[operation].call(ctx),
				operation === 'delete',
			);
			assert.deepEqual(
				ctx.requests.map((request) => request.method),
				['GET'],
			);
			assert.deepEqual(ctx.staticData.yolfiEndpoint, {});
		}
	}
});

test('API failures preserve endpoint state for a retry, rather than orphaning the webhook', async () => {
	const ctx = context({ response: { success: false, message: 'access-denied' } });
	await assert.rejects(() => new YolfiTrigger().webhookMethods.default.delete.call(ctx));
	assert.equal(ctx.staticData.yolfiEndpoint.id, endpointId);
});
