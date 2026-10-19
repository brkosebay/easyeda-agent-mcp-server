// pcb_move_via — move a via and drag its attached track ends, against a
// stateful mock board. Run: npx ts-node --transpile-only scripts/move-via-smoke.ts
import assert from 'node:assert/strict';

let lines: any[] = [];
let vias: any[] = [];
let arcs: any[] = [];
const noopIds = new Set<string>(); // modify returns success but changes nothing
const failIds = new Set<string>(); // modify throws

// Component pins report coordinates in 10-mil units (the snapshot scales ×10).
// SIG: U1.1 (top, 0,0) —T1(top)— V1 (500,0) —T2(bottom)— J1.1 (bottom, 1000,0).
const pins: Record<string, any[]> = {
	cU1: [{ primitiveId: 'U1p1', padNumber: '1', net: 'SIG', layer: 1, x: 0, y: 0, pad: ['RECT', 20, 20, 0] }],
	cJ1: [{ primitiveId: 'J1p1', padNumber: '1', net: 'SIG', layer: 2, x: 100, y: 0, pad: ['ELLIPSE', 30, 30] }],
};

function reset(): void {
	lines = [
		{ primitiveId: 'T1', net: 'SIG', layer: 1, startX: 0, startY: 0, endX: 500, endY: 0, lineWidth: 10 },
		// Starts 2 mil off the via centre: the offset must be preserved.
		{ primitiveId: 'T2', net: 'SIG', layer: 2, startX: 502, startY: 0, endX: 1000, endY: 0, lineWidth: 10 },
		// Same net, ends 13 mil from the centre (radius 12): not attached, stays put.
		{ primitiveId: 'T3', net: 'SIG', layer: 1, startX: 513, startY: 0, endX: 513, endY: -100, lineWidth: 10 },
	];
	vias = [{ primitiveId: 'V1', net: 'SIG', x: 500, y: 0, diameter: 24, holeDiameter: 12 }];
	arcs = [];
	noopIds.clear();
	failIds.clear();
}

function modify(list: any[], id: string, props: Record<string, number>): any {
	if (failIds.has(id)) throw new Error(`modify rejected for ${id}`);
	const p = list.find((x) => x.primitiveId === id);
	if (!p) return undefined;
	if (!noopIds.has(id)) Object.assign(p, props);
	return p;
}

(globalThis as any).eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'doc1', documentType: 3 }) },
	pcb_PrimitiveComponent: {
		getAll: async () => [
			{ primitiveId: 'cU1', designator: 'U1', x: 0, y: 0 },
			{ primitiveId: 'cJ1', designator: 'J1', x: 1000, y: 0 },
		],
		getAllPinsByPrimitiveId: async (id: string) => pins[id] ?? [],
	},
	pcb_PrimitiveLine: {
		get: async (id: string) => lines.find((l) => l.primitiveId === id),
		getAll: async (net: any, layer: any) => lines.filter((l) => (net == null || l.net === net) && (layer == null || l.layer === layer)),
		modify: async (id: string, props: any) => modify(lines, id, props),
	},
	pcb_PrimitiveVia: {
		get: async (id: string) => vias.find((v) => v.primitiveId === id),
		getAll: async () => vias,
		modify: async (id: string, props: any) => modify(vias, id, props),
	},
	pcb_PrimitiveArc: { getAll: async () => arcs },
	pcb_PrimitivePad: { getAll: async () => [] },
	pcb_PrimitivePour: { getAll: async () => [] },
	pcb_PrimitiveRegion: { getAll: async () => [] },
	pcb_PrimitivePolyline: { getAll: async () => [] },
	pcb_Layer: { getAllLayers: async () => [] },
	pcb_Net: { getAllNetsName: async () => ['SIG', 'OTHER'], getNetLength: async () => 0 },
	pcb_Drc: {
		getCurrentRuleConfiguration: async () => undefined,
		getNetRules: async () => undefined,
	},
};

const line = (id: string) => lines.find((l) => l.primitiveId === id);
const codes = (list: any[] | undefined) => (list ?? []).map((i: any) => i.code);
const assertUntouched = () => {
	assert.deepEqual([vias[0].x, vias[0].y], [500, 0], 'via unchanged');
	assert.deepEqual([line('T1').endX, line('T1').endY], [500, 0], 'T1 unchanged');
	assert.deepEqual([line('T2').startX, line('T2').startY], [502, 0], 'T2 unchanged');
};

(async () => {
	const { viaHandlers } = await import('../src/extension/handlers/via');
	const move = viaHandlers['pcb.via.moveWithTracks'];
	let r: any;

	// --- dry run (default): exact drag plan, nothing changes ---
	reset();
	r = await move({ viaId: 'V1', x: 500, y: 500 });
	assert.equal(r.status, 'dry-run', JSON.stringify(r));
	assert.deepEqual(r.via, { id: 'V1', net: 'SIG', from: { x: 500, y: 0 }, to: { x: 500, y: 500 } });
	assert.deepEqual(r.dragged, [
		{ trackId: 'T1', end: 'end', from: { x: 500, y: 0 }, to: { x: 500, y: 500 }, layer: 1 },
		{ trackId: 'T2', end: 'start', from: { x: 502, y: 0 }, to: { x: 502, y: 500 }, layer: 2 },
	], 'both layers dragged, offset preserved, T3 (outside the radius) not dragged');
	assert.equal(r.verify, null);
	assert.deepEqual(r.warnings, []);
	assertUntouched();

	// --- a leg that stops being 45°-multiple is a warning, not a refusal ---
	r = await move({ viaId: 'V1', x: 500, y: 300 });
	assert.equal(r.status, 'dry-run');
	assert.ok(codes(r.warnings).includes('NOT_OCTILINEAR'), JSON.stringify(r.warnings));

	// --- commit: via + both track ends move, unattached same-net track stays ---
	r = await move({ viaId: 'V1', x: 500, y: 500, dryRun: false });
	assert.equal(r.status, 'moved', JSON.stringify(r));
	assert.deepEqual([vias[0].x, vias[0].y], [500, 500]);
	assert.deepEqual([line('T1').startX, line('T1').startY, line('T1').endX, line('T1').endY], [0, 0, 500, 500]);
	assert.deepEqual([line('T2').startX, line('T2').startY, line('T2').endX, line('T2').endY], [502, 500, 1000, 0]);
	assert.deepEqual([line('T3').startX, line('T3').startY, line('T3').endX, line('T3').endY], [513, 0, 513, -100], 'unattached track untouched');
	assert.equal(r.verify.readBack.ok, true);
	assert.equal(r.verify.connectivity.ok, true);
	assert.equal(r.verify.connectivity.before.status, 'connected');
	assert.equal(r.verify.connectivity.after.status, 'connected');

	// --- different-net obstacle on a moved leg: blocked, nothing changes ---
	reset();
	lines.push({ primitiveId: 'OBST', net: 'OTHER', layer: 1, startX: 200, startY: 300, endX: 300, endY: 200, lineWidth: 10 });
	r = await move({ viaId: 'V1', x: 500, y: 500, dryRun: false });
	assert.equal(r.status, 'blocked', JSON.stringify(r));
	assert.equal(r.obstacles.blocking.length, 1);
	assert.equal(r.obstacles.blocking[0].on, 'track T1');
	assert.equal(r.obstacles.blocking[0].net, 'OTHER');
	assert.equal(r.obstacles.blocking[0].primitiveId, 'OBST');
	assert.ok(r.obstacles.blocking[0].required > 0);
	assertUntouched();

	// --- the via disc sees top-layer copper even with no dragged top leg ---
	reset();
	lines.push({ primitiveId: 'OB2', net: 'OTHER', layer: 1, startX: 400, startY: 500, endX: 600, endY: 500, lineWidth: 10 });
	r = await move({ viaId: 'V1', x: 500, y: 500, dragTracks: false });
	assert.equal(r.status, 'blocked', JSON.stringify(r));
	assert.deepEqual(r.obstacles.blocking.map((b: any) => [b.on, b.primitiveId]), [['via', 'OB2']], 'one entry despite the per-layer discs');
	assert.deepEqual(r.dragged, []);
	assert.ok(codes(r.warnings).filter((c) => c === 'DETACHED').length === 2);
	assertUntouched();

	// --- EasyEDA silently no-ops a modify → read-back fails → everything restored ---
	reset();
	noopIds.add('T2');
	r = await move({ viaId: 'V1', x: 500, y: 500, dryRun: false });
	assert.equal(r.status, 'rolled-back', JSON.stringify(r));
	assert.equal(r.verify.readBack.ok, false);
	assert.ok(r.verify.readBack.mismatches.every((m: any) => m.id === 'T2'));
	assert.equal(r.rollback.ok, true);
	assertUntouched();

	// --- EasyEDA throws on a modify → restored, failedAt names it ---
	reset();
	failIds.add('T2');
	r = await move({ viaId: 'V1', x: 500, y: 500, dryRun: false });
	assert.equal(r.status, 'rolled-back', JSON.stringify(r));
	assert.equal(r.failedAt.id, 'T2');
	assert.equal(r.rollback.ok, true);
	assertUntouched();

	// --- the restore itself fails → 'partial', never a false 'rolled-back' ---
	reset();
	noopIds.add('T2');
	const realModify = (globalThis as any).eda.pcb_PrimitiveLine.modify;
	let forward = true;
	(globalThis as any).eda.pcb_PrimitiveLine.modify = async (id: string, props: any) => {
		if (!forward && id === 'T1') throw new Error('locked by another editor');
		return realModify(id, props);
	};
	(globalThis as any).eda.pcb_PrimitiveLine.get = (orig => async (id: string) => {
		const got = await orig(id);
		if (id === 'T2') forward = false; // read-back has started: later modifies are restores
		return got;
	})((globalThis as any).eda.pcb_PrimitiveLine.get);
	r = await move({ viaId: 'V1', x: 500, y: 500, dryRun: false });
	assert.equal(r.status, 'partial', JSON.stringify(r));
	assert.equal(r.rollback.ok, false);
	assert.ok(r.rollback.errors.some((e: string) => e.includes('T1')));
	(globalThis as any).eda.pcb_PrimitiveLine.modify = realModify;
	(globalThis as any).eda.pcb_PrimitiveLine.get = async (id: string) => lines.find((l) => l.primitiveId === id);

	// --- moving the via alone splits the net → verify fails → restored ---
	reset();
	r = await move({ viaId: 'V1', x: 500, y: 500, dryRun: false, dragTracks: false });
	assert.equal(r.status, 'rolled-back', JSON.stringify(r));
	assert.equal(r.verify.connectivity.ok, false);
	assert.equal(r.verify.connectivity.before.padGroups, 1);
	assert.equal(r.verify.connectivity.after.padGroups, 2);
	assertUntouched();
	r = await move({ viaId: 'V1', x: 500, y: 500, dryRun: false, dragTracks: false, keepOnVerifyFail: true });
	assert.equal(r.status, 'moved');
	assert.ok(codes(r.warnings).includes('VERIFY_FAILED_KEPT'));
	assert.deepEqual([vias[0].x, vias[0].y], [500, 500]);

	// --- mm in, mm out ---
	reset();
	r = await move({ viaId: 'V1', x: 12.7, y: 12.7, units: 'mm' });
	assert.equal(r.status, 'dry-run', JSON.stringify(r));
	assert.deepEqual(r.via.from, { x: 12.7, y: 0 });
	assert.deepEqual(r.via.to, { x: 12.7, y: 12.7 });
	assert.deepEqual(r.dragged[0].to, { x: 12.7, y: 12.7 });
	assert.deepEqual(r.dragged[1].from, { x: 12.7508, y: 0 });
	r = await move({ viaId: 'V1', x: 12.7, y: 12.7, units: 'mm', dryRun: false });
	assert.equal(r.status, 'moved', JSON.stringify(r));
	assert.ok(Math.abs(vias[0].y - 500) < 1e-9);

	// --- refusals: attached arc, already there, unknown via, collapsing leg ---
	reset();
	arcs.push({ primitiveId: 'A1', net: 'SIG', layer: 1, startX: 500, startY: 0, endX: 600, endY: 100, lineWidth: 10 });
	r = await move({ viaId: 'V1', x: 500, y: 500 });
	assert.equal(r.status, 'invalid');
	assert.ok(codes(r.errors).includes('ARC_ATTACHED'));
	arcs = [];
	assert.ok(codes((await move({ viaId: 'V1', x: 500, y: 0 })).errors).includes('ALREADY_AT_TARGET'));
	assert.ok(codes((await move({ viaId: 'NOPE', x: 1, y: 1 })).errors).includes('VIA_NOT_FOUND'));
	r = await move({ viaId: 'V1', x: 0.5, y: 0, dryRun: false });
	assert.equal(r.status, 'invalid');
	assert.ok(codes(r.errors).includes('TOO_SHORT'));
	assertUntouched();

	console.log('pcb_move_via: dry-run drag plan, offset preserved, octilinear warning, commit + verify, blocked by leg and by via disc, no-op rollback, throw rollback, partial restore, connectivity rollback/keep, mm, refusals — passed.');
	process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
