// Routing consistency fixes (v2.1.13):
//   1. pours are plane-cut WARNINGS, not blockers (board-wide planes no longer
//      block every route);
//   2. pcb_batch_edit is transactional and always reports what is on the board;
//   3. connectivity comes from the real copper graph, not "has a track".
// Run: npx ts-node --transpile-only scripts/routing-consistency-smoke.ts
import assert from 'node:assert/strict';

const created: string[] = [];
const deletedLines: string[][] = [];
const modifies: Array<{ id: string; prop: any }> = [];
let viaCreateFails = false;
let seq = 0;
const component = { primitiveId: 'C1', x: 100, y: -100, rotation: 0 };
(globalThis as any).eda = {
	pcb_PrimitiveLine: {
		getAll: async () => [],
		create: async (net: string, layer: number, sx: number, sy: number, ex: number, ey: number, w: number) => {
			const id = `L${++seq}`; created.push(id);
			return { primitiveId: id, net, layer, startX: sx, startY: sy, endX: ex, endY: ey, lineWidth: w };
		},
		delete: async (ids: string[]) => { deletedLines.push(ids); return true; },
	},
	pcb_PrimitiveVia: {
		getAll: async () => [],
		create: async () => { if (viaCreateFails) throw new Error('via rejected by EasyEDA'); const id = `V${++seq}`; created.push(id); return { primitiveId: id }; },
		delete: async () => true,
	},
	pcb_PrimitivePad: { getAll: async () => [] },
	pcb_PrimitiveComponent: {
		getAll: async () => [],
		getAllPinsByPrimitiveId: async () => [],
		get: async () => ({ ...component }),
		modify: async (id: string, prop: any) => { modifies.push({ id, prop }); return true; },
	},
	// One bottom-layer GND pour spanning the whole board, like PCB_COMPACT.
	// Polygon sources are data space (Y down): canvas y=-1500 is stored as 1500.
	pcb_PrimitivePour: { getAll: async () => [{ primitiveId: 'PG', net: 'GND', layer: 2, pourName: 'BOTTOM_GND', polygon: [0, 0, 'L', 2000, 0, 2000, 1500, 0, 1500] }] },
	pcb_PrimitiveRegion: { getAll: async () => [] },
	pcb_Drc: { getCurrentRuleConfiguration: async () => undefined, getNetRules: async () => undefined },
};

(async () => {
	const { checkTraceObstacles } = await import('../src/extension/handlers/trace-obstacles');
	const { boardContextHandlers } = await import('../src/extension/handlers/board-context');
	const { analyzeConnectivity } = await import('../src/extension/handlers/net-connectivity');

	// --- 1. pours: plane-cut warning, opt-in blocker ---
	const seg = { net: 'SIG', layer: 2, startX: 100, startY: -100, endX: 500, endY: -100, lineWidth: 10 };
	let r: any = await checkTraceObstacles({ segments: [seg] });
	assert.equal(r.blockingObstacleCount, 0, JSON.stringify(r));
	assert.ok(r.obstacles.some((o: any) => o.type === 'pour' && o.severity === 'warning' && o.planeCut === true && /BOTTOM_GND/.test(o.reason)));
	r = await checkTraceObstacles({ segments: [seg], poursBlock: true });
	assert.equal(r.blockingObstacleCount, 1);

	// Keepout outlines are data space (Y down) too: stored y 200..300 is canvas
	// y -200..-300. Read raw, it would be mirrored onto the wrong half of the board.
	const eda = (globalThis as any).eda;
	eda.pcb_PrimitiveRegion.getAll = async () => [{ primitiveId: 'K1', layer: 2, ruleType: [5], regionName: 'NO_WIRES', polygon: [1000, 200, 'L', 1200, 200, 1200, 300, 1000, 300] }];
	const across = (y: number) => ({ net: 'SIG', layer: 2, startX: 900, startY: y, endX: 1300, endY: y, lineWidth: 10 });
	r = await checkTraceObstacles({ segments: [across(-250)], includePours: false });
	assert.ok(r.obstacles.some((o: any) => o.type === 'keepout' && o.severity !== 'warning'), 'keepout below the origin must block a canvas y=-250 trace: ' + JSON.stringify(r.obstacles));
	r = await checkTraceObstacles({ segments: [across(250)], includePours: false });
	assert.ok(!r.obstacles.some((o: any) => o.type === 'keepout'), 'mirrored position must be clear');
	eda.pcb_PrimitiveRegion.getAll = async () => [];

	// --- 2. batch edit: transactional, never loses the record ---
	const batch = boardContextHandlers['pcb.batch.edit'];
	const ops = [
		{ type: 'create_track', net: 'SIG', layer: 2, startX: 100, startY: -100, endX: 300, endY: -100, lineWidth: 10 },
		{ type: 'move_component', primitiveId: 'C1', x: 150, y: -120 },
		{ type: 'create_via', net: 'SIG', x: 300, y: -100 },
		{ type: 'create_track', net: 'SIG', layer: 1, startX: 300, startY: -100, endX: 500, endY: -100, lineWidth: 10 },
	];
	r = await batch({ operations: ops, dryRun: false });
	assert.equal(r.committed, true, JSON.stringify(r));
	assert.deepEqual(r.created.map((c: any) => c.type), ['track', 'via', 'track']);

	viaCreateFails = true; modifies.length = 0; deletedLines.length = 0;
	r = await batch({ operations: ops, dryRun: false });
	assert.equal(r.committed, false, JSON.stringify(r));
	assert.equal(r.rolledBack, true);
	assert.equal(r.failedAt.index, 2);
	assert.match(r.failedAt.error, /via rejected/);
	assert.equal(deletedLines.length, 1, 'the track created before the failure is removed');
	assert.deepEqual(modifies.at(-1), { id: 'C1', prop: { x: 100, y: -100 } }, 'moved component restored to its exact prior position');

	r = await batch({ operations: ops, dryRun: false, atomic: false });
	assert.equal(r.committed, 'partial');
	assert.equal(r.created.length, 1, 'non-atomic: reports exactly what stayed on the board');
	viaCreateFails = false;

	await assert.rejects(() => batch({ operations: [{ type: 'teleport' }], dryRun: false }), /unsupported operation type/);

	// Rip-up and reroute in one batch: copper being deleted does not block.
	const old = { primitiveId: 'OLD', net: 'X', layer: 2, startX: 200, startY: -200, endX: 200, endY: 0, lineWidth: 10 };
	(globalThis as any).eda.pcb_PrimitiveLine.getAll = async (_net: any, layer: any) => (layer == null || layer === 2 ? [old] : []);
	r = await batch({ operations: [{ type: 'create_track', net: 'SIG', layer: 2, startX: 100, startY: -100, endX: 300, endY: -100, lineWidth: 10 }] });
	assert.equal(r.reason, 'blocking_obstacles', 'a different-net track still blocks');
	r = await batch({ operations: [
		{ type: 'delete', primitiveType: 'track', ids: ['OLD'] },
		{ type: 'create_track', net: 'SIG', layer: 2, startX: 100, startY: -100, endX: 300, endY: -100, lineWidth: 10 },
	] });
	assert.notEqual(r.reason, 'blocking_obstacles', JSON.stringify(r.obstacleCheck?.obstacles));
	(globalThis as any).eda.pcb_PrimitiveLine.getAll = async () => [];

	// --- 3. connectivity: real copper graph ---
	const pad = (label: string, net: string, x: number, y: number, extra: any = {}) => ({ primitiveId: label, label, net, layer: 1, x, y, pad: ['RECT', 40, 20, 0], ...extra });
	const line = (net: string, layer: number, sx: number, sy: number, ex: number, ey: number) => ({ net, layer, startX: sx, startY: sy, endX: ex, endY: ey, lineWidth: 10 });
	const nets = analyzeConnectivity({
		componentPads: [
			pad('U1.1', 'A', 0, 0), pad('R1.1', 'A', 500, 0),                       // A: straight track
			pad('U1.2', 'B', 0, 100), pad('R2.1', 'B', 400, 100), pad('C1.1', 'B', 200, 300), // B: T-junction
			pad('U1.3', 'C', 0, 200), pad('R3.1', 'C', 600, 200),                   // C: stub only → incomplete
			pad('U1.4', 'D', 0, 400), pad('J1.1', 'D', 800, 400, { layer: 12, hole: ['ROUND', 20, 20] }), // D: top→via→bottom→THT
			pad('U1.5', 'GND', 0, 600), pad('U2.5', 'GND', 900, 600),               // GND: pour only
			pad('U1.6', 'E', 0, 700), pad('R4.1', 'E', 300, 700, { rotation: Math.PI / 2 }), // E: ends inside a rotated pad
			pad('U1.7', 'F', 0, 800),                                                 // F: single pad
		],
		standalonePads: [pad('U1.1', 'A', 0, 0)], // duplicate of a component pad: ignored
		lines: [
			line('A', 1, 0, 0, 500, 0),
			line('B', 1, 0, 100, 400, 100), line('B', 1, 200, 100, 200, 300),
			line('C', 1, 0, 200, 150, 200),
			line('D', 1, 0, 400, 400, 400), line('D', 2, 400, 400, 800, 400),
			line('E', 1, 0, 700, 295, 700),
		],
		vias: [{ net: 'D', x: 400, y: 400, diameter: 24 }],
		pours: [{ net: 'GND', layer: 2 }],
	});
	const st = (n: string) => nets.find((x) => x.net === n)!;
	assert.equal(st('A').status, 'connected');
	assert.equal(st('A').pads, 2, 'duplicated standalone pad not double-counted');
	assert.equal(st('B').status, 'connected', 'T-junction mid-track counts');
	assert.equal(st('C').status, 'incomplete', 'a stub is NOT routed');
	assert.deepEqual(st('C').padGroups, [['U1.3'], ['R3.1']]);
	assert.equal(st('D').status, 'connected', 'via joins top and bottom; drilled pad is on every layer');
	assert.equal(st('GND').status, 'pour_dependent', 'pour-only joins are never reported as connected');
	assert.equal(st('E').status, 'connected', 'track ending inside a rotated pad');
	assert.equal(st('F').status, 'single_pad');
	const floating = analyzeConnectivity({ componentPads: [pad('U9.1', 'G', 0, 0), pad('U9.2', 'G', 500, 0)], standalonePads: [], lines: [line('G', 1, 0, 0, 500, 0), line('G', 1, 2000, 2000, 2100, 2000)], vias: [], pours: [] });
	assert.equal(floating[0].status, 'connected');
	assert.equal(floating[0].floatingCopper, 1, 'a dangling segment elsewhere is reported');

	console.log('Routing consistency: pour plane-cut warnings, transactional batch edit, real copper-graph connectivity — passed.');
})().catch((err) => { console.error(err); process.exit(1); });
