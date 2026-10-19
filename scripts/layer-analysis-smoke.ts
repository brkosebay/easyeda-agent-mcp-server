// pcb_layer_report / pcb_set_copper_layer_count / pcb_set_inner_layer_type /
// pcb_move_tracks_to_layer against a stateful 4-layer mock board.
// Run: npx ts-node --transpile-only scripts/layer-analysis-smoke.ts
import assert from 'node:assert/strict';

// Board 2000 × 1500 mil, canvas Y negative. Stack: Top / L2_GND (15, GND
// plane) / L3_PWR (16, 3V3 plane) / Bottom (GND flood).
//   SIG1   U1.1 (200,-200) —T1 top— R1.1 (1200,-200)
//   HS_CLK U1.2 (200,-300) —T2 top— V1 (600,-300) —T3 bottom— V2 (1400,-300) —T4 top— U2.1 (1500,-300)
//   SIG2   U3.1 (300,-700) —S1 top— VA (300,-800) —S2 L2_GND— VB (1700,-800) —S3 top— Q1.1 (1700,-700)
//   DATA   VD1 (1000,-20) —D1 L3_PWR— VD2 (1000,-1480)   (cuts the 3V3 plane under HS_CLK)
let lines: any[] = [];
let vias: any[] = [];
let layerRows: any[] = [];
let seq = 0;
let modifyCalls = 0;

const outline = [
	{ primitiveId: 'O1', layer: 11, startX: 0, startY: 0, endX: 2000, endY: 0, lineWidth: 5 },
	{ primitiveId: 'O2', layer: 11, startX: 2000, startY: 0, endX: 2000, endY: -1500, lineWidth: 5 },
	{ primitiveId: 'O3', layer: 11, startX: 2000, startY: -1500, endX: 0, endY: -1500, lineWidth: 5 },
	{ primitiveId: 'O4', layer: 11, startX: 0, startY: -1500, endX: 0, endY: 0, lineWidth: 5 },
];

function reset(): void {
	lines = [
		...outline.map((o) => ({ ...o })),
		{ primitiveId: 'T1', net: 'SIG1', layer: 1, startX: 200, startY: -200, endX: 1200, endY: -200, lineWidth: 10 },
		{ primitiveId: 'T2', net: 'HS_CLK', layer: 1, startX: 200, startY: -300, endX: 600, endY: -300, lineWidth: 8 },
		{ primitiveId: 'T3', net: 'HS_CLK', layer: 2, startX: 600, startY: -300, endX: 1400, endY: -300, lineWidth: 8 },
		{ primitiveId: 'T4', net: 'HS_CLK', layer: 1, startX: 1400, startY: -300, endX: 1500, endY: -300, lineWidth: 8 },
		{ primitiveId: 'S1', net: 'SIG2', layer: 1, startX: 300, startY: -700, endX: 300, endY: -800, lineWidth: 10 },
		{ primitiveId: 'S2', net: 'SIG2', layer: 15, startX: 300, startY: -800, endX: 1700, endY: -800, lineWidth: 10 },
		{ primitiveId: 'S3', net: 'SIG2', layer: 1, startX: 1700, startY: -800, endX: 1700, endY: -700, lineWidth: 10 },
		{ primitiveId: 'D1', net: 'DATA', layer: 16, startX: 1000, startY: -20, endX: 1000, endY: -1480, lineWidth: 10 },
	];
	vias = [
		{ primitiveId: 'V1', net: 'HS_CLK', x: 600, y: -300, diameter: 24, holeDiameter: 12 },
		{ primitiveId: 'V2', net: 'HS_CLK', x: 1400, y: -300, diameter: 24, holeDiameter: 12 },
		{ primitiveId: 'VA', net: 'SIG2', x: 300, y: -800, diameter: 24, holeDiameter: 12 },
		{ primitiveId: 'VB', net: 'SIG2', x: 1700, y: -800, diameter: 24, holeDiameter: 12 },
		{ primitiveId: 'VD1', net: 'DATA', x: 1000, y: -20, diameter: 24, holeDiameter: 12 },
		{ primitiveId: 'VD2', net: 'DATA', x: 1000, y: -1480, diameter: 24, holeDiameter: 12 },
	];
	layerRows = [
		{ id: 1, name: 'Top Layer', type: 'TOP', layerStatus: 1 },
		{ id: 2, name: 'Bottom Layer', type: 'BOTTOM', layerStatus: 1 },
		{ id: 3, name: 'Top Silkscreen Layer', type: 'TOP_SILK', layerStatus: 1 },
		{ id: 11, name: 'Board Outline Layer', type: 'OUTLINE', layerStatus: 1 },
		{ id: 12, name: 'Multi-Layer', type: 'MULTI', layerStatus: 1 },
		{ id: 15, name: 'L2_GND', type: 'SIGNAL', layerStatus: 1 },
		{ id: 16, name: 'L3_PWR', type: 'SIGNAL', layerStatus: 1 },
		...Array.from({ length: 30 }, (_, i) => ({ id: 17 + i, name: `Inner${i + 3}`, type: 'SIGNAL', layerStatus: 0 })),
	];
	modifyCalls = 0;
}

// Pour SOURCES are data space: Y positive down (the transform flips it).
const rect = ['R', 0, 0, 2000, 1500, 0, 0];
const pours = [
	{ primitiveId: 'P15', net: 'GND', layer: 15, pourName: 'L2_GND', pourPriority: 1, complexPolygon: rect },
	{ primitiveId: 'P16', net: '3V3', layer: 16, pourName: 'L3_3V3', pourPriority: 1, complexPolygon: rect },
	{ primitiveId: 'P2', net: 'GND', layer: 2, pourName: 'BOTTOM_GND', pourPriority: 1, complexPolygon: rect },
];

// Component pins: coordinates in 10-mil units; pad tuples in mil.
const smd = (id: string, n: string, net: string, x: number, y: number) => ({ primitiveId: id, padNumber: n, net, layer: 1, x: x / 10, y: y / 10, pad: ['RECT', 20, 20, 0] });
const pins: Record<string, any[]> = {
	cU1: [smd('U1p1', '1', 'SIG1', 200, -200), smd('U1p2', '2', 'HS_CLK', 200, -300)],
	cR1: [smd('R1p1', '1', 'SIG1', 1200, -200)],
	cU2: [smd('U2p1', '1', 'HS_CLK', 1500, -300)],
	cU3: [smd('U3p1', '1', 'SIG2', 300, -700)],
	cQ1: [smd('Q1p1', '1', 'SIG2', 1700, -700)],
	cJ1: [{ primitiveId: 'J1p1', padNumber: '1', net: '3V3', layer: 12, x: 180, y: -100, pad: ['ELLIPSE', 60, 60], hole: ['ROUND', 3.5, 3.5] }],
};

const activeCopper = () => layerRows.filter((r) => (r.id === 1 || r.id === 2 || (r.id >= 15 && r.id <= 46)) && r.layerStatus !== 0).length;

(globalThis as any).eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'doc1', documentType: 3 }) },
	pcb_Document: { convertDataOriginToCanvasOrigin: async (x: number, y: number) => ({ x, y }) },
	pcb_PrimitiveComponent: {
		getAll: async () => [
			{ primitiveId: 'cU1', designator: 'U1', x: 200, y: -250 },
			{ primitiveId: 'cR1', designator: 'R1', x: 1200, y: -200 },
			{ primitiveId: 'cU2', designator: 'U2', x: 1500, y: -300 },
			{ primitiveId: 'cU3', designator: 'U3', x: 300, y: -700 },
			{ primitiveId: 'cQ1', designator: 'Q1', x: 1700, y: -700 },
			{ primitiveId: 'cJ1', designator: 'J1', x: 1800, y: -1000 },
		],
		getAllPinsByPrimitiveId: async (id: string) => pins[id] ?? [],
	},
	pcb_PrimitiveLine: {
		getAll: async (net: any, layer: any) => lines.filter((l) => (net == null || l.net === net) && (layer == null || l.layer === layer)),
		get: async (id: string) => lines.find((l) => l.primitiveId === id),
		modify: async (id: string, props: any) => {
			modifyCalls++;
			const l = lines.find((x) => x.primitiveId === id);
			if (!l) return undefined;
			Object.assign(l, props);
			return l;
		},
	},
	pcb_PrimitiveVia: {
		getAll: async () => vias,
		create: async (net: string, x: number, y: number, holeDiameter: number, diameter: number) => {
			const v = { primitiveId: `NV${++seq}`, net, x, y, holeDiameter, diameter };
			vias.push(v);
			return v;
		},
		delete: async (ids: string[]) => { vias = vias.filter((v) => !ids.includes(v.primitiveId)); return true; },
	},
	pcb_PrimitiveArc: { getAll: async () => [], get: async () => undefined, modify: async () => undefined },
	pcb_PrimitivePad: { getAll: async () => [] },
	pcb_PrimitivePour: { getAll: async () => pours },
	pcb_PrimitiveFill: { getAll: async () => [] },
	pcb_PrimitiveRegion: { getAll: async () => [] },
	pcb_PrimitivePolyline: { getAll: async () => [] },
	pcb_Layer: {
		getAllLayers: async () => layerRows.map((r) => ({ ...r })),
		getTheNumberOfCopperLayers: async () => activeCopper(),
		setTheNumberOfCopperLayers: async (count: number) => {
			for (const r of layerRows) if (r.id >= 15 && r.id <= 46) r.layerStatus = r.id < 15 + count - 2 ? 1 : 0;
			return true;
		},
		modifyLayer: async (id: number, prop: any) => {
			const r = layerRows.find((x) => x.id === id);
			if (!r) return false;
			Object.assign(r, prop);
			return true;
		},
	},
	pcb_Net: { getAllNetsName: async () => ['SIG1', 'SIG2', 'HS_CLK', 'DATA', 'GND', '3V3'], getNetLength: async () => 0 },
	pcb_Drc: { getCurrentRuleConfiguration: async () => undefined, getNetRules: async () => undefined },
};

(async () => {
	const { layerAnalysisHandlers: h } = await import('../src/extension/handlers/layer-analysis');
	const { layerHandlers } = await import('../src/extension/handlers/layer');
	const codes = (r: any) => (r.issues ?? []).map((i: any) => i.code);
	const lineLayer = (id: string) => lines.find((l) => l.primitiveId === id)?.layer;
	reset();

	// --- report: numbers on the 4-layer board ---
	let r: any = await h['pcb.layer.report']({ forceRefresh: true });
	assert.equal(r.board.copperLayers, 4, JSON.stringify(r.board));
	assert.deepEqual(r.board.stack.map((s: string) => s.split(':')[0]), ['Top Layer', 'L2_GND', 'L3_PWR', 'Bottom Layer']);
	assert.equal(r.board.pourSpace, 'canvas');
	assert.equal(r.board.areaIn2, 3);
	const layer = (id: number) => r.layers.find((l: any) => l.id === id);
	assert.equal(layer(1).role, 'signal');
	assert.equal(layer(1).tracks, 5);
	assert.equal(layer(1).lenMil, 1700, 'T1 1000 + T2 400 + T4 100 + S1 100 + S3 100');
	assert.equal(layer(1).viaTransitions, 4, 'V1, V2 (HS_CLK) and VA, VB (SIG2) change layer on Top');
	assert.equal(layer(2).role, 'signal+flood', 'bottom carries the HS_CLK leg over its GND flood');
	assert.equal(layer(2).pours[0].areaPct, 100);
	assert.equal(layer(15).role, 'plane');
	assert.equal(layer(16).role, 'plane');

	// --- plane-cut detection ---
	assert.equal(layer(15).plane.net, 'GND');
	assert.equal(layer(15).plane.cutTracks, 1);
	assert.deepEqual(layer(15).plane.cutNets, [{ net: 'SIG2', tracks: 1, lenMil: 1400 }]);
	assert.equal(layer(15).plane.antipads, 6, 'every non-GND via pierces the GND plane');
	assert.equal(layer(16).plane.net, '3V3');
	assert.equal(layer(16).plane.cutNets[0].net, 'DATA');
	assert.equal(layer(16).plane.likelySplit, true, 'DATA runs edge to edge across the 3V3 plane');
	assert.equal(r.copperIslands.available, false);

	// --- references under the signals ---
	const clk = r.netIssues.find((n: any) => n.net === 'HS_CLK');
	assert.ok(clk?.hs, JSON.stringify(r.netIssues));
	assert.deepEqual(clk.ref.find((x: any) => x.on === 'Bottom Layer'), { on: 'Bottom Layer', ref: 'L3_PWR', refNet: '3V3', cov: 100, cross: 1, by: ['DATA'] });
	assert.deepEqual(r.netIssues.map((n: any) => n.net), ['HS_CLK'], 'SIG1 sits over an intact GND plane; SIG2/DATA run inside planes (PLANE_CUT findings)');

	// --- recommendations fire with reasons ---
	const rec = (code: string) => r.recommendations.find((x: any) => x.code === code);
	assert.equal(rec('PLANE_CUT')?.sev, 'high');
	assert.match(rec('PLANE_CUT').msg, /L2_GND is a GND reference plane.*SIG2 1400/);
	assert.match(rec('PLANE_CUT').fix, /pcb_move_tracks_to_layer \{net:"SIG2", fromLayer:15, toLayer:1\}/);
	assert.equal(rec('SPLIT_REFERENCE')?.sev, 'high', 'HS_CLK crosses the DATA cut');
	assert.ok(rec('STUB_VIA'), 'DATA vias change no layer');
	assert.ok(rec('LAYER_COUNT') && rec('STACKUP'));
	assert.match(rec('STACKUP').msg, /Current: SIG \/ GND \/ PWR \/ SIG\+GND/);
	assert.ok(r.recommendations.every((x: any) => x.why && x.sev && x.conf));
	assert.ok(JSON.stringify(r).length < 6000, `summary stays compact (${JSON.stringify(r).length} chars)`);

	r = await h['pcb.layer.report']({ detail: 'nets', nets: ['SIG1'] });
	assert.deepEqual(r.nets, [{ net: 'SIG1', pads: 2, vias: 0, lenMil: 1000, len: { 'Top Layer': 1000 }, ref: [{ on: 'Top Layer', ref: 'L2_GND', refNet: 'GND', cov: 100, cross: 0 }] }]);

	// --- copper layer count: reduction refused while inner copper exists ---
	r = await h['pcb.layer.copperCount.set']({ count: 2, dryRun: false });
	assert.equal(r.status, 'refused', JSON.stringify(r));
	assert.deepEqual(r.occupied.map((o: any) => [o.layer, o.tracks, o.pours?.[0]?.net]), [[15, 1, 'GND'], [16, 1, '3V3']]);
	assert.equal(activeCopper(), 4, 'nothing changed');
	r = await layerHandlers['pcb.layer.setCopperCount']({ count: 2 });
	assert.equal(r.status, 'refused', 'pcb_manage_layers set_copper_count goes through the guard');
	r = await h['pcb.layer.copperCount.set']({ count: 6 });
	assert.equal(r.status, 'dry-run');
	assert.deepEqual(r.plan.adds, ['Inner3', 'Inner4']);
	r = await h['pcb.layer.copperCount.set']({ count: 6, dryRun: false });
	assert.equal(r.status, 'applied', JSON.stringify(r));
	assert.equal(r.after.copperLayers, 6);
	r = await h['pcb.layer.copperCount.set']({ count: 4, dryRun: false });
	assert.equal(r.status, 'applied', 'empty Inner3/Inner4 drop without force');
	r = await h['pcb.layer.copperCount.set']({ count: 2, dryRun: false, force: true });
	assert.equal(r.status, 'applied');
	assert.equal(r.leftoverOnRemovedLayers.length, 2, 'reports copper left on the removed layers');
	reset();

	// --- inner layer type ---
	r = await h['pcb.layer.innerType.set']({ layer: 'L3_PWR', type: 'PLANE', dryRun: false });
	assert.equal(r.status, 'refused', 'DATA track lives on L3_PWR');
	assert.equal(layerRows.find((x) => x.id === 16).type, 'SIGNAL');
	r = await h['pcb.layer.innerType.set']({ layer: 'L3_PWR', type: 'PLANE', force: true, dryRun: false });
	assert.equal(r.status, 'applied', JSON.stringify(r));
	assert.equal(r.after.type, 'PLANE');
	await assert.rejects(h['pcb.layer.innerType.set']({ layer: 'Top Layer', type: 'PLANE' }), /not an inner copper layer/);
	reset();

	// --- move tracks: dry-run then commit (the SIG2 cut leaves the GND plane) ---
	r = await h['pcb.layer.moveTracks']({ net: 'SIG2', fromLayer: 'L2_GND', toLayer: 'TopLayer' });
	assert.equal(r.status, 'dry-run', JSON.stringify(r));
	assert.deepEqual([r.plan.tracks, r.plan.lenMil, r.plan.ids], [1, 1400, ['S2']]);
	assert.equal(lineLayer('S2'), 15, 'dry-run changes nothing');
	r = await h['pcb.layer.moveTracks']({ net: 'SIG2', fromLayer: 15, toLayer: 1, dryRun: false });
	assert.equal(r.status, 'moved', JSON.stringify(r));
	assert.equal(lineLayer('S2'), 1);
	assert.equal(r.verify.connectivity.ok, true);
	r = await h['pcb.layer.report']({ forceRefresh: true });
	assert.equal(r.layers.find((l: any) => l.id === 15).plane.cutTracks, 0, 'GND plane no longer cut');
	assert.ok(!r.recommendations.some((x: any) => x.code === 'PLANE_CUT' && /L2_GND/.test(x.msg)));
	reset();

	// --- refusal: an end lands on a top SMD pad ---
	r = await h['pcb.layer.moveTracks']({ trackIds: ['T1'], toLayer: 15, dryRun: false });
	assert.equal(r.status, 'refused', JSON.stringify(r));
	assert.deepEqual(codes(r).filter((c: string) => c === 'PAD_LAYER').length, 2);
	assert.equal(lineLayer('T1'), 1);
	assert.equal(modifyCalls, 0);
	// ...unless vias are supplied (via-in-pad is only a warning)
	r = await h['pcb.layer.moveTracks']({ trackIds: ['T1'], toLayer: 15, vias: [{ x: 200, y: -200 }, { x: 1200, y: -200 }] });
	assert.equal(r.status, 'dry-run', JSON.stringify(r));
	assert.deepEqual(codes(r), ['VIA_IN_PAD', 'VIA_IN_PAD', 'PLANE_CUT'], 'T1 would also cut the GND plane');
	assert.equal(r.vias[0].diameter, 24);
	r = await h['pcb.layer.moveTracks']({ trackIds: ['T2'], toLayer: 2 });
	assert.ok(codes(r).includes('PAD_LAYER'), 'T2 starts on U1.2 (top)');
	// via not on a moved end
	r = await h['pcb.layer.moveTracks']({ trackIds: ['S2'], toLayer: 1, vias: [{ x: 900, y: -900 }] });
	assert.ok(codes(r).includes('VIA_NOT_AT_ENDPOINT'));
	// ORPHANED: same-layer copper left behind at a moved end (no via there) …
	lines.push({ primitiveId: 'S2x', net: 'SIG2', layer: 15, startX: 1700, startY: -800, endX: 1700, endY: -1100, lineWidth: 10 });
	vias = vias.filter((v) => v.primitiveId !== 'VB');
	r = await h['pcb.layer.moveTracks']({ trackIds: ['S2'], toLayer: 2 });
	assert.equal(r.status, 'refused', JSON.stringify(r));
	assert.ok(codes(r).includes('ORPHANED'));
	// … fixed by supplying a via at that end
	r = await h['pcb.layer.moveTracks']({ trackIds: ['S2'], toLayer: 2, vias: [{ x: 1700, y: -800 }] });
	assert.equal(r.status, 'dry-run', JSON.stringify(r));
	reset();
	// … and a branch landing mid-track
	lines.push({ primitiveId: 'S2b', net: 'SIG2', layer: 15, startX: 1000, startY: -800, endX: 1000, endY: -1000, lineWidth: 10 });
	r = await h['pcb.layer.moveTracks']({ trackIds: ['S2'], toLayer: 1 });
	assert.ok(codes(r).includes('ORPHANED'), 'S2b branches off S2 on L2_GND and would be cut off');
	reset();

	// --- obstacle on the target layer blocks ---
	lines.push({ primitiveId: 'X1', net: 'OTHER', layer: 1, startX: 1000, startY: -700, endX: 1000, endY: -900, lineWidth: 10 });
	r = await h['pcb.layer.moveTracks']({ trackIds: ['S2'], toLayer: 1, dryRun: false });
	assert.equal(r.status, 'blocked', JSON.stringify(r));
	assert.equal(r.blocking[0].id, 'X1');
	assert.equal(lineLayer('S2'), 15);
	reset();

	// --- PLANE_CUT warning when moving into a plane of another net ---
	r = await h['pcb.layer.moveTracks']({ trackIds: ['T3'], toLayer: 16 });
	assert.ok(codes(r).includes('PLANE_CUT'), JSON.stringify(r));

	// --- rollback on connectivity loss (pre-check disabled) ---
	r = await h['pcb.layer.moveTracks']({ trackIds: ['T1'], toLayer: 15, dryRun: false, endpointCheck: false });
	assert.equal(r.status, 'rolled-back', JSON.stringify(r));
	assert.deepEqual(r.verify.connectivity.worse, ['SIG1']);
	assert.equal(lineLayer('T1'), 1, 'restored');
	assert.equal(r.rollback.ok, true);

	// --- unknown target layer ---
	await assert.rejects(h['pcb.layer.moveTracks']({ trackIds: ['T1'], toLayer: 'Inner5' }), /not an active copper layer/);

	// --- a lightly routed outer pour on a 4-layer board is a flood, not a plane ---
	lines = lines.filter((l) => l.primitiveId !== 'T3');
	r = await h['pcb.layer.report']({ forceRefresh: true });
	assert.equal(r.layers.find((l: any) => l.id === 2).role, 'flood');
	assert.equal(r.layers.find((l: any) => l.id === 2).plane, undefined, 'outer flood cuts are not analysed on 4 layers');
	reset();

	// --- MCP side: slim layer status, routing of the new tools ---
	const { registerAnalysisTools } = await import('../src/mcp-server/tools/analysis-tools');
	const { registerPcbLayerTools } = await import('../src/mcp-server/tools/pcb-layer-tools');
	const tools: Record<string, (args: any) => Promise<any>> = {};
	const sent: Array<[string, any]> = [];
	const fakeServer = { tool: (name: string, _d: string, _s: unknown, fn: any) => { tools[name] = fn; } } as any;
	const fakeBridge = { send: async (method: string, params: any) => { sent.push([method, params]); return method === 'pcb.layer.getStatus' ? layerRows.map((x) => ({ ...x, locked: false, transparency: 0 })) : { ok: true }; } } as any;
	registerAnalysisTools(fakeServer, fakeBridge);
	registerPcbLayerTools(fakeServer, fakeBridge);
	const body = async (name: string, args: any) => JSON.parse((await tools[name](args)).content[0].text);
	const slim = await body('pcb_get_layer_status', { document: 'd' });
	assert.deepEqual(slim.layers.map((l: any) => l.id), [1, 2, 3, 11, 12, 15, 16]);
	assert.equal(slim.omitted, 30);
	assert.equal('locked' in slim.layers[0] || 'transparency' in slim.layers[0], false);
	assert.equal((await body('pcb_get_layer_status', { document: 'd', full: true })).length, layerRows.length);
	await body('pcb_layer_report', { document: 'd', detail: 'summary' });
	assert.deepEqual([sent.at(-1)![0], sent.at(-1)![1]._timeoutMs], ['pcb.layer.report', 120_000]);
	await body('pcb_manage_layers', { document: 'd', action: 'set_copper_count', count: 2, force: true });
	assert.deepEqual([sent.at(-1)![0], sent.at(-1)![1].force], ['pcb.layer.setCopperCount', true]);
	for (const name of ['pcb_set_copper_layer_count', 'pcb_set_inner_layer_type', 'pcb_move_tracks_to_layer']) assert.ok(tools[name], name);

	console.log('layer analysis: report numbers, plane cuts, split references, recommendations, guarded copper count + inner type, move tracks (dry-run, commit, pad/orphan refusal, vias, blocked, plane-cut warning, rollback) — passed.');
	process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
