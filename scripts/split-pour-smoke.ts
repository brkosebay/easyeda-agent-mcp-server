// Split planes (pcb_plan_split_pours / pcb_create_split_pours) against a mock
// board: 1000×600 mil outline, +3V3 parts on the left, GND parts on the right.
// Run: npx ts-node --transpile-only scripts/split-pour-smoke.ts
import assert from 'node:assert/strict';

const g = globalThis as any;
let seq = 0;
let pours: any[] = [];
let createCalls = 0;
let createFailOn = 0; // the Nth create call throws
let createStoresVerbatim = false; // a build whose create consumes data space
let copperReadable = true;
const copper = new Map<string, string[]>();

const outline = [
	[0, 0, 1000, 0], [1000, 0, 1000, -600], [1000, -600, 0, -600], [0, -600, 0, 0],
].map(([sx, sy, ex, ey], i) => ({ primitiveId: `O${i}`, layer: 11, startX: sx, startY: sy, endX: ex, endY: ey, lineWidth: 10 }));
// Component pins report coordinates in 10-mil units (the snapshot scales ×10).
const pins: Record<string, any[]> = {
	cU1: [
		{ primitiveId: 'U1p1', padNumber: '1', net: '+3V3', layer: 1, x: 20, y: -30, pad: ['RECT', 20, 20, 0] },
		{ primitiveId: 'U1p2', padNumber: '2', net: '+3V3', layer: 12, x: 30, y: -30, pad: ['ELLIPSE', 60, 60], hole: ['ROUND', 3.5, 3.5] },
	],
	cJ1: [
		{ primitiveId: 'J1p1', padNumber: '1', net: 'GND', layer: 1, x: 70, y: -30, pad: ['RECT', 20, 20, 0] },
		{ primitiveId: 'J1p2', padNumber: '2', net: 'GND', layer: 12, x: 80, y: -30, pad: ['ELLIPSE', 60, 60], hole: ['ROUND', 3.5, 3.5] },
	],
	cS1: [{ primitiveId: 'S1p1', padNumber: '1', net: 'SIG', layer: 1, x: 60, y: -20, pad: ['RECT', 20, 20, 0] }],
	cB1: [{ primitiveId: 'B1p1', padNumber: '1', net: '+3V3', layer: 2, x: 40, y: -10, pad: ['RECT', 20, 20, 0] }], // bottom SMD: not on TopLayer
};
const vias = [
	{ primitiveId: 'V3', net: '+3V3', x: 150, y: -500, diameter: 24, holeDiameter: 12 },
	{ primitiveId: 'VG', net: 'GND', x: 750, y: -500, diameter: 24, holeDiameter: 12 },
];
const layers = [
	{ id: 1, name: 'TopLayer', type: 'SIGNAL' },
	{ id: 2, name: 'BottomLayer', type: 'SIGNAL' },
	{ id: 15, name: 'Inner1', type: 'PLANE' },
	{ id: 16, name: 'Inner2', type: 'SIGNAL' },
];

/** Polygon source [x,y,'L',x,y,...] with every Y negated (canvas ↔ data space here). */
const negY = (src: any[]) => {
	let n = 0;
	return src.map((v) => (typeof v === 'number' ? (n++ % 2 === 1 ? -v : v) : v));
};
const wrap = (src: any[]) => ({ getSource: () => src });

g.eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'doc1', documentType: 3 }) },
	pcb_Document: { convertDataOriginToCanvasOrigin: async (x: number, y: number) => ({ x, y }) },
	pcb_MathPolygon: { createPolygon: (src: any[]) => ({ src, getSource: () => src }) },
	pcb_PrimitiveComponent: {
		getAll: async () => [
			{ primitiveId: 'cU1', designator: 'U1', x: 250, y: -300 },
			{ primitiveId: 'cJ1', designator: 'J1', x: 750, y: -300 },
			{ primitiveId: 'cS1', designator: 'S1', x: 600, y: -200 },
			{ primitiveId: 'cB1', designator: 'B1', x: 400, y: -100 },
		],
		getAllPinsByPrimitiveId: async (id: string) => pins[id] ?? [],
	},
	pcb_PrimitiveLine: { getAll: async (_n: any, layer: any) => (layer == null ? outline : outline.filter((l) => l.layer === layer)) },
	pcb_PrimitiveVia: { getAll: async () => vias },
	pcb_PrimitivePad: { getAll: async () => [] },
	pcb_PrimitiveRegion: { getAll: async () => [] },
	pcb_PrimitivePolyline: { getAll: async () => [] },
	pcb_PrimitiveArc: { getAll: async () => [] },
	pcb_Layer: { getAllLayers: async () => layers },
	pcb_Net: { getAllNetsName: async () => ['+3V3', 'GND', 'SIG'], getNetLength: async () => 0 },
	pcb_Drc: { getCurrentRuleConfiguration: async () => undefined, getNetRules: async () => undefined },
	pcb_PrimitivePour: {
		getAllPrimitiveId: async () => pours.map((p) => p.primitiveId),
		getAll: async (net?: string, layer?: number) => pours.filter((p) => (net == null || p.net === net) && (layer == null || p.layer === layer)),
		get: async (ids: any) => (Array.isArray(ids) ? pours.filter((p) => ids.includes(p.primitiveId)) : pours.find((p) => p.primitiveId === ids)),
		create: async (net: string, layer: number, polygon: any, fill: any, silos: any, name: string, priority: any) => {
			createCalls++;
			if (createCalls === createFailOn) throw new Error('fill engine rejected the polygon');
			// EasyEDA stores pour outlines in data space (Y down) unless this build takes data space verbatim.
			const p = { primitiveId: `P${++seq}`, net, layer, pourName: name, pourPriority: priority, pourFillMethod: fill, preserveSilos: silos, primitiveLock: false, complexPolygon: wrap(createStoresVerbatim ? polygon.src : negY(polygon.src)) };
			pours.push(p);
			return p;
		},
		delete: async (ids: any) => { const list = Array.isArray(ids) ? ids : [ids]; pours = pours.filter((p) => !list.includes(p.primitiveId)); return true; },
		modify: async (id: string, prop: any) => { const p = pours.find((x) => x.primitiveId === id); if (p) Object.assign(p, prop); return p; },
	},
};

// Host UI bridge: native rebuild ('rebuildSingleCopper') + the editor's copper store.
const listeners = new Map<string, Set<(m: unknown) => void>>();
const emit = (topic: string, message: unknown) => { for (const fn of listeners.get(topic) ?? []) fn(message); };
const ring = (minX: number, minY: number, maxX: number, maxY: number) => [minX, minY, 'L', maxX, minY, maxX, maxY, minX, maxY];
const applyRebuild = (ids: string[]) => {
	for (const id of ids) {
		const pour = pours.find((p) => p.primitiveId === id);
		if (!pour) continue;
		const src: any[] = pour.complexPolygon.getSource();
		const nums = src.filter((v) => typeof v === 'number');
		const xs = nums.filter((_, i) => i % 2 === 0);
		const ys = nums.filter((_, i) => i % 2 === 1);
		// Copper paths are in data space like pour sources: inset 30 mil from the outline.
		const islands = [ring(Math.min(...xs) + 30, Math.min(...ys) + 30, Math.max(...xs) - 30, Math.max(...ys) - 30)];
		if (pour.net === 'GND') islands.push(ring(975, 10, 990, 25)); // a floating sliver in the GND half
		copper.set(id, islands.map((path, k) => JSON.stringify(['POURED', `f${id}_${k}`, id, 0, true, [path]])));
	}
};
g.UI = {
	tabBar: { getActiveTab: () => 'doc1@proj', getTabIFrame: async () => ({ contentWindow: { frame: 'pcb' } }) },
	gVars: {
		messageBus: {
			subscribe: (topic: string, fn: (m: unknown) => void) => {
				if (!listeners.has(topic)) listeners.set(topic, new Set());
				listeners.get(topic)!.add(fn);
				return { cancel: () => listeners.get(topic)!.delete(fn) };
			},
		},
		windowBridge: {
			rpcCall: async (topic: string) => {
				assert.equal(topic, 'CopperSource');
				if (!copperReadable) throw new Error('rpc timeout');
				return { message: ['["DOCTYPE","POURED","1.1"] ' + [...copper.values()].flat().join(' ')] };
			},
			publish: (topic: string, message: any) => {
				if (topic !== 'rebuildSingleCopper') return;
				setTimeout(() => emit('pcbUpdateProgress', { ratio: 0, descripte: 'copper' }), 30);
				setTimeout(() => { applyRebuild(message.ids); emit('setPcbTabUnSaved', ['doc1@proj', true]); }, 150);
			},
		},
	},
};

const codes = (r: any) => r.issues.map((i: any) => i.code);
const plain = (o: any) => JSON.parse(JSON.stringify(o));
const reset = () => { pours = []; copper.clear(); createCalls = 0; createFailOn = 0; createStoresVerbatim = false; copperReadable = true; };

(async () => {
	const { splitPourHandlers, clipHalfPlane } = await import('../src/extension/handlers/split-pour');
	const { invalidateBoardSnapshotCache } = await import('../src/extension/handlers/board-context');
	const plan = splitPourHandlers['pcb.splitPour.plan'];
	const create = splitPourHandlers['pcb.splitPour.create'];
	const split = { axis: 'x', at: 500, nets: ['+3V3', 'GND'] };

	// --- clip helper: half-plane cut of the outline ---
	const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
	assert.deepEqual(clipHalfPlane(sq, 'x', 4, true), [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 10 }, { x: 0, y: 10 }]);

	// --- 1. plan a 2-region split: +3V3 left, GND right, correct pad coverage ---
	let r: any = await plan({ layer: 'TopLayer', split });
	assert.equal(r.status, 'dry-run', JSON.stringify(r.issues));
	assert.equal(r.summary.errors, 0, JSON.stringify(r.issues));
	assert.equal(r.gapMil, 6, 'gap defaults to the board clearance (6-mil fallback without rules)');
	assert.deepEqual(r.regions.map((x: any) => x.net), ['+3V3', 'GND']);
	assert.deepEqual(r.regions[0].bbox, { minX: 0, minY: -600, maxX: 497, maxY: 0 });
	assert.deepEqual(r.regions[1].bbox, { minX: 503, minY: -600, maxX: 1000, maxY: 0 });
	assert.deepEqual(r.regions[0].terminals.ownSample.sort(), ['U1.1', 'U1.2', 'via:V3']);
	assert.deepEqual(r.regions[1].terminals.ownSample.sort(), ['J1.1', 'J1.2', 'via:VG']);
	assert.equal(r.regions[1].terminals.otherNets, 1, 'SIG pad: the GND pour clears around it');
	assert.deepEqual(plain(r.nets['+3V3']), { onLayer: 3, served: 3, unserved: 0 }, 'bottom-layer SMD pad B1.1 is not on TopLayer');
	assert.equal(r.regions[0].boardOutline, 'inside');
	assert.deepEqual(r.created, []);
	assert.equal(r.verify, null);

	// --- 2. a +3V3 pad sitting in the GND region ---
	pins.cJ1.push({ primitiveId: 'J1p3', padNumber: '3', net: '+3V3', layer: 1, x: 90, y: -10, pad: ['RECT', 20, 20, 0] });
	invalidateBoardSnapshotCache();
	r = await plan({ layer: 'TopLayer', split });
	const foreign = r.issues.find((i: any) => i.code === 'PAD_IN_FOREIGN_REGION');
	assert.ok(foreign, JSON.stringify(r.issues));
	assert.equal(foreign.region, 1);
	assert.deepEqual(foreign.items.map((i: any) => i.label), ['J1.3']);
	assert.deepEqual(plain(r.nets['+3V3']), { onLayer: 4, served: 3, unserved: 1, unservedSample: ['J1.3'] });
	pins.cJ1.pop();
	invalidateBoardSnapshotCache();

	// --- 3. gap violation, overlap, priority-resolved overlap, nested island ---
	const left = { net: '+3V3', rect: { minX: 0, minY: -600, maxX: 500, maxY: 0 } };
	r = await plan({ layer: 1, gapMil: 10, regions: [left, { net: 'GND', rect: { minX: 502, minY: -600, maxX: 1000, maxY: 0 } }] });
	assert.ok(codes(r).includes('GAP_TOO_SMALL'), JSON.stringify(r.issues));
	assert.match(r.issues.find((i: any) => i.code === 'GAP_TOO_SMALL').message, /2 mil apart \(gap 10 mil required/);
	r = await create({ layer: 1, gapMil: 10, regions: [left, { net: 'GND', rect: { minX: 502, minY: -600, maxX: 1000, maxY: 0 } }] });
	assert.equal(r.status, 'invalid');
	assert.equal(pours.length, 0, 'invalid plan writes nothing');
	const overlapping = [{ ...left, rect: { ...left.rect, maxX: 600 } }, { net: 'GND', rect: { minX: 400, minY: -600, maxX: 1000, maxY: 0 } }];
	assert.ok(codes(await plan({ layer: 1, regions: overlapping })).includes('REGIONS_OVERLAP'));
	r = await plan({ layer: 1, regions: [{ ...overlapping[0], priority: 1 }, { ...overlapping[1], priority: 2 }] });
	assert.equal(r.summary.errors, 0, JSON.stringify(r.issues));
	assert.ok(codes(r).includes('OVERLAP_RESOLVED_BY_PRIORITY'));
	const island = { net: '+3V3', rect: { minX: 100, minY: -560, maxX: 350, maxY: -200 } };
	const ground = { net: 'GND', rect: { minX: 0, minY: -600, maxX: 1000, maxY: 0 } };
	assert.ok(codes(await plan({ layer: 1, regions: [ground, island] })).includes('REGIONS_OVERLAP'), 'nested without priorities is refused');
	r = await plan({ layer: 1, regions: [{ ...ground, priority: 2 }, { ...island, priority: 1 }] });
	assert.equal(r.summary.errors, 0, JSON.stringify(r.issues));
	assert.deepEqual(plain(r.nets['+3V3']), { onLayer: 3, served: 3, unserved: 0 }, 'pads inside the nested island are served by it, not foreign to GND');
	assert.ok(!codes(r).includes('PAD_IN_FOREIGN_REGION'));
	r = await plan({ layer: 1, regions: [{ net: 'SIG', rect: { minX: 900, minY: -580, maxX: 980, maxY: -520 } }] });
	assert.ok(codes(r).includes('REGION_HAS_NO_OWN_TERMINALS'), 'dead-copper region flagged');
	assert.ok(codes(await plan({ layer: 1, regions: [{ net: 'GND', rect: { minX: 2000, minY: 0, maxX: 2100, maxY: 100 } }] })).includes('REGION_OFF_BOARD'));

	// --- 4. PLANE layers are refused with the fix ---
	r = await plan({ layer: 'Inner1', split });
	assert.equal(r.layerType, 'PLANE');
	assert.ok(codes(r).includes('LAYER_IS_PLANE'));
	assert.match(r.issues.find((i: any) => i.code === 'LAYER_IS_PLANE').message, /SIGNAL/);

	// --- 5. transactional rollback when the second create fails ---
	reset();
	createFailOn = 2;
	r = await create({ layer: 'TopLayer', split });
	assert.equal(r.status, 'rolled-back', JSON.stringify(r.issues));
	assert.ok(codes(r).includes('CREATE_FAILED'));
	assert.equal(r.rolledBack.deleted.length, 1);
	assert.equal(pours.length, 0, 'the first pour was removed again');
	assert.equal(r.rebuild, null);

	// --- 6. committed: created, priorities, native rebuild, copper read back per pour ---
	reset();
	r = await create({ layer: 'TopLayer', split: { ...split, priorities: [1, 2] } });
	assert.equal(r.status, 'committed', JSON.stringify({ issues: r.issues, rebuild: r.rebuild, verify: r.verify }));
	assert.equal(pours.length, 2);
	assert.deepEqual(r.regions.map((x: any) => x.outlineCheck), ['verified', 'verified'], 'Y-down read-back maps onto the requested canvas outline');
	assert.deepEqual(pours.map((p) => p.pourPriority), [1, 2]);
	assert.equal(r.rebuild.status, 'completed');
	assert.equal(r.verify.copper, 'verified');
	assert.equal(r.verify.coordinateMapping, 'data→canvas affine');
	const [v3, vg] = r.verify.pours;
	assert.deepEqual([v3.net, v3.islands, v3.reached, v3.ownTerminals, v3.deadIslands], ['+3V3', 1, 3, 3, 0]);
	assert.deepEqual([vg.net, vg.islands, vg.reached, vg.ownTerminals, vg.deadIslands], ['GND', 2, 3, 3, 1]);
	assert.deepEqual(plain(r.regions[1].copper), { islands: 2, reached: 3, ownTerminals: 3, deadIslands: 1 });

	// --- 7. a build whose create takes data space: detected and redone ---
	reset();
	createStoresVerbatim = true;
	r = await create({ layer: 'TopLayer', split });
	assert.equal(r.status, 'committed', JSON.stringify(r.issues));
	assert.equal(pours.length, 2, 'the mis-placed first attempt was deleted');
	assert.ok(r.created.every((c: any) => c.space === 'data' && c.outlineCheck === 'verified'));
	assert.ok(r.notes.some((n: string) => /consumed data-space/.test(n)));

	// --- 8. copper unreadable → committed-unverified, never "committed" ---
	reset();
	copperReadable = false;
	r = await create({ layer: 'TopLayer', split });
	assert.equal(r.status, 'committed-unverified', JSON.stringify(r.verify));
	assert.equal(r.verify.copper, 'unverified');
	assert.equal(pours.length, 2, 'pours are kept');

	// --- 9. existing pour on the layer: warned, or replaced when explicit ---
	reset();
	pours.push({ primitiveId: 'OLD', net: 'GND', layer: 1, pourName: 'gnd_full', pourPriority: 1, primitiveLock: false, complexPolygon: wrap(negY(ring(0, 0, 1000, -600))) });
	r = await plan({ layer: 'TopLayer', split });
	assert.ok(codes(r).includes('EXISTING_POUR_OVERLAPS'), JSON.stringify(r.issues));
	r = await create({ layer: 'TopLayer', split, replaceExisting: true });
	assert.equal(r.status, 'committed', JSON.stringify(r.issues));
	assert.deepEqual(r.deleted, ['OLD']);
	assert.ok(!pours.some((p) => p.primitiveId === 'OLD'));
	assert.equal(pours.length, 2);

	console.log('split pours: clip, 2-region plan + coverage, foreign pad, gap/overlap/priority/nested, PLANE refusal, rollback, committed copper read-back, data-space create, unverified copper, replaceExisting — passed.');
	process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
