// execute_tool wiring: response budget, read_result, raw, snapshot repair,
// signature-on-validation-error, lease propagation.
// Run: npx ts-node --transpile-only scripts/execute-tool-e2e-smoke.ts
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ToolCatalog } from '../src/mcp-server/catalog';
import { leaseContext, setLeaseSupport } from '../src/mcp-server/lease-context';

const catalog = new ToolCatalog();
const big = { nets: Array.from({ length: 2000 }, (_, i) => ({ name: `N${i}`, x: i * 1.123456789, net: null })) };
const json = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
let received: unknown;

catalog.tool('big_tool', 'returns a large result', { document: z.string() }, async () => json(big));
catalog.tool('snap_tool', 'consumes a snapshot', { snapshot: z.any().optional(), n: z.number() }, async (args) => { received = args.snapshot; return json({ ok: true }); });
catalog.tool('lease_probe', 'reports the lease context', {}, async () => json(leaseContext.getStore() ?? {}));
catalog.tool('native_thing', 'recovery tool output stays exact', {}, async () => json(big));

const handlers: Record<string, (args: any) => Promise<any>> = {};
catalog.attachDynamic({ tool(name: string, _b: string, _s: unknown, h: any) { handlers[name] = h; } } as any);
const exec = handlers.execute_tool;
const body = (r: any) => JSON.parse(r.content[0].text);

(async () => {
	// Validation error returns the signature, so describe_tools is optional.
	const invalid = await exec({ name: 'snap_tool', args: { n: 'x' } });
	assert.equal(invalid.isError, true);
	assert.match(body(invalid).args, /n: number/);

	// Oversized result → trimmed preview with a handle, inside the default budget.
	const trimmed = await exec({ name: 'big_tool', args: { document: 'd' } });
	const preview = body(trimmed);
	assert.ok(trimmed.content[0].text.length <= 24_000);
	assert.ok(preview._truncated.handle.startsWith('res_'));
	assert.equal(preview.nets[0].net, undefined, 'nulls stripped in the preview');
	assert.equal(preview.nets[1].x, 1.1235, 'floats rounded in the preview');

	// read_result pages the stored result.
	const page = body(await handlers.read_result({ handle: preview._truncated.handle, path: 'nets', offset: 590, limit: 5, fields: ['name'] }));
	assert.deepEqual(page.items, [{ name: 'N590' }, { name: 'N591' }, { name: 'N592' }, { name: 'N593' }, { name: 'N594' }]);

	// raw and max_chars:0 escape hatches.
	assert.equal((await exec({ name: 'big_tool', args: { document: 'd' }, raw: true })).content[0].text, JSON.stringify(big));
	assert.equal(body(await exec({ name: 'big_tool', args: { document: 'd' }, max_chars: 0 })).nets.length, 2000);

	// Pasting the trimmed preview (or just its handle) back as a snapshot hands
	// the analyzer the exact original — nulls and full precision included.
	await exec({ name: 'snap_tool', args: { n: 1, snapshot: preview } });
	assert.deepEqual(received, big);
	received = undefined;
	await exec({ name: 'snap_tool', args: { n: 1, snapshot: preview._truncated.handle } });
	assert.deepEqual(received, big);
	const expired = await exec({ name: 'snap_tool', args: { n: 1, snapshot: 'res_0000000000' } });
	assert.match(body(expired).error, /expired or unknown/);

	// Recovery tools are never reshaped.
	assert.equal((await exec({ name: 'native_thing', args: {} })).content[0].text, JSON.stringify(big));

	// Leases: refused without daemon support, propagated to handlers with it.
	setLeaseSupport(false);
	assert.match(body(await exec({ name: 'lease_probe', args: {}, lease: 'lease_x' })).error, /daemon mode/);
	setLeaseSupport(true);
	assert.deepEqual(body(await exec({ name: 'lease_probe', args: {}, lease: 'lease_x' })), { leaseId: 'lease_x' });
	assert.deepEqual(body(await exec({ name: 'lease_probe', args: {}, override_leases: true })), { overrideLeases: true });

	console.log('execute_tool wiring: budget, read_result, raw, snapshot repair, signature-on-error, lease propagation — passed.');
})().catch((err) => { console.error(err); process.exit(1); });
