// Routing-rule correctness on a mock board:
//   1. clearance between two nets is the LARGER of their rules (EasyEDA DRC),
//      in the shared parser, the obstacle preflight and the grid pathfinder,
//      with the deciding net named in clearanceSource;
//   2. the board snapshot no longer lists component pads again under
//      standalonePads (pcb_PrimitivePad.getAll returns every pad), and routing,
//      connectivity and obstacle results are unchanged by it;
//   3. the argument aliases agents kept guessing (pathfind startX/..,
//      batch edits / primitiveIds, layer "Top"/"Bottom"), with unknown keys an error.
// Run: npx ts-node --transpile-only scripts/routing-rule-correctness-smoke.ts
import assert from 'node:assert/strict';
import { z } from 'zod';

// Mil profile: default rule Track 4 / pads+via 6 mil; class POWER (VBUS) Track 8 / pads+via 10 mil.
const ROWS = ['Track', 'SMD Pad', 'TH Pad', 'Via', 'Fill Region/Teardrop', 'Slot Region', 'Line', 'Text/Image', 'Board Outline', 'Hole'];
const table = (tt: number, other: number) => ROWS.map((_, r) => Array.from({ length: Math.min(r + 1, 9) }, (_, c) => (r === 0 && c === 0 ? tt : other)));
const netRules: any[] = [
	{ type: 'netClass', name: 'POWER', 'Safe Spacing': 'power', sub: [{ type: 'net', name: 'VBUS' }] },
	{ type: 'net', name: 'SIG', 'Safe Spacing': 'default' },
];
const ruleConfig: any = {
	Rule: { Spacing: { 'Safe Spacing': {
		default: { editName: 'default', unit: 'mil', isSetDefault: true, row: ROWS, column: ROWS.slice(0, 9), table: table(4, 6) },
		power: { editName: 'power', unit: 'mil', isSetDefault: false, row: ROWS, column: ROWS.slice(0, 9), table: table(8, 10) },
	} } },
	Net: netRules,
	ruleTemplateName: 'Pair Board',
};

// Component pins are 10-mil units (the snapshot scales x10); pcb_PrimitivePad.getAll
// reports the SAME pads in mil under the same primitiveId.
const pins: Record<string, any[]> = {
	cU1: [
		{ primitiveId: 'U1p1', padNumber: '1', net: 'SIG', layer: 1, x: 0, y: 0, pad: ['RECT', 20, 20, 0] },
		{ primitiveId: 'U1p2', padNumber: '2', net: 'LONE', layer: 1, x: 0, y: 10, pad: ['RECT', 20, 20, 0] },
	],
	cR1: [{ primitiveId: 'R1p1', padNumber: '1', net: 'SIG', layer: 1, x: 50, y: 0, pad: ['RECT', 20, 20, 0] }],
	// A connector whose centre is far from its pad: outside the obstacle check's component scan.
	cJ9: [{ primitiveId: 'J9p1', padNumber: '1', net: 'OTHER', layer: 1, x: 25, y: -30, pad: ['RECT', 20, 20, 0] }],
	cQ1: [{ primitiveId: 'Q1p1', padNumber: '1', net: 'VBUS', layer: 1, x: 25, y: 60, pad: ['RECT', 20, 20, 0] }],
};
const asStandaloneRecord = (pin: any) => ({ ...pin, x: pin.x * 10, y: pin.y * 10 });
const componentPadRecords = Object.values(pins).flat().map(asStandaloneRecord);
const testPoint = { primitiveId: 'TP1', padNumber: '1', net: 'SIG', layer: 1, x: 250, y: 300, pad: ['ELLIPSE', 30, 30] };
let padRecords: any[] = [...componentPadRecords, testPoint];

let seq = 0;
let lines: any[] = [];
const deleted: any[] = [];
const vbusTrack = { primitiveId: 'VB1', net: 'VBUS', layer: 1, startX: 100, startY: 16, endX: 400, endY: 16, lineWidth: 10 };
const resetLines = () => { lines = [{ ...vbusTrack }]; };
resetLines();

(globalThis as any).eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'pair-doc', documentType: 3 }) },
	pcb_PrimitiveComponent: {
		getAll: async () => [
			{ primitiveId: 'cU1', designator: 'U1', x: 0, y: 0 },
			{ primitiveId: 'cR1', designator: 'R1', x: 500, y: 0 },
			{ primitiveId: 'cJ9', designator: 'J9', x: 5000, y: 0 },
			{ primitiveId: 'cQ1', designator: 'Q1', x: 250, y: 600 },
		],
		getAllPinsByPrimitiveId: async (id: string) => pins[id] ?? [],
	},
	pcb_PrimitiveLine: {
		getAll: async (_n: any, layer: any) => (layer == null ? lines : lines.filter((l) => l.layer === layer)),
		create: async (net: string, layer: number, sx: number, sy: number, ex: number, ey: number, w: number) => {
			const l = { primitiveId: `L${++seq}`, net, layer, startX: sx, startY: sy, endX: ex, endY: ey, lineWidth: w };
			lines.push(l);
			return l;
		},
		delete: async (ids: string[]) => { deleted.push(ids); lines = lines.filter((l) => !ids.includes(l.primitiveId)); return true; },
	},
	pcb_PrimitiveVia: { getAll: async () => [], delete: async () => true },
	pcb_PrimitivePad: { getAll: async () => padRecords },
	pcb_PrimitivePour: { getAll: async () => [] },
	pcb_PrimitiveRegion: { getAll: async () => [] },
	pcb_PrimitivePolyline: { getAll: async () => [] },
	pcb_Layer: { getAllLayers: async () => [] },
	pcb_Net: { getAllNetsName: async () => ['SIG', 'VBUS', 'OTHER', 'LONE'], getNetLength: async () => 0 },
	pcb_Drc: { getCurrentRuleConfiguration: async () => ruleConfig, getNetRules: async () => netRules },
};

(async () => {
	const { clearanceBetween, clearanceResolverFromRules, resolverForRule } = await import('../src/shared/drc-rules');
	const { checkTraceObstacles, resolveClearance } = await import('../src/extension/handlers/trace-obstacles');
	const { boardContextHandlers, getSnapshot, isPointBlockedForRoute } = await import('../src/extension/handlers/board-context');
	const { analyzeConnectivity } = await import('../src/extension/handlers/net-connectivity');
	const { normalizeLayer } = await import('../src/extension/handlers/_utils');
	const { buildObstacleMap } = await import('../src/mcp-server/analyzers/obstacle-map');
	const { registerBoardContextTools } = await import('../src/mcp-server/tools/board-context-tools');

	// --- 1a. shared parser: max(rule of netA, rule of netB), net-class membership on both sides ---
	let d = clearanceBetween(ruleConfig, netRules, 'SIG', 'VBUS', 'smdPad');
	assert.equal(d.clearanceMil, 10, 'VBUS class rule (10) beats SIG default (6) for SMD Pad-Track');
	assert.equal(d.decidingNet, 'VBUS');
	assert.match(d.source, /^rule:Pair Board\/Safe Spacing\/power \(net class POWER -> VBUS\); larger-of-nets: VBUS 10 mil > SIG 6 mil \(SMD Pad-Track\)$/);
	d = clearanceBetween(ruleConfig, netRules, 'VBUS', 'SIG', 'smdPad');
	assert.equal(d.clearanceMil, 10);
	assert.equal(d.source, 'rule:Pair Board/Safe Spacing/power (net class POWER -> VBUS)', 'routed net already wins: its source, unchanged');
	const res = clearanceResolverFromRules(ruleConfig, netRules, ['SIG']);
	assert.equal(res.between('SIG', 'VBUS', 'track').clearanceMil, 8);
	assert.equal(res.between('SIG', 'VBUS').clearanceMil, 8, 'kind defaults to track');
	assert.equal(res.between('SIG', 'OTHER', 'via').clearanceMil, 6, 'both on the default rule');
	assert.equal(res.between('SIG', 'OTHER', 'via').source, res.for('SIG').source, 'tie keeps the routed net source');
	assert.equal(res.between('SIG', undefined, 'thPad').clearanceMil, 6, 'net-less copper is under the default rule');
	assert.equal(res.between(undefined, 'VBUS', 'track').clearanceMil, 8);
	assert.equal(res.between('SIG', 'VBUS', 'track'), res.between('SIG', 'VBUS', 'track'), 'memoized per pair');
	// Explicit override keeps its semantics: one value for every pair.
	const explicit = await resolveClearance(['SIG'], { clearanceMil: 3 });
	assert.deepEqual([explicit.between('SIG', 'VBUS', 'smdPad').clearanceMil, explicit.between('SIG', 'VBUS', 'smdPad').source], [3, 'param:clearanceMil']);
	assert.equal(resolverForRule({ clearanceMil: 5, source: 'x', byKind: { via: 7 } }).between('A', 'B', 'via').clearanceMil, 7);

	// --- 1b. obstacle preflight: a SIG track 6 mil from the VBUS track needs VBUS's 8 ---
	const straight = { net: 'SIG', layer: 1, startX: 0, startY: 0, endX: 500, endY: 0, lineWidth: 10 };
	let r: any = await checkTraceObstacles({ segments: [straight], includeBoardBoundary: false });
	let vb = r.obstacles.find((o: any) => o.primitiveId === 'VB1');
	assert.ok(vb, `VBUS track blocks: ${JSON.stringify(r.obstacles)}`);
	assert.equal(vb.distanceMil, 6);
	assert.equal(vb.clearanceRequiredMil, 8, 'larger of SIG 4 and VBUS 8');
	assert.match(vb.clearanceSource, /power \(net class POWER -> VBUS\); larger-of-nets: VBUS 8 mil > SIG 4 mil \(Track-Track\)/);
	assert.match(r.clearanceSource, /Safe Spacing\/default$/, 'summary still names the routed net rule');
	r = await checkTraceObstacles({ segments: [straight], includeBoardBoundary: false, clearanceMil: 5 });
	assert.equal(r.obstacles.filter((o: any) => o.primitiveId === 'VB1').length, 0, 'explicit clearanceMil overrides both nets');
	// A SIG track 8 mil from the VBUS pad Q1.1 (spans x 240..260, y 590..610): SMD Pad needs 10.
	r = await checkTraceObstacles({ segments: [{ net: 'SIG', layer: 1, startX: 200, startY: 577, endX: 300, endY: 577, lineWidth: 10 }], includeBoardBoundary: false });
	const q1 = r.obstacles.filter((o: any) => o.primitiveId === 'Q1p1');
	assert.equal(q1.length, 1, `component pad reported once, not again as a standalone pad: ${JSON.stringify(r.obstacles)}`);
	assert.equal(q1[0].type, 'component_pad');
	assert.equal(q1[0].clearanceRequiredMil, 10);
	assert.match(q1[0].clearanceSource, /larger-of-nets: VBUS 10 mil > SIG 6 mil \(SMD Pad-Track\)/);
	assert.ok(r.checked.componentPadDuplicatesSkipped >= 1);
	// J9's centre is outside the component scan: its pad still blocks, as the standalone record.
	r = await checkTraceObstacles({ segments: [{ net: 'SIG', layer: 1, startX: 100, startY: -318, endX: 400, endY: -318, lineWidth: 10 }], includeBoardBoundary: false });
	assert.deepEqual(r.obstacles.filter((o: any) => o.severity === 'blocker').map((o: any) => `${o.type}:${o.primitiveId}`), ['pad:J9p1']);

	// --- 1c. grid pathfinder blocks with the same larger-of-two-nets rule ---
	const snap = await getSnapshot({ forceRefresh: true });
	const cell = { x: 250, y: 0 }; // 6 mil edge gap to the VBUS track for a 10-mil SIG track
	assert.equal(isPointBlockedForRoute(snap, cell, { net: 'SIG', layer: 1, lineWidth: 10, clearance: res }), true, 'VBUS rule 8 > gap 6');
	assert.equal(isPointBlockedForRoute(snap, cell, { net: 'SIG', layer: 1, lineWidth: 10, clearance: res.for('SIG') }), false, 'SIG rule alone (4) would allow it');
	const pathfind = boardContextHandlers['pcb.route.pathfind'];
	const routeArgs = { from_pad: 'U1.1', to_pad: 'R1.1', lineWidth: 10, gridMil: 10, searchMarginMil: 150, dryRun: true };
	r = await pathfind(routeArgs);
	assert.equal(r.obstacleCheck.blockingObstacleCount, 0, `planner and preflight agree: ${JSON.stringify(r.obstacleCheck.obstacles.slice(0, 3))}`);
	assert.ok(Math.min(...r.routePoints.map((p: any) => p.y)) <= -5, `detoured away from VBUS: ${JSON.stringify(r.routePoints)}`);
	assert.match(r.clearanceSource, /Safe Spacing\/default$/);
	const straightPlan = await pathfind({ ...routeArgs, clearanceMil: 4 });
	assert.deepEqual(straightPlan.routePoints, [{ x: 0, y: 0 }, { x: 500, y: 0 }], 'with the old routed-net-only 4 mil the line is straight');

	// --- 2. snapshot: standalonePads holds only real standalone pads ---
	const summary = await boardContextHandlers['pcb.board.refreshCache']({});
	assert.equal(summary.standalonePadCount, 1, 'only TP1');
	assert.equal(summary.componentPadDuplicatesExcluded, componentPadRecords.length);
	assert.equal(summary.componentPadCount, componentPadRecords.length);
	const withDupes = await getSnapshot({ forceRefresh: true });
	assert.deepEqual(withDupes.standalonePads.map((p: any) => p.primitiveId), ['TP1']);
	const ctx = await boardContextHandlers['pcb.context.routing']({ net: 'SIG', left: -100, right: 600, top: -400, bottom: 700, maxItems: 50 });
	assert.deepEqual(ctx.area.standalonePads.map((p: any) => p.primitiveId), ['TP1']);
	assert.equal(ctx.area.summary.standalonePads, 1);
	assert.equal(ctx.area.summary.componentPads, 5);
	// Pad counts are no longer doubled: a one-pad net is single_pad again.
	const worklist = await boardContextHandlers['pcb.context.netWorklist']({});
	assert.deepEqual(worklist.nets.map((n: any) => [n.net, n.padCount]), [['SIG', 3]], 'LONE (1 pad) was "unrouted" with padCount 2');
	// Results equal those of a board whose getAll returns no component pads.
	padRecords = [testPoint];
	const clean = await getSnapshot({ forceRefresh: true });
	const cleanPlan = await pathfind(routeArgs);
	assert.deepEqual(cleanPlan.routePoints, r.routePoints, 'pathfinder unchanged');
	assert.equal(cleanPlan.obstacleCheck.blockingObstacleCount, r.obstacleCheck.blockingObstacleCount);
	const netsToCheck = ['SIG', 'LONE', 'OTHER', 'VBUS'];
	assert.deepEqual(analyzeConnectivity({ ...withDupes, arcs: [] }, netsToCheck, true), analyzeConnectivity({ ...clean, arcs: [] }, netsToCheck, true), 'connectivity unchanged');
	// A snapshot from an older extension (component pads repeated) is counted once by the MCP obstacle map.
	const legacy = { ...clean, standalonePads: [...clean.standalonePads, ...componentPadRecords] };
	assert.deepEqual(buildObstacleMap(legacy).totals, buildObstacleMap(clean).totals);
	assert.equal(buildObstacleMap(legacy).totals.pad, 1);
	padRecords = [...componentPadRecords, testPoint];

	// --- 3. aliases through the MCP tool surface (schema gate emulated like execute_tool) ---
	const tools: Record<string, { schema: any; handler: Function }> = {};
	const server = { tool: (name: string, _d: string, schema: any, handler: Function) => { tools[name] = { schema, handler }; } };
	const bridge = { send: async (method: string, params: any) => boardContextHandlers[method](params) };
	registerBoardContextTools(server as any, bridge as any);
	const call = async (name: string, args: Record<string, unknown>) => {
		const parsed = z.object(tools[name].schema).safeParse({ document: 'pair-doc', ...args });
		if (!parsed.success) return { schemaError: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
		const out = await tools[name].handler(parsed.data);
		const body = JSON.parse(out.content[0].text);
		return out.isError ? { toolError: body.error } : body;
	};

	assert.equal(normalizeLayer('Top'), 1);
	assert.equal(normalizeLayer('Bottom'), 2);
	r = await call('pcb_route_pathfind', { startX: 0, startY: 0, endX: 500, endY: 0, net: 'SIG', layer: 'Top', lineWidth: 10, gridMil: 10, searchMarginMil: 150, clearanceMil: 4, dryRun: true });
	assert.equal(r.layer, 1, JSON.stringify(r));
	assert.deepEqual(r.routePoints, [{ x: 0, y: 0 }, { x: 500, y: 0 }], 'point form routes like the pads');
	assert.equal(r.net, 'SIG');
	await assert.rejects(call('pcb_route_pathfind', { startX: 0, startY: 0, endX: 500, endY: 50, dryRun: true }), /pass net when both ends are points/);
	await assert.rejects(call('pcb_route_pathfind', { from_pad: 'U1.1', startX: 0, startY: 0, to_pad: 'R1.1', dryRun: true }), /either from_pad or startX\/startY/);
	await assert.rejects(call('pcb_route_pathfind', { startX: 0, endX: 500, endY: 0, net: 'SIG', dryRun: true }), /startX and startY must both be numbers/);
	r = await call('pcb_route_pathfind', { to_pad: 'R1.1', dryRun: true });
	assert.match(r.toolError, /requires from_pad \(or startX\/startY\)/);

	const track = { type: 'create_track', net: 'SIG', layer: 'Bottom', startX: 0, startY: 900, endX: 300, endY: 900, lineWidth: 10 };
	r = await call('pcb_batch_edit', { edits: [track], dryRun: true });
	assert.equal(r.committed, false, JSON.stringify(r));
	assert.equal(r.normalized[0].segment.layer, 2, '"Bottom" -> 2');
	const { lineWidth: _w, ...trackNoWidth } = track;
	r = await call('pcb_batch_edit', { operations: [{ ...trackNoWidth, width: 12 }], dryRun: true });
	assert.equal(r.normalized[0].segment.lineWidth, 12, 'width is an alias of lineWidth');
	r = await call('pcb_batch_edit', { dryRun: true });
	assert.match(r.toolError, /requires operations:\[\.\.\.\] \(alias: edits\)/);
	await assert.rejects(call('pcb_batch_edit', { operations: [track], edits: [track], dryRun: true }), /not both/);
	await assert.rejects(
		call('pcb_batch_edit', { operations: [{ ...track, lineWdith: 10 }, { type: 'delete', primitiveType: 'track', primitive_ids: ['X'] }], dryRun: true }),
		/operation #0 \(create_track\): unknown key\(s\) "lineWdith"; accepted: .*lineWidth.*\| operation #1 \(delete\): unknown key\(s\) "primitive_ids".*ids:\[\.\.\.\] is required/,
	);
	await assert.rejects(call('pcb_batch_edit', { operations: [{ type: 'create_track', layer: 1, startX: 0, startY: 0, endX: 10, endY: 0 }], dryRun: true }), /net is required/);
	// primitiveIds alias: the delete really receives the id (it used to receive ["undefined"]).
	lines.push({ primitiveId: 'DEL1', net: 'SIG', layer: 2, startX: 0, startY: 1200, endX: 100, endY: 1200, lineWidth: 10 });
	r = await call('pcb_batch_edit', { edits: [{ type: 'delete', primitiveType: 'track', primitiveIds: ['DEL1'] }], dryRun: false });
	assert.equal(r.committed, true, JSON.stringify(r));
	assert.deepEqual(deleted, [['DEL1']]);
	assert.deepEqual(r.deleted, [{ index: 0, primitiveType: 'track', ids: ['DEL1'] }]);
	r = await call('pcb_batch_edit', { operations: [{ type: 'delete', primitiveType: 'track', primitiveId: 'NOPE' }], dryRun: true });
	assert.deepEqual(r.normalized[0].ids, ['NOPE'], 'a single primitiveId is accepted too');
	resetLines();

	console.log('Routing rule correctness: larger-of-two-nets clearance (parser, preflight, pathfinder) with the deciding net in clearanceSource; component pads no longer duplicated as standalone pads (routing/connectivity/obstacle results unchanged, pad counts fixed); pathfind/batch-edit aliases and unknown-key errors — passed.');
	process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
