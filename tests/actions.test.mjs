import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Yolfi } from '../dist/nodes/Yolfi/Yolfi.node.js';

function context(parameters, response, { count = 1, continueOnFail = false } = {}) {
	const requests = [];
	return {
		requests,
		getNode: () => ({
			id: 'yolfi-action',
			name: 'Yolfi',
			type: 'n8n-nodes-yolfi.yolfi',
			typeVersion: 1,
			parameters: {},
			position: [0, 0],
		}),
		getInputData: () => Array.from({ length: count }, (_, index) => ({ json: { index } })),
		getNodeParameter(name, index, fallback) {
			const value = parameters[name];
			return value === undefined ? fallback : typeof value === 'function' ? value(index) : value;
		},
		continueOnFail: () => continueOnFail,
		helpers: {
			async httpRequestWithAuthentication(credential, options) {
				requests.push({ credential, ...options });
				return typeof response === 'function' ? response(options, requests.length) : response;
			},
		},
	};
}

const checkoutParameters = {
	resource: 'checkoutSession',
	operation: 'create',
	amount: '49.999999999999999999',
	currency: 'EUR',
	idempotencyKey: 'merchant-order-0001',
	checkoutOptions: {
		merchantOrderId: 'order-0001',
		customerEmail: 'buyer@example.com',
		customerName: 'Buyer',
		metadata: '{"invoice":"INV-1","quantity":2,"active":true}',
		successUrl: 'https://merchant.example/thanks',
		cancelUrl: 'https://merchant.example/cancel',
		expiresInMinutes: 60,
	},
};

test('creates checkout with precise string amounts, primitive metadata and a stable caller idempotency key', async () => {
	const ctx = context(checkoutParameters, {
		success: true,
		data: { id: 'ycs_fixture', url: 'https://pay.yolfi.com/ycs_fixture' },
	});
	const action = new Yolfi();
	for (let attempt = 0; attempt < 2; attempt++) {
		const [items] = await action.execute.call(ctx);
		assert.equal(items[0].json.url, 'https://pay.yolfi.com/ycs_fixture');
		assert.deepEqual(items[0].pairedItem, { item: 0 });
	}
	assert.equal(ctx.requests.length, 2);
	assert.equal(ctx.requests[0].credential, 'yolfiApi');
	assert.equal(ctx.requests[0].url, 'https://app.yolfi.com/api/checkout-sessions');
	assert.equal(ctx.requests[0].method, 'POST');
	assert.deepEqual(ctx.requests[0].headers, { 'Idempotency-Key': 'merchant-order-0001' });
	assert.deepEqual(ctx.requests[1].headers, ctx.requests[0].headers);
	assert.deepEqual(ctx.requests[1].body, ctx.requests[0].body);
	assert.equal(ctx.requests[0].body.amount, '49.999999999999999999');
	assert.deepEqual(ctx.requests[0].body.metadata, { invoice: 'INV-1', quantity: 2, active: true });
	assert.equal(ctx.requests[0].body.merchantOrderId, 'order-0001');
	assert.equal(ctx.requests[0].body.expiresInMinutes, 60);
	assert.equal(ctx.requests[0].body.paylinkId, undefined);
});

test('rejects invalid decimal amounts, unsupported currency, short keys and invalid expiry before any API request', async () => {
	const cases = [
		{ amount: '0' },
		{ amount: '0.001' },
		{ amount: '-1' },
		{ amount: '1e3' },
		{ amount: 0.5 },
		{ currency: 'GBP' },
		{ idempotencyKey: 'short' },
		{ idempotencyKey: 'x'.repeat(201) },
		{ checkoutOptions: { expiresInMinutes: 4 } },
		{ checkoutOptions: { expiresInMinutes: 1441 } },
		{ checkoutOptions: { expiresInMinutes: 5.5 } },
	];
	for (const overrides of cases) {
		const ctx = context({ ...checkoutParameters, ...overrides }, { success: true, data: {} });
		await assert.rejects(() => new Yolfi().execute.call(ctx));
		assert.equal(ctx.requests.length, 0);
	}
});

test('accepts the exact minimum price without converting it to a floating-point value', async () => {
	const ctx = context(
		{ ...checkoutParameters, amount: '0.0100' },
		{ success: true, data: { id: 'ycs_fixture' } },
	);
	await new Yolfi().execute.call(ctx);
	assert.equal(ctx.requests[0].body.amount, '0.0100');
});

test('rejects non-object, nested, unbounded, and non-finite metadata before creating payment resources', async () => {
	const cases = [
		'not-json',
		'null',
		'[]',
		'{"nested":{"value":1}}',
		'{"missing":null}',
		JSON.stringify({ 'invalid.key': 'value' }),
		JSON.stringify({ oversized: 'x'.repeat(501) }),
		JSON.stringify(
			Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`key${index}`, true])),
		),
		{ amount: Infinity },
	];
	for (const metadata of cases) {
		const ctx = context(
			{ ...checkoutParameters, checkoutOptions: { metadata } },
			{ success: true, data: {} },
		);
		await assert.rejects(() => new Yolfi().execute.call(ctx), /Metadata/);
		assert.equal(ctx.requests.length, 0);
	}
});

test('creates a one-time payment link with a usable checkout URL and payment event metadata', async () => {
	const ctx = context(
		{
			resource: 'paymentLink',
			operation: 'create',
			name: 'Consultation',
			price: '50.00',
			currency: 'USD',
			collectEmail: true,
			paymentLinkOptions: { collectName: true, paymentMetadata: '{"source":"n8n"}' },
		},
		{ success: true, data: { id: '11111111-1111-4111-8111-111111111111', enabled: true } },
	);
	const [[item]] = await new Yolfi().execute.call(ctx);
	assert.equal(ctx.requests[0].url, 'https://app.yolfi.com/api/private/paylinks/create');
	assert.deepEqual(ctx.requests[0].body, {
		name: 'Consultation',
		price: '50.00',
		currency: 'USD',
		type: 'ONE_TIME',
		collectEmail: true,
		collectName: true,
		paymentMetadata: { source: 'n8n' },
	});
	assert.equal(item.json.checkoutUrl, 'https://pay.yolfi.com/11111111-1111-4111-8111-111111111111');
	assert.equal(item.json.success, undefined);
});

test('limits payment links across pages without changing rows and shifting the offset', async () => {
	const ctx = context(
		{
			resource: 'paymentLink',
			operation: 'getMany',
			returnAll: false,
			limit: 150,
			paymentLinkListOptions: { filter: 'one-time' },
		},
		(request) => ({
			success: true,
			total: 250,
			data: Array.from({ length: 100 }, (_, index) => ({
				id: `link-${(request.qs.page - 1) * 100 + index}`,
			})),
		}),
	);
	const [items] = await new Yolfi().execute.call(ctx);
	assert.equal(items.length, 150);
	assert.deepEqual(
		ctx.requests.map(({ qs }) => qs),
		[
			{ filter: 'one-time', rows: 100, page: 1 },
			{ filter: 'one-time', rows: 100, page: 2 },
		],
	);
	assert.equal(items[149].json.id, 'link-149');
	assert.ok(items.every((item) => item.pairedItem.item === 0));
	assert.equal(new Set(items.map((item) => item.json.id)).size, 150);
});

test('returns all customers with the customer-specific pageSize parameter and supported search and sorting', async () => {
	const ctx = context(
		{
			resource: 'customer',
			operation: 'getMany',
			returnAll: true,
			customerListOptions: { search: 'buyer@example.com', sort: 'last-payment' },
		},
		(request) => ({
			success: true,
			total: 205,
			data: Array.from({ length: request.qs.page === 3 ? 5 : 100 }, (_, index) => ({
				id: `customer-${(request.qs.page - 1) * 100 + index}`,
			})),
		}),
	);
	const [items] = await new Yolfi().execute.call(ctx);
	assert.equal(items.length, 205);
	assert.equal(ctx.requests.length, 3);
	assert.ok(ctx.requests.every(({ qs }) => qs.pageSize === 100 && qs.rows === undefined));
	assert.ok(
		ctx.requests.every(({ qs }) => qs.sort === 'last-payment' && qs.search === 'buyer@example.com'),
	);
	assert.equal(items[204].json.id, 'customer-204');
});

test('returns no items for empty lists and detects repeated pages rather than looping', async () => {
	const parameters = { resource: 'customer', operation: 'getMany', returnAll: true };
	const empty = context(parameters, { success: true, data: [], total: 0 });
	assert.deepEqual(await new Yolfi().execute.call(empty), [[]]);
	const repeating = context(parameters, {
		success: true,
		total: 300,
		data: Array.from({ length: 100 }, (_, index) => ({ id: `customer-${index}` })),
	});
	await assert.rejects(() => new Yolfi().execute.call(repeating), /pagination did not advance/);
	assert.equal(repeating.requests.length, 2);
});

test('rejects invalid list controls and malformed API lists', async () => {
	for (const limit of [0, 1.5, 10001]) {
		const ctx = context(
			{ resource: 'paymentLink', operation: 'getMany', returnAll: false, limit },
			{ success: true, data: [], total: 0 },
		);
		await assert.rejects(() => new Yolfi().execute.call(ctx));
		assert.equal(ctx.requests.length, 0);
	}
	for (const data of [null, {}, ['not-an-object']]) {
		const ctx = context(
			{ resource: 'customer', operation: 'getMany', returnAll: true },
			{ success: true, data, total: 1 },
		);
		await assert.rejects(() => new Yolfi().execute.call(ctx), /unexpected list response/);
	}
});

test('encodes every resource ID as a single path segment and preserves resource-specific response shapes', async () => {
	const cases = [
		[
			'checkoutSession',
			'checkoutSessionId',
			'/checkout-sessions/',
			{ id: 'fixture', payment: { status: 'completed' } },
		],
		['paymentLink', 'paymentLinkId', '/private/paylinks/', { id: 'fixture' }],
		[
			'customer',
			'customerId',
			'/private/customers/',
			{ customer: { id: 'fixture' }, subscriptions: [], transactions: [] },
		],
		['subscription', 'subscriptionId', '/subscriptions/', { id: 'fixture', status: 'ACTIVE' }],
	];
	for (const [resource, key, path, data] of cases) {
		const ctx = context(
			{ resource, operation: 'get', [key]: 'id/with?special#characters' },
			{ success: true, data },
		);
		const [[item]] = await new Yolfi().execute.call(ctx);
		assert.equal(
			ctx.requests[0].url,
			`https://app.yolfi.com/api${path}id%2Fwith%3Fspecial%23characters`,
		);
		assert.equal(item.json.url, undefined);
		assert.deepEqual(item.pairedItem, { item: 0 });
		if (resource === 'customer') assert.deepEqual(item.json, data);
	}
});

test('disables exactly the requested payment link and returns its saved state', async () => {
	const ctx = context(
		{ resource: 'paymentLink', operation: 'disable', paymentLinkId: 'link-id' },
		{
			success: true,
			data: { id: 'link-id', enabled: false },
		},
	);
	const [[item]] = await new Yolfi().execute.call(ctx);
	assert.equal(ctx.requests[0].url, 'https://app.yolfi.com/api/private/paylinks/disable');
	assert.equal(ctx.requests[0].method, 'POST');
	assert.deepEqual(ctx.requests[0].body, { id: 'link-id' });
	assert.equal(item.json.enabled, false);
});

test('subscription output contains merchant records without unrelated API relations or fields', async () => {
	const expected = {
		id: 'subscription-fixture',
		status: 'ACTIVE',
		customerId: 'customer-fixture',
		expiresAt: '2026-12-01T00:00:00.000Z',
		customer: {
			id: 'customer-fixture',
			email: 'buyer@example.com',
			metadata: { reference: 'buyer-1' },
		},
		invoices: [
			{
				id: 'invoice-fixture',
				subscriptionId: 'subscription-fixture',
				status: 'completed',
				requiredAmount: '50000000',
				amountReceived: '50000000',
				symbol: 'USDC',
				network: 'ETHEREUM',
				paylink: {
					id: 'link-fixture',
					name: 'Membership',
					price: '50.00',
					currency: 'USD',
					paymentMetadata: { product: 'membership' },
				},
			},
		],
	};
	const ctx = context(
		{ resource: 'subscription', operation: 'get', subscriptionId: 'subscription-fixture' },
		{
			success: true,
			data: {
				...expected,
				internalOnly: 'fixture-private-root',
				metadata: { internalOnly: 'fixture-private-metadata' },
				customer: {
					...expected.customer,
					orgId: 'fixture-private-org',
					internalOnly: 'fixture-private-customer',
				},
				invoices: [
					{
						...expected.invoices[0],
						internalOnly: 'fixture-private-invoice',
						metadata: { internalOnly: 'fixture-private-invoice-metadata' },
						customer: { internalOnly: 'fixture-private-relation' },
						paylink: {
							...expected.invoices[0].paylink,
							orgId: 'fixture-private-org',
							internalOnly: 'fixture-private-link',
							organization: { internalOnly: 'fixture-private-organization' },
						},
					},
				],
			},
		},
	);
	const [[item]] = await new Yolfi().execute.call(ctx);
	assert.deepEqual(item.json, expected);
	assert.doesNotMatch(JSON.stringify(item), /fixture-private/);
	assert.deepEqual(item.pairedItem, { item: 0 });
});

test('payment link operations keep checkout configuration and omit unrelated response fields', async () => {
	const data = {
		id: 'link-fixture',
		name: 'Membership',
		price: '50.00',
		currency: 'USD',
		enabled: true,
		metadata: {
			afterCompletion: { type: 'REDIRECT', redirectUrl: 'https://merchant.example/thanks' },
			paymentMethodTypes: ['WALLET_TRANSFER'],
		},
		paymentMetadata: { product: 'membership' },
	};
	for (const operation of ['create', 'get', 'disable', 'getMany']) {
		const raw = {
			...data,
			orgId: 'fixture-private-org',
			internalOnly: 'fixture-private-field',
			organization: { internalOnly: 'fixture-private-relation' },
		};
		const ctx = context(
			{
				resource: 'paymentLink',
				operation,
				paymentLinkId: data.id,
				name: data.name,
				price: data.price,
				currency: data.currency,
			},
			{
				success: true,
				data: operation === 'getMany' ? [raw] : raw,
				total: 1,
			},
		);
		const [[item]] = await new Yolfi().execute.call(ctx);
		assert.deepEqual(item.json, { ...data, checkoutUrl: 'https://pay.yolfi.com/link-fixture' });
		assert.doesNotMatch(JSON.stringify(item), /fixture-private/);
	}
});

test('malformed subscription relations fail without emitting a partial response', async () => {
	for (const overrides of [
		{ customer: [] },
		{ invoices: {} },
		{ invoices: [null] },
		{ invoices: [{ paylink: [] }] },
	]) {
		const ctx = context(
			{ resource: 'subscription', operation: 'get', subscriptionId: 'subscription-fixture' },
			{ success: true, data: { id: 'subscription-fixture', ...overrides } },
		);
		await assert.rejects(() => new Yolfi().execute.call(ctx), /invalid subscription response/);
	}
});

test('HTTP-200 domain failures reject the action and identify its input item', async () => {
	const ctx = context(
		{ resource: 'customer', operation: 'get', customerId: 'missing' },
		{
			success: false,
			code: 11003,
			message: 'be-error-customer-not-found',
		},
	);
	await assert.rejects(
		() => new Yolfi().execute.call(ctx),
		(error) => {
			assert.equal(error.context.itemIndex, 0);
			assert.match(error.message, /Yolfi API request failed/);
			return true;
		},
	);
});

test('Continue On Fail emits one paired error item and continues with the next input', async () => {
	const ctx = context(
		{
			resource: 'customer',
			operation: 'get',
			customerId: (index) => `customer-${index}`,
		},
		(_request, call) =>
			call === 1
				? { success: false, message: 'be-error-customer-not-found' }
				: { success: true, data: { customer: { id: 'customer-1' } } },
		{ count: 2, continueOnFail: true },
	);
	const [items] = await new Yolfi().execute.call(ctx);
	assert.equal(items.length, 2);
	assert.match(items[0].json.error, /Yolfi API request failed/);
	assert.deepEqual(items[0].pairedItem, { item: 0 });
	assert.equal(items[1].json.customer.id, 'customer-1');
	assert.deepEqual(items[1].pairedItem, { item: 1 });
});

test('does not expose an unsupported public invoice operation or make requests without input items', async () => {
	const unsupported = context(
		{ resource: 'invoice', operation: 'get' },
		{ success: true, data: {} },
	);
	await assert.rejects(
		() => new Yolfi().execute.call(unsupported),
		/Unsupported Yolfi resource or operation/,
	);
	assert.equal(unsupported.requests.length, 0);
	const empty = context(checkoutParameters, { success: true, data: {} }, { count: 0 });
	assert.deepEqual(await new Yolfi().execute.call(empty), [[]]);
	assert.equal(empty.requests.length, 0);
});
