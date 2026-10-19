// Response governor: compaction, budget trimming, read_result paging.
// Run: npx ts-node --transpile-only scripts/response-budget-smoke.ts
import assert from 'node:assert/strict';
import { compactValue, roundNumber, shapeToolResult, readStoredResult } from '../src/mcp-server/catalog/response-shaper';

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const parse = (r: any) => JSON.parse(r.content[0].text);

// --- rounding keeps EDA precision ---
assert.equal(roundNumber(984.2519685039371), 984.252);
assert.equal(roundNumber(-669.2913385826772), -669.2913);
assert.equal(roundNumber(1e-9), 1e-9, 'tiny component values survive');
assert.equal(roundNumber(4.7e-12 * 1.0000001), 4.7e-12);
assert.equal(roundNumber(0.123456789), 0.123457);
assert.equal(roundNumber(42), 42);
assert.ok(Math.abs(roundNumber(12345.678901) - 12345.678901) < 1e-4, '≤ 0.0001 mil error');

// --- compaction drops nulls, keeps empty arrays and falsy values ---
assert.deepEqual(compactValue({ a: null, b: [], c: 0, d: false, e: '', f: [null, 1.23456789] }), { b: [], c: 0, d: false, e: '', f: [null, 1.2346] });

// --- small results only get compacted ---
const small = parse(shapeToolResult(text({ x: 1.000049999, net: null, ok: true }), { tool: 't' }));
assert.deepEqual(small, { x: 1, ok: true });

// --- oversized results come back trimmed, same shape, with a handle ---
const big = {
	summary: { nets: 400, violations: 3 },
	nets: Array.from({ length: 400 }, (_, i) => ({ name: `N${i}`, x: i * 1.123456789, y: -i * 2.987654321, layer: 'TopLayer', pads: [`U1.${i}`, `R${i}.1`] })),
};
const shaped = parse(shapeToolResult(text(big), { tool: 'pcb_get_routing_context', maxChars: 6_000 }));
assert.ok(JSON.stringify(shaped).length <= 6_000, 'preview fits the budget');
assert.deepEqual(shaped.summary, big.summary, 'small branches pass through intact');
assert.ok(shaped._truncated?.handle?.startsWith('res_'));
const marker = shaped.nets[shaped.nets.length - 1];
assert.match(marker, /more of 400 — read_result handle=res_\w+ path=nets offset=\d+/);

// --- read_result pages the parked (compacted) result ---
const page = readStoredResult({ handle: shaped._truncated.handle, path: 'nets', offset: 390, limit: 50, fields: ['name', 'x'] }) as any;
assert.equal(page.total, 400);
assert.equal(page.returned, 10);
assert.deepEqual(page.items[0], { name: 'N390', x: roundNumber(390 * 1.123456789) });
assert.deepEqual((readStoredResult({ handle: shaped._truncated.handle, path: 'nets.7.pads' }) as any).items, ['U1.7', 'R7.1']);
assert.throws(() => readStoredResult({ handle: shaped._truncated.handle, path: 'nope' }), /does not exist/);
assert.throws(() => readStoredResult({ handle: 'res_missing' }), /expired or unknown/);

// --- raw / unlimited escape hatches ---
const raw = shapeToolResult(text(big), { tool: 't', raw: true });
assert.equal(raw.content[0].text, JSON.stringify(big), 'raw is byte-identical');
const unlimited = parse(shapeToolResult(text(big), { tool: 't', maxChars: 0 }));
assert.equal(unlimited.nets.length, 400);
assert.equal(unlimited._truncated, undefined);

// --- images untouched, non-JSON text trimmed with a handle ---
const image = { type: 'image', data: 'x'.repeat(50_000), mimeType: 'image/png' };
const mixed = shapeToolResult({ content: [image, { type: 'text', text: 'log line\n'.repeat(5_000) }] }, { tool: 't', maxChars: 1_000 }) as any;
assert.equal(mixed.content[0], image);
assert.match(mixed.content[1].text, /read_result handle=res_\w+ offset=1000\)$/);

// --- top-level arrays and very wide objects still fit ---
const arr = parse(shapeToolResult(text(Array.from({ length: 5_000 }, (_, i) => ({ i }))), { tool: 't', maxChars: 3_000 }));
assert.ok(Array.isArray(arr.preview) && arr._truncated);
const wide = Object.fromEntries(Array.from({ length: 3_000 }, (_, i) => [`key${i}`, { v: i }]));
const wideShaped = shapeToolResult(text(wide), { tool: 't', maxChars: 3_000 }) as any;
assert.ok(wideShaped.content[0].text.length <= 3_000 + 800, 'outline fallback stays small');

// --- id-keyed maps (components by designator) trim and page like arrays ---
const map = { components: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`U${i}`, { mpn: `PART-${i}`, pins: { 1: 'GND', 2: 'VCC' } }])) };
const mapShaped = parse(shapeToolResult(text(map), { tool: 'sch_extract_design', maxChars: 4_000 }));
assert.ok(JSON.stringify(mapShaped).length <= 4_000, 'map preview fits the budget');
assert.match(mapShaped.components['…'], /more of 300 keys — read_result handle=res_\w+ path=components offset=\d+/);
assert.deepEqual(mapShaped.components.U0.pins, { 1: 'GND', 2: 'VCC' }, 'small records inside a map stay whole');
const mapPage = readStoredResult({ handle: mapShaped._truncated.handle, path: 'components', offset: 298 }) as any;
assert.equal(mapPage.totalKeys, 300);
assert.deepEqual(Object.keys(mapPage.entries), ['U298', 'U299']);

console.log('Response governor: rounding, compaction, budget trimming, read_result paging, escape hatches — passed.');
