// pcb_route_pair — differential-pair offsets, fan-ins, paired vias, skew and
// one-transaction commit, against a stateful mock board.
// Run: npx ts-node --transpile-only scripts/route-pair-smoke.ts
import assert from 'node:assert/strict';

let seq = 0;
let lines: any[] = [];
let vias: any[] = [];
let failViaNet: string | undefined;
// Component pins report coordinates in 10-mil units (the snapshot scales ×10); pad sizes are mil.
const pad = ['RECT', 12, 12, 0];
const pins: Record<string, any[]> = {
	cJ1: [
		{ primitiveId: 'J1p1', padNumber: '1', net: 'DP', layer: 1, x: 0, y: 1, pad },
		{ primitiveId: 'J1p2', padNumber: '2', net: 'DN', layer: 1, x: 0, y: -1, pad },
	],
	cU1: [
		{ primitiveId: 'U1p1', padNumber: '1', net: 'DP', layer: 1, x: 85, y: 1, pad },
		{ primitiveId: 'U1p2', padNumber: '2', net: 'DN', layer: 1, x: 85, y: -1, pad },
	],
	cU2: [
		{ primitiveId: 'U2p1', padNumber: '1', net: 'DP', layer: 2, x: 65, y: 1, pad },
		{ primitiveId: 'U2p2', padNumber: '2', net: 'DN', layer: 2, x: 65, y: -1, pad },
	],
};
(globalThis as any).eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'doc1', documentType: 3 }) },
	pcb_PrimitiveComponent: {
		getAll: async () => [
			{ primitiveId: 'cJ1', designator: 'J1', x: 0, y: 0 },
			{ primitiveId: 'cU1', designator: 'U1', x: 850, y: 0 },
			{ primitiveId: 'cU2', designator: 'U2', x: 650, y: 0 },
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
		delete: async (ids: string[]) => { lines = lines.filter((l) => !ids.includes(l.primitiveId)); return true; },
	},
	pcb_PrimitiveVia: {
		getAll: async () => vias,
		create: async (net: string, x: number, y: number, hole: number, diameter: number) => {
			if (failViaNet === net) throw new Error('via rejected');
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
	pcb_Net: { getAllNetsName: async () => ['DP', 'DN'], getNetLength: async () => 0 },
	pcb_Drc: {
		getCurrentRuleConfiguration: async () => undefined,
		getNetRules: async () => undefined,
		getAllDifferentialPairs: async () => [],
		check: async () => true,
	},
};

type P = { x: number; y: number };
const sub = (a: P, b: P) => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: P, b: P) => a.x * b.y - a.y * b.x;
const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const len = (a: P) => Math.hypot(a.x, a.y);
function pointSeg(p: P, a: P, b: P): number {
	const d = sub(b, a), l2 = dot(d, d);
	const t = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), d) / l2)) : 0;
	return len(sub(p, { x: a.x + d.x * t, y: a.y + d.y * t }));
}
function segDist(a: P, b: P, c: P, d: P): number {
	const o = (p: P, q: P, r: P) => Math.sign(cross(sub(q, p), sub(r, p)));
	if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return 0;
	return Math.min(pointSeg(a, c, d), pointSeg(b, c, d), pointSeg(c, a, b), pointSeg(d, a, b));
}
const legsOf = (route: any) => route.legs.map((l: any) => ({ layer: l.layer, a: { x: l.from[0], y: l.from[1] }, b: { x: l.to[0], y: l.to[1] } }));
const lengthOf = (legs: any[]) => legs.reduce((s, l) => s + len(sub(l.b, l.a)), 0);

(async () => {
	const { routePairHandlers } = await import('../src/extension/handlers/route-pair');
	const pair = routePairHandlers['pcb.route.pair'];
	const codes = (r: any) => (r.issues ?? []).map((i: any) => i.code);
	const width = 8, gap = 6, pitch = width + gap;
	const ends = { p: { from: 'J1.1', to: 'U1.1' }, n: { from: 'J1.2', to: 'U1.2' } };
	// straight → 45° left → 90° right → 45° left → straight
	const centerline = [{ x: 50, y: 0 }, { x: 300, y: 0 }, { x: 400, y: 100 }, { x: 500, y: 0 }, { x: 800, y: 0 }];

	// --- dry run: exact gap through the 45° and 90° corners, skew = the corners' inner/outer difference ---
	let r: any = await pair({ ...ends, centerline, width, gap });
	assert.equal(r.status, 'dry-run', JSON.stringify(r));
	assert.equal(r.pair.pSide, 'left');
	const P = legsOf(r.routes[0]), N = legsOf(r.routes[1]);
	assert.equal(P.length, 6, 'fan-in, four coupled legs, fan-out');
	assert.equal(N.length, 6);
	for (let i = 1; i <= 4; i++) {
		const up = sub(P[i].b, P[i].a), un = sub(N[i].b, N[i].a);
		assert.ok(Math.abs(cross(up, un)) / (len(up) * len(un)) < 1e-6, `coupled leg ${i} parallel`);
		const perp = Math.abs(cross(sub(N[i].a, P[i].a), up)) / len(up);
		assert.ok(Math.abs(perp - pitch) < 1e-3, `coupled leg ${i}: centre distance ${perp} ≠ ${pitch}`);
	}
	let minCentre = Infinity;
	for (const a of P) for (const b of N) minCentre = Math.min(minCentre, segDist(a.a, a.b, b.a, b.b));
	assert.ok(Math.abs(minCentre - pitch) < 1e-3, `min P–N centre distance ${minCentre} (edge gap must be exactly ${gap})`);
	assert.equal(r.gap.min, gap);
	for (const leg of [...P, ...N]) {
		const deg = (Math.atan2(leg.b.y - leg.a.y, leg.b.x - leg.a.x) * 180) / Math.PI;
		assert.ok(Math.abs(deg - Math.round(deg / 45) * 45) < 1e-3, `octilinear leg ${deg}`);
	}
	const t = Math.tan(Math.PI / 8);
	const expectedSkew = -2 * pitch * (t - 1 + t); // left 45°, right 90°, left 45°; P on the left
	assert.ok(Math.abs(r.skew.corners - expectedSkew) < 1e-3, `corner skew ${r.skew.corners} vs ${expectedSkew}`);
	assert.ok(Math.abs(r.skew.skew - expectedSkew) < 1e-3, 'symmetric fan-ins add no skew');
	assert.ok(Math.abs(lengthOf(P) - lengthOf(N) - r.skew.skew) < 1e-3, 'reported skew = geometry');
	assert.deepEqual(P[0].a, { x: 0, y: 10 }, 'P starts at its pad');
	assert.deepEqual(P[0].b, { x: 3, y: 7 }, '45° fan-in onto the offset line');
	assert.equal(lines.length, 0, 'dry run creates nothing');

	// --- refusals ---
	assert.ok(codes(await pair({ ...ends, centerline, width })).includes('GAP_REQUIRED'));
	assert.ok(codes(await pair({ ...ends, width, gap, centerline: [{ x: 50, y: 0 }, { x: 300, y: 0 }, { x: 303, y: 3 }, { x: 303, y: 200 }] })).includes('OFFSET_DEGENERATE'));
	assert.ok(codes(await pair({ ...ends, width, gap, centerline: [{ x: -100, y: 0 }, { x: -90, y: 0 }, { x: -90, y: -100 }] })).includes('FANIN_GEOMETRY'));
	assert.ok(codes(await pair({ p: { from: 'J1.1', to: 'U1.2' }, n: { from: 'J1.2', to: 'U1.1' }, pNet: 'DP', nNet: 'DN', centerline, width, gap })).includes('PAIR_CROSSES'));
	assert.ok(codes(await pair({ ...ends, width, gap, centerline: [{ x: 50, y: 0 }, { x: 300, y: 37 }, { x: 800, y: 0 }] })).includes('NOT_OCTILINEAR'));

	// --- paired vias at a layer change: spread to via pitch with 45° legs, symmetric about the centerline ---
	const viaPlan = { p: { from: 'J1.1', to: 'U2.1' }, n: { from: 'J1.2', to: 'U2.2' }, width, gap, via: { diameter: 24, holeDiameter: 12 }, centerline: [{ x: 50, y: 0 }, { x: 300, y: 0, layer: 'BottomLayer' }, { x: 600, y: 0 }] };
	r = await pair(viaPlan);
	assert.equal(r.status, 'dry-run', JSON.stringify(r));
	assert.equal(r.pair.via.pitch, 30, 'via pitch = diameter + max(gap, clearance)');
	assert.deepEqual(r.vias, [{ p: [300, 15], n: [300, -15], toLayer: 2 }]);
	assert.deepEqual(r.routes[0].vias.map((v: any) => v.at), [[300, 15]]);
	assert.deepEqual(r.routes[1].vias.map((v: any) => v.at), [[300, -15]]);
	assert.deepEqual(legsOf(r.routes[0]).map((l: any) => [l.layer, l.a.x, l.a.y, l.b.x, l.b.y]), [
		[1, 0, 10, 3, 7], [1, 3, 7, 292, 7], [1, 292, 7, 300, 15], [2, 300, 15, 308, 7], [2, 308, 7, 647, 7], [2, 647, 7, 650, 10],
	]);
	assert.ok(r.gap.viaMin >= 6 - 1e-9, `via clearance ${r.gap.viaMin}`);
	assert.equal(Math.abs(r.skew.skew) < 1e-9, true, 'straight via transition is skew-free');

	// --- one transaction: the N via fails → P's copper is removed too ---
	failViaNet = 'DN';
	r = await pair({ ...viaPlan, dryRun: false });
	assert.equal(r.status, 'rolled-back', JSON.stringify(r));
	assert.equal(lines.length, 0);
	assert.equal(vias.length, 0);
	failViaNet = undefined;

	// --- commit both nets, verified; measured lengths reported ---
	r = await pair({ ...ends, centerline, width, gap, dryRun: false, requestId: 'pair-1' });
	assert.equal(r.status, 'committed', JSON.stringify(r));
	assert.equal(r.created.length, 12);
	assert.ok(r.verify.routes.every((x: any) => x.joined));
	assert.ok(Math.abs(r.measured.skew - r.skew.skew) < 1e-3, 'measured pad-to-pad skew matches the plan');
	const again = await pair({ ...ends, centerline, width, gap, dryRun: false, requestId: 'pair-1' });
	assert.equal(again.replayed, true);
	assert.equal(lines.length, 12, 'replay does not duplicate copper');
	lines = [];

	// --- width/gap from the board's Differential Pair rule (pair resolved by name; object-shaped pair list) ---
	const dpRule = (w: number, g: number, def: boolean) => ({ editName: def ? 'default' : 'usb90', unit: 'mm', isSetDefault: def, form: { strokeWidthMin: 0.127, strokeWidthDefault: w, strokeWidthMax: 0.5, differentailPairSpacingMin: 0.1, differentailPairSpacingDefault: g, differentailPairSpacingMax: 0.5, differentailPairLenTolerMax: 0.0254 } });
	const netRows = [{ type: 'netDifferentail', name: 'USB', 'Differential Pair': 'usb90', sub: [{ type: 'net', name: 'DP', 'Differential Pair': 'usb90' }, { type: 'net', name: 'DN', 'Differential Pair': 'usb90' }] }];
	(globalThis as any).eda.pcb_Drc.getCurrentRuleConfiguration = async () => ({ ruleTemplateName: 'jlc', Rule: { Physics: { 'Differential Pair': { default: dpRule(0.254, 0.254, true), usb90: dpRule(0.2032, 0.1524, false) } } }, Net: netRows });
	(globalThis as any).eda.pcb_Drc.getNetRules = async () => netRows;
	(globalThis as any).eda.pcb_Drc.getAllDifferentialPairs = async () => ({ USB: { name: 'USB', positiveNet: 'DP', negativeNet: 'DN' } });
	r = await pair({ pair: 'USB', ...ends, centerline });
	assert.equal(r.status, 'dry-run', JSON.stringify(r.issues));
	assert.equal(r.pair.width, 8);
	assert.equal(r.pair.gap, 6);
	assert.match(r.pair.gapSource, /Differential Pair\/usb90 \(pair USB\)/);
	assert.ok(codes(r).includes('SKEW_ABOVE_TOLERANCE'), 'rule length tolerance 1 mil < corner skew');

	console.log('pcb_route_pair: exact gap through 45°/90° corners, corner skew, fan-ins, paired vias, refusals, one-transaction rollback, verified commit + replay, pair rule defaults — passed.');
	process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
