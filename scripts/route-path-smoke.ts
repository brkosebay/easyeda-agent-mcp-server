// pcb_route_path — the model-planned route executor, against a stateful mock
// board. Run: npx ts-node --transpile-only scripts/route-path-smoke.ts
import assert from 'node:assert/strict';

let seq = 0;
let lines: any[] = [];
let vias: any[] = [];
let viaFails = false;
let createShift = 0; // simulate EasyEDA landing a track somewhere other than requested
let drcLeaves: any[] = [];
// Component pins report coordinates in 10-mil units (the snapshot scales ×10).
const pins: Record<string, any[]> = {
	cU1: [
		{ primitiveId: 'U1p1', padNumber: '1', net: 'SIG', layer: 1, x: 0, y: 0, pad: ['RECT', 20, 20, 0] },
		{ primitiveId: 'U1p2', padNumber: '2', net: 'GND', layer: 1, x: 0, y: -10, pad: ['RECT', 20, 20, 0] },
	],
	cR1: [{ primitiveId: 'R1p1', padNumber: '1', net: 'SIG', layer: 1, x: 50, y: 0, pad: ['RECT', 20, 20, 0] }],
	cJ1: [{ primitiveId: 'J1p1', padNumber: '1', net: 'SIG', layer: 2, x: 100, y: -40, pad: ['ELLIPSE', 30, 30] }],
};
(globalThis as any).eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'doc1', documentType: 3 }) },
	pcb_PrimitiveComponent: {
		getAll: async () => [
			{ primitiveId: 'cU1', designator: 'U1', x: 0, y: 0 },
			{ primitiveId: 'cR1', designator: 'R1', x: 500, y: 0 },
			{ primitiveId: 'cJ1', designator: 'J1', x: 1000, y: -400 },
		],
		getAllPinsByPrimitiveId: async (id: string) => pins[id] ?? [],
	},
	pcb_PrimitiveLine: {
		getAll: async (_n: any, layer: any) => (layer == null ? lines : lines.filter((l) => l.layer === layer)),
		create: async (net: string, layer: number, sx: number, sy: number, ex: number, ey: number, w: number) => {
			const l = { primitiveId: `L${++seq}`, net, layer, startX: sx, startY: sy + createShift, endX: ex, endY: ey + createShift, lineWidth: w };
			lines.push(l);
			return l;
		},
		delete: async (ids: string[]) => { lines = lines.filter((l) => !ids.includes(l.primitiveId)); return true; },
	},
	pcb_PrimitiveVia: {
		getAll: async () => vias,
		create: async (net: string, x: number, y: number, hole: number, diameter: number) => {
			if (viaFails) throw new Error('via rejected');
			const v = { primitiveId: `V${++seq}`, net, x, y, holeDiameter: hole, diameter };
			vias.push(v);
			return v;
		},
		delete: async (ids: string[]) => { vias = vias.filter((v) => !ids.includes(v.primitiveId)); return true; },
	},
	pcb_PrimitivePad: { getAll: async () => [] },
	pcb_PrimitivePour: { getAll: async () => [] },
	pcb_PrimitiveRegion: { getAll: async () => [] },
	pcb_PrimitivePolyline: { getAll: async () => [] },
	pcb_PrimitiveArc: { getAll: async () => [] },
	pcb_Layer: { getAllLayers: async () => [] },
	pcb_Net: { getAllNetsName: async () => ['SIG', 'GND', 'OTHER'] },
	pcb_Drc: {
		getCurrentRuleConfiguration: async () => undefined,
		getNetRules: async () => undefined,
		check: async () => (drcLeaves.length ? [{ name: 'Errors', list: drcLeaves }] : true),
	},
};

(async () => {
	const { routePathHandlers } = await import('../src/extension/handlers/route-path');
	const route = routePathHandlers['pcb.route.path'];
	const codes = (r: any) => (r.routes?.[0]?.issues ?? []).map((i: any) => i.code);

	// --- dry run: exact geometry, nothing created ---
	let r: any = await route({ from: 'U1.1', to: 'R1.1', width: 10 });
	assert.equal(r.status, 'dry-run', JSON.stringify(r));
	assert.deepEqual(r.routes[0].legs, [{ layer: 1, from: [0, 0], to: [500, 0] }]);
	assert.equal(r.routes[0].net, 'SIG', 'net inferred from both pads');
	assert.equal(lines.length, 0);

	// --- refusals, each with a code; nothing created ---
	assert.ok(codes(await route({ from: 'U1.1', to: 'R1.1' })).includes('WIDTH_REQUIRED'));
	assert.ok(codes(await route({ net: 'SIG', from: 'U1.2', to: 'R1.1', width: 10 })).includes('NET_MISMATCH'));
	assert.ok(codes(await route({ from: 'U1.1', to: 'R1.1', width: 10, points: [{ x: 100, y: -37 }] })).includes('NOT_OCTILINEAR'));
	assert.ok(codes(await route({ from: 'U1.1', to: 'R1.1', width: 10, points: [{ x: 300, y: 0 }, { x: 200, y: -100 }] })).includes('ACUTE_ANGLE'));
	assert.ok(codes(await route({ from: 'U1.1', to: 'J1.1', width: 10, points: [{ x: 600, y: 0 }] })).includes('LAYER_MISMATCH'), 'arriving on top at a bottom pad');
	assert.ok(codes(await route({ net: 'SIG', from: 'U1.1', to: { x: 0, y: 300, layer: 1 }, width: 10 })).includes('FREE_END'));
	assert.ok(codes(await route({ from: 'U9.9', to: 'R1.1', width: 10 })).includes('PAD_NOT_FOUND'));
	r = await route({ from: 'U1.1', to: 'R1.1' });
	assert.equal(r.status, 'invalid');
	assert.deepEqual(r.created, []);

	// --- blocked: names the leg, obstacle, gap and required clearance ---
	lines.push({ primitiveId: 'OBST', net: 'OTHER', layer: 1, startX: 250, startY: -50, endX: 250, endY: 50, lineWidth: 10 });
	r = await route({ from: 'U1.1', to: 'R1.1', width: 10, dryRun: false });
	assert.equal(r.status, 'blocked', JSON.stringify(r));
	assert.equal(r.obstacles.blocking[0].leg, 0);
	assert.equal(r.obstacles.blocking[0].net, 'OTHER');
	assert.equal(r.obstacles.blocking[0].primitiveId, 'OBST');
	assert.ok(r.obstacles.blocking[0].required > 0);
	assert.equal(lines.length, 1, 'nothing created');
	lines = [];

	// --- commit with a layer change: top → via → bottom pad, verified ---
	const viaRoute = { from: 'U1.1', to: 'J1.1', width: 10, via: { diameter: 24, holeDiameter: 12 }, points: [{ x: 600, y: 0, layer: 'BottomLayer' }] };
	r = await route({ ...viaRoute, dryRun: false });
	assert.equal(r.status, 'committed', JSON.stringify(r));
	assert.deepEqual(r.created.map((c: any) => c.type).sort(), ['track', 'track', 'via']);
	assert.equal(r.verify.routes[0].joined, true);
	assert.deepEqual(r.routes[0].vias, [{ at: [600, 0], diameter: 24, hole: 12 }]);
	assert.equal(lines.length, 2);

	// --- re-running the same plan reuses copper, never duplicates it ---
	r = await route({ ...viaRoute, dryRun: false });
	assert.equal(r.status, 'already-present', JSON.stringify(r));
	assert.equal(r.reused.length, 3);
	assert.equal(lines.length, 2);
	assert.equal(vias.length, 1);

	// --- requestId: a retry after a timeout replays the first outcome ---
	lines = []; vias = [];
	r = await route({ from: 'U1.1', to: 'R1.1', width: 10, dryRun: false, requestId: 'job-7' });
	assert.equal(r.status, 'committed');
	const again = await route({ from: 'U1.1', to: 'R1.1', width: 10, dryRun: false, requestId: 'job-7' });
	assert.equal(again.replayed, true);
	assert.deepEqual(again.created, r.created);
	assert.equal(lines.length, 1);
	lines = [];

	// --- mm units in, mm out ---
	r = await route({ from: 'U1.1', to: 'R1.1', width: 0.254, units: 'mm' });
	assert.deepEqual(r.routes[0].legs[0].to, [12.7, 0]);
	assert.equal(r.routes[0].width, 0.254);

	// --- a first point within snap distance merges into the pad centre ---
	r = await route({ from: 'U1.1', to: 'R1.1', width: 10, points: [{ x: 1, y: 1 }] });
	assert.equal(r.routes[0].from.snapped, 1.414);
	assert.deepEqual(r.routes[0].legs, [{ layer: 1, from: [0, 0], to: [500, 0] }]);

	// --- EasyEDA rejects part of the commit → everything this call made is removed ---
	viaFails = true;
	r = await route({ ...viaRoute, dryRun: false });
	assert.equal(r.status, 'rolled-back', JSON.stringify(r));
	assert.equal(lines.length, 0);
	viaFails = false;

	// --- trust, but verify: EasyEDA lands the copper elsewhere → rolled back ---
	createShift = 30;
	r = await route({ from: 'U1.1', to: 'R1.1', width: 10, dryRun: false });
	assert.equal(r.status, 'rolled-back', JSON.stringify(r));
	assert.equal(r.verify.routes[0].joined, false);
	assert.equal(lines.length, 0);
	createShift = 0;

	// --- DRC verify: stale connection errors don't count, real clearance errors do ---
	const connLeaf = (id: string) => ({ errorType: 'Connection Error', errorObjType: 'Track', objs: [id], globalIndex: 'err1' });
	const clearLeaf = (id: string) => ({ errorType: 'Clearance Error', errorObjType: 'Track', objs: [id], globalIndex: 'err2' });
	const idOfNext = () => `L${seq + 1}`;
	drcLeaves = [connLeaf(idOfNext())];
	r = await route({ from: 'U1.1', to: 'R1.1', width: 10, dryRun: false, verify: 'drc' });
	assert.equal(r.status, 'committed', JSON.stringify(r));
	assert.equal(r.verify.drc.newViolations, 0);
	assert.equal(r.verify.drc.staleConnectionErrors, 1);
	lines = [];
	drcLeaves = [clearLeaf(idOfNext())];
	r = await route({ from: 'U1.1', to: 'R1.1', width: 10, dryRun: false, verify: 'drc' });
	assert.equal(r.status, 'rolled-back', JSON.stringify(r));
	assert.equal(r.verify.drc.newViolations, 1);
	assert.equal(lines.length, 0);
	drcLeaves = [];

	// --- a blocked outcome is not replayed: the retry runs after the fix ---
	lines.push({ primitiveId: 'OBST2', net: 'OTHER', layer: 1, startX: 250, startY: -50, endX: 250, endY: 50, lineWidth: 10 });
	r = await route({ from: 'U1.1', to: 'R1.1', width: 10, dryRun: false, requestId: 'job-9' });
	assert.equal(r.status, 'blocked');
	lines = lines.filter((l) => l.primitiveId !== 'OBST2');
	r = await route({ from: 'U1.1', to: 'R1.1', width: 10, dryRun: false, requestId: 'job-9' });
	assert.equal(r.status, 'committed', 'retry after removing the obstacle really runs');
	assert.equal(r.replayed, undefined);
	lines = [];

	// --- from an all-layer terminal, a layered point is a via, never the start layer ---
	vias.push({ primitiveId: 'VX', net: 'SIG', x: 0, y: 0, diameter: 24, holeDiameter: 12 });
	assert.ok(codes(await route({ from: { via: 'VX' }, to: 'J1.1', width: 10, points: [{ x: 600, y: 0, layer: 2 }] })).includes('LAYER_REQUIRED'));
	r = await route({ from: { via: 'VX' }, to: 'J1.1', width: 10, layer: 1, points: [{ x: 600, y: 0, layer: 2 }] });
	assert.equal(r.status, 'dry-run', JSON.stringify(r));
	assert.equal(r.routes[0].vias.length, 1);
	vias = [];

	// --- widths/vias from the board rules: net-specific rule applies, board default is only quoted ---
	const physics = {
		Track: {
			default: { editName: 'default', unit: 'mil', isSetDefault: true, form: { strokeWidthMin: 5, strokeWidthDefault: 10, strokeWidthMax: 100 } },
			sigTrack: { editName: 'sigTrack', unit: 'mil', isSetDefault: false, form: { strokeWidthMin: 8, strokeWidthDefault: 12, strokeWidthMax: 50 } },
		},
		'Via Size': { default: { editName: 'default', unit: 'mil', isSetDefault: true, form: { viaOuterdiameterMin: 20, viaOuterdiameterDefault: 22, viaOuterdiameterMax: 400, viaInnerdiameterMin: 8, viaInnerdiameterDefault: 11, viaInnerdiameterMax: 250 } } },
	};
	const netRows = [
		{ type: 'net', name: 'SIG', 'Safe Spacing': 'default', Track: 'sigTrack', 'Via Size': 'default' },
		{ type: 'net', name: 'GND', 'Safe Spacing': 'default', Track: 'default', 'Via Size': 'default' },
	];
	(globalThis as any).eda.pcb_Drc.getCurrentRuleConfiguration = async () => ({ name: 'mil', Rule: { Physics: physics }, Net: netRows });
	(globalThis as any).eda.pcb_Drc.getNetRules = async () => netRows;
	r = await route({ from: 'U1.1', to: 'J1.1', points: [{ x: 600, y: 0, layer: 2 }] });
	assert.equal(r.status, 'dry-run', JSON.stringify(r.routes[0].issues));
	assert.equal(r.routes[0].width, 12, 'net-specific Track rule applied');
	assert.match(r.routes[0].widthSource, /sigTrack/);
	assert.deepEqual(r.routes[0].vias, [{ at: [600, 0], diameter: 22, hole: 11 }], 'via size from the Via Size rule');
	assert.ok(codes(await route({ from: 'U1.1', to: 'R1.1', width: 6 })).includes('WIDTH_BELOW_RULE'));
	const gnd = await route({ net: 'GND', from: { x: 0, y: -100, layer: 1 }, to: 'U1.2', allowFreeEnd: true });
	assert.ok(gnd.routes[0].issues.some((i: any) => i.code === 'WIDTH_REQUIRED' && /Board default Track rule: 10/.test(i.message)), JSON.stringify(gnd.routes[0].issues));
	(globalThis as any).eda.pcb_Drc.getCurrentRuleConfiguration = async () => undefined;
	(globalThis as any).eda.pcb_Drc.getNetRules = async () => undefined;

	// --- no time left to verify: committed-unverified, never a rollback or an overrun ---
	lines = []; vias = [];
	r = await route({ from: 'U1.1', to: 'R1.1', width: 10, dryRun: false, _gateDeadlineAt: Date.now() + 3_000 });
	assert.equal(r.status, 'committed-unverified', JSON.stringify(r));
	assert.equal(r.verify.skipped, 'deadline');
	assert.equal(lines.length, 1, 'copper kept');
	lines = [];

	// --- several routes, one transaction ---
	r = await route({ width: 10, dryRun: false, routes: [{ from: 'U1.1', to: 'R1.1' }, { ...viaRoute }] });
	assert.equal(r.status, 'committed', JSON.stringify(r));
	assert.equal(r.verify.routes.length, 2);
	assert.ok(r.verify.routes.every((x: any) => x.joined));

	console.log('pcb_route_path: dry-run, refusals, blocked report, via commit, reuse, requestId replay, mm, snap, rollback on failure, verify-rollback, DRC classification, multi-route — passed.');
	process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
