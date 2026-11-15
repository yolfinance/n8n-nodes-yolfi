import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { YolfiTrigger } from '../dist/nodes/YolfiTrigger/YolfiTrigger.node.js';

const { NodeHelpers } = createRequire(import.meta.url)('n8n-workflow');

test('imported payment examples receive separate webhook URLs from n8n', async () => {
	const workflow = JSON.parse(
		await readFile(new URL('../examples/payment-confirmed-record.json', import.meta.url), 'utf8'),
	);
	const original = workflow.nodes.find((node) => node.type === 'n8n-nodes-yolfi.yolfiTrigger');
	assert.equal(original.webhookId, undefined);
	const imports = [structuredClone(original), structuredClone(original)];
	for (const node of imports)
		NodeHelpers.resolveNodeWebhookId(node, new YolfiTrigger().description);
	assert.notEqual(imports[0].webhookId, imports[1].webhookId);
	assert.notEqual(
		NodeHelpers.getNodeWebhookUrl(
			'https://automation.example.com/webhook',
			'workflow-1',
			imports[0],
			'webhook',
			false,
		),
		NodeHelpers.getNodeWebhookUrl(
			'https://automation.example.com/webhook',
			'workflow-2',
			imports[1],
			'webhook',
			false,
		),
	);
	assert.equal(workflow.active, false);
	assert.equal(workflow.staticData, undefined);
	assert.deepEqual(workflow.pinData, {});
});
