// pcb_length_tune — meander sized to the requested delta, verified by the
// measured copper path, against a stateful mock board.
// Run: npx ts-node --transpile-only scripts/length-tune-smoke.ts
import assert from 'node:assert/strict';

let seq = 0;
let lines: any[] = [];
let failDelete = false;
// Component pins report coordinates in 10-mil units (the snapshot scales ×10); pad sizes are mil.
const pad = ['RECT', 6, 6, 0];
const pins: Record<string, any[]> = {
	cA: [{ primitiveId: 'Ap1', padNumber: '1', net: 'SIG', layer: 1, x: 0, y: 0, pad }],
	cB: [{ primitiveId: 'Bp1', padNumber: '1', net: 'SIG', layer: 1, x: 100, y: 0, pad }],
	cC: [{ primitiveId: 'Cp1', padNumber: '1', net: 'SIG', layer: 1, x: 50, y: 30, pad }],
	cJ: [
		{ primitiveId: 'Jp1', padNumber: '1', net: 'DP', layer: 1, x: 0, y: 50.7, pad },
		{ primitiveId: 'Jp2', padNumber: '2', net: 'DN', layer: 1, x: 0, y: 49.3, pad },
	],
	cK: [
		{ primitiveId: 'Kp1', padNumber: '1', net: 'DP', layer: 1, x: 100, y: 50.7, pad },
		{ primitiveId: 'Kp2', padNumber: '2', net: 'DN', layer: 1, x: 100, y: 49.3, pad },
	],
};
let components = ['cA', 'cB', 'cJ', 'cK'];
(globalThis as any).eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'doc1', documentType: 3 }) },
	pcb_PrimitiveComponent: {
		// Origins sit on the component's pins in mil (EasyEDA 2.x: origin mil,
		// pins 10-mil), so the runtime pin-unit probe (pin-units.ts) detects ×10.
		getAll: async () => components.map((id) => ({ primitiveId: id, designator: id.slice(1), x: (pins[id]?.[0]?.x ?? 0) * 10, y: (pins[id]?.[0]?.y ?? 0) * 10 })),
		getAllPinsByPrimitiveId: async (id: string) => pins[id] ?? [],
	},
	pcb_PrimitiveLine: {
		getAll: async (_n: any, layer: any) => (layer == null ? lines : lines.filter((l) => l.layer === layer)),
		create: async (net: string, layer: number, sx: number, sy: number, ex: number, ey: number, w: number) => {
			const l = { primitiveId: `L${++seq}`, net, layer, startX: sx, startY: sy, endX: ex, endY: ey, lineWidth: w };
			lines.push(l);
			return l;
		},
		delete: async (ids: string[]) => {
			if (failDelete && ids.includes('LEG')) throw new Error('primitive locked');
			lines = lines.filter((l) => !ids.includes(l.primitiveId));
			return true;
		},
	},
	pcb_PrimitiveVia: { getAll: async () => [], create: async () => undefined, delete: async () => true },
	pcb_PrimitivePad: { getAll: async () => [] },
	pcb_PrimitivePour: { getAll: async () => [] },
	pcb_PrimitiveRegion: { getAll: async () => [] },
	pcb_PrimitivePolyline: { getAll: async () => [] },
	pcb_PrimitiveArc: { getAll: async () => [] },
	pcb_Layer: { getAllLayers: async () => [] },
	pcb_Net: { getAllNetsName: async () => ['SIG', 'DP', 'DN', 'OTHER'], getNetLength: async () => 0 },
	pcb_Drc: {
		getCurrentRuleConfiguration: async () => undefined,
		getNetRules: async () => undefined,
		getAllDifferentialPairs: async () => [{ name: 'USB', positiveNet: 'DP', negativeNet: 'DN' }],
		check: async () => true,
	},
};

type P = { x: number; y: number };
const len = (l: any) => Math.hypot(l.endX - l.startX, l.endY - l.startY);
const netLength = (net: string) => lines.filter((l) => l.net === net).reduce((s, l) => s + len(l), 0);
function chainLength(net: string, from: P, to: P): number {
	// Independent check: the net's tracks must form one simple chain from `from` to `to`.
	const segs = lines.filter((l) => l.net === net);
	let at = from, total = 0;
	const left = [...segs];
	while (Math.hypot(at.x - to.x, at.y - to.y) > 1e-6) {
		const i = left.findIndex((l) => Math.hypot(l.startX - at.x, l.startY - at.y) < 1e-6 || Math.hypot(l.endX - at.x, l.endY - at.y) < 1e-6);
		assert.ok(i >= 0, `chain of ${net} broken at (${at.x}, ${at.y})`);
		const l = left.splice(i, 1)[0];
		at = Math.hypot(l.startX - at.x, l.startY - at.y) < 1e-6 ? { x: l.endX, y: l.endY } : { x: l.startX, y: l.startY };
		total += len(l);
	}
	assert.equal(left.length, 0, `${net} has copper off the chain`);
	return total;
}
function minGap(a: string, b: string): number {
	const segDist = (s: any, t: any) => {
		const ps = (p: P, q1: P, q2: P) => { const dx = q2.x - q1.x, dy = q2.y - q1.y, l2 = dx * dx + dy * dy; const u = l2 ? Math.max(0, Math.min(1, ((p.x - q1.x) * dx + (p.y - q1.y) * dy) / l2)) : 0; return Math.hypot(p.x - q1.x - u * dx, p.y - q1.y - u * dy); };
		const A = { x: s.startX, y: s.startY }, B = { x: s.endX, y: s.endY }, C = { x: t.startX, y: t.startY }, D = { x: t.endX, y: t.endY };
		return Math.min(ps(A, C, D), ps(B, C, D), ps(C, A, B), ps(D, A, B));
	};
	let m = Infinity;
	for (const s of lines.filter((l) => l.net === a)) for (const t of lines.filter((l) => l.net === b)) m = Math.min(m, segDist(s, t) - (s.lineWidth + t.lineWidth) / 2);
	return m;
}

(async () => {
	const { routePairHandlers } = await import('../src/extension/handlers/route-pair');
	const tune = routePairHandlers['pcb.route.lengthTune'];
	const code = (r: any) => (r.issues ?? []).find((i: any) => i.severity === 'error')?.code;
	const reset = () => { lines = [{ primitiveId: 'LEG', net: 'SIG', layer: 1, startX: 0, startY: 0, endX: 1000, endY: 0, lineWidth: 8 }]; };

	// --- dry run: exact delta predicted, nothing touched ---
	reset();
	let r: any = await tune({ track: 'LEG', addLength: 100 });
	assert.equal(r.status, 'dry-run', JSON.stringify(r));
	assert.equal(r.before, 1000);
	assert.equal(r.geometry[0].added, 100);
	assert.equal(r.geometry[0].predicted, 1100);
	assert.deepEqual(lines.map((l) => l.primitiveId), ['LEG']);

	// --- commit: meander replaces the leg; the measured path grew by exactly the delta ---
	r = await tune({ track: 'LEG', addLength: 100, dryRun: false });
	assert.equal(r.status, 'committed', JSON.stringify(r));
	assert.equal(r.verify.ok, true);
	assert.ok(Math.abs(r.verify.nets[0].added - 100) <= 1);
	assert.ok(!lines.some((l) => l.primitiveId === 'LEG'), 'original leg deleted');
	assert.ok(Math.abs(chainLength('SIG', { x: 0, y: 0 }, { x: 1000, y: 0 }) - 1100) < 1e-6, 'independent chain length = 1000 + 100');
	for (const l of lines) {
		const deg = (Math.atan2(l.endY - l.startY, l.endX - l.startX) * 180) / Math.PI;
		assert.ok(Math.abs(deg - Math.round(deg / 45) * 45) < 1e-6, 'octilinear meander');
	}

	// --- target length and already-met ---
	reset();
	r = await tune({ track: 'LEG', targetLength: 1250 });
	assert.equal(r.status, 'dry-run');
	assert.equal(r.delta, 250);
	assert.equal(r.geometry[0].predicted, 1250);
	assert.equal((await tune({ track: 'LEG', targetLength: 1000.5 })).status, 'already-met');
	assert.equal(code(await tune({ track: 'LEG', targetLength: 900 })), 'ALREADY_LONGER');

	// --- refused: obstacles on both sides leave no room for any amplitude ---
	reset();
	lines.push(
		{ primitiveId: 'OB1', net: 'OTHER', layer: 1, startX: 100, startY: 20, endX: 900, endY: 20, lineWidth: 8 },
		{ primitiveId: 'OB2', net: 'OTHER', layer: 1, startX: 100, startY: -20, endX: 900, endY: -20, lineWidth: 8 },
	);
	r = await tune({ track: 'LEG', addLength: 100, dryRun: false });
	assert.equal(r.status, 'insufficient-space', JSON.stringify(r));
	assert.ok(r.attempts.some((a: any) => a.outcome === 'blocked' && a.side === 'left') && r.attempts.some((a: any) => a.outcome === 'blocked' && a.side === 'right'));
	assert.deepEqual(lines.map((l) => l.primitiveId).sort(), ['LEG', 'OB1', 'OB2'], 'nothing created or deleted');

	// --- one side free: auto picks it ---
	lines = lines.filter((l) => l.primitiveId !== 'OB1');
	r = await tune({ track: 'LEG', addLength: 100 });
	assert.equal(r.status, 'dry-run', JSON.stringify(r));
	assert.equal(r.plan.side, 'left');

	// --- refused: the leg is too short for the delta ---
	reset();
	r = await tune({ track: 'LEG', addLength: 5000 });
	assert.equal(r.status, 'insufficient-space');
	assert.ok(r.attempts.every((a: any) => a.outcome === 'leg-too-short'), JSON.stringify(r.attempts));

	// --- refused before commit: runs that touch would shortcut the path (copper, but no length) ---
	r = await tune({ track: 'LEG', addLength: 100, spacing: 0.001 });
	assert.equal(r.status, 'insufficient-space', JSON.stringify(r));
	assert.ok(r.attempts.some((a: any) => /^shortcut/.test(a.outcome)), JSON.stringify(r.attempts));

	// --- refused: a stub is not on the signal path ---
	lines.push({ primitiveId: 'STUB', net: 'SIG', layer: 1, startX: 500, startY: 0, endX: 500, endY: 200, lineWidth: 8 });
	assert.equal(code(await tune({ track: 'STUB', addLength: 50 })), 'LEG_NOT_ON_PATH');
	// … and the leg it hangs off now has a junction a meander would cut off
	assert.equal(code(await tune({ track: 'LEG', addLength: 50 })), 'LEG_HAS_JUNCTION');

	// --- three-pad net needs explicit endpoints ---
	reset();
	components = ['cA', 'cB', 'cC', 'cJ', 'cK'];
	assert.equal(code(await tune({ track: 'LEG', addLength: 50 })), 'ENDPOINTS_REQUIRED');
	r = await tune({ track: 'LEG', addLength: 50, between: ['A.1', 'B.1'] });
	assert.equal(r.status, 'dry-run', JSON.stringify(r));
	components = ['cA', 'cB', 'cJ', 'cK'];

	// --- EasyEDA refuses to delete the leg → the meander is removed again ---
	reset();
	failDelete = true;
	r = await tune({ track: 'LEG', addLength: 100, dryRun: false });
	assert.equal(r.status, 'rolled-back', JSON.stringify(r));
	failDelete = false;
	assert.deepEqual(lines.map((l) => l.primitiveId), ['LEG']);

	// --- coupled pair: both nets gain the same length, gap preserved ---
	lines = [
		{ primitiveId: 'PLEG', net: 'DP', layer: 1, startX: 0, startY: 507, endX: 1000, endY: 507, lineWidth: 8 },
		{ primitiveId: 'NLEG', net: 'DN', layer: 1, startX: 1000, startY: 493, endX: 0, endY: 493, lineWidth: 8 },
	];
	r = await tune({ track: 'PLEG', coupled: true, addLength: 60, dryRun: false });
	assert.equal(r.status, 'committed', JSON.stringify(r));
	assert.equal(r.partner.net, 'DN');
	assert.ok(Math.abs(chainLength('DP', { x: 0, y: 507 }, { x: 1000, y: 507 }) - 1060) < 1e-6);
	assert.ok(Math.abs(chainLength('DN', { x: 0, y: 493 }, { x: 1000, y: 493 }) - 1060) < 1e-6, 'partner gains the same length (inner/outer cancel per bump)');
	assert.ok(Math.abs(minGap('DP', 'DN') - 6) < 1e-6, `pair gap ${minGap('DP', 'DN')} kept at 6`);

	// --- intra-pair skew: tune DN alone to match DP; the bump goes away from the partner ---
	lines = [
		{ primitiveId: 'PLEG', net: 'DP', layer: 1, startX: 0, startY: 507, endX: 1000, endY: 507, lineWidth: 8 },
		{ primitiveId: 'NLEG', net: 'DN', layer: 1, startX: 0, startY: 493, endX: 960, endY: 493, lineWidth: 8 },
		{ primitiveId: 'NEND', net: 'DN', layer: 1, startX: 960, startY: 493, endX: 1000, endY: 493, lineWidth: 8 },
		{ primitiveId: 'PX', net: 'DP', layer: 1, startX: 1000, startY: 507, endX: 1000, endY: 547, lineWidth: 8 },
	];
	pins.cK[0].y = 54.7; // DP's far pad moved up: DP is 40 longer than DN
	r = await tune({ track: 'NLEG', matchPartner: true });
	assert.equal(r.status, 'dry-run', JSON.stringify(r));
	assert.equal(r.delta, 40);
	assert.equal(r.plan.side, 'right', 'away from DP');
	r = await tune({ track: 'NLEG', matchPartner: true, side: 'left' });
	assert.equal(r.status, 'insufficient-space', 'a bump toward the partner would violate the pair gap');
	assert.ok(r.attempts.every((a: any) => /blocked by DP leg PLEG/.test(a.outcome)), JSON.stringify(r.attempts));

	console.log('pcb_length_tune: exact delta predicted + measured after commit, target/already-met, insufficient space (blocked / leg too short), shortcut + stub + junction refusals, delete-failure rollback, coupled pair, match partner — passed.');
	process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
