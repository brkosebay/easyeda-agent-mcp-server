// Pathfinder + obstacle check follow the board's real DRC rules and real pad
// shapes. Rule payloads mirror what EasyEDA Pro 2.2.47 returns from
// pcb_Drc.getCurrentRuleConfiguration() / getNetRules() (see the structure
// notes above resolveClearance in trace-obstacles.ts); the Safe Spacing tables
// are the shipped "JLCPCB Capability(Two Layers Board)" profile, unit mm.
// Run: npx ts-node --transpile-only scripts/pathfinder-rules-smoke.ts
import assert from 'node:assert/strict';

const ROWS = ['Track', 'SMD Pad', 'TH Pad', 'Via', 'Fill Region/Teardrop', 'Slot Region', 'Line', 'Text/Image', 'Board Outline', 'Hole'];
const COLUMNS = ROWS.slice(0, 9);
const jlcTable = (trackTrack: number) => [
	[trackTrack],
	[0.152, 0.152],
	[0.152, 0.152, 0.152],
	[0.152, 0.152, 0.152, 0.152],
	[0.152, 0.152, 0.152, 0.152, 0.152],
	[0.3, 0.152, 0.152, 0.152, 0.152, 0.152],
	[0.152, 0.152, 0.152, 0.152, 0.152, 0.3, 0.152],
	[0.152, 0.152, 0.152, 0.152, 0.152, 0.152, 0.152, 0.152],
	[0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3],
	[0.176, 0.176, 0.176, 0.176, 0.176, 0.176, 0.176, 0.176, 0.176],
];
const safeRule = (editName: string, isSetDefault: boolean, table: any[][], unit: any = 'mm') => ({ editName, unit, isSetDefault, column: COLUMNS, row: ROWS, table });

const netRules: any[] = [
	{ type: 'netClass', name: 'POWER', 'Safe Spacing': 'copperThickness2oz', Track: 'default', sub: [{ type: 'net', name: 'VBUS', 'Safe Spacing': 'copperThickness2oz' }] },
	{ type: 'net', name: 'SIG', 'Safe Spacing': 'default', Track: 'default' },
	{ type: 'net', name: 'GHOST', 'Safe Spacing': 'noSuchRule' },
	{ type: 'net', name: 'OTHER', 'Safe Spacing': 'default' },
];
const ruleConfig: any = {
	Rule: {
		Spacing: {
			'Safe Spacing': {
				copperThickness1oz: safeRule('copperThickness1oz', true, jlcTable(0.102)),
				copperThickness2oz: safeRule('copperThickness2oz', false, jlcTable(0.203)),
			},
			'Other Spacing': { otherClearance: { editName: 'otherClearance', form: { device2device: 0, thru2Smd: 0, hole2Hole: 0.3 }, isSetDefault: true, unit: 'mm' } },
		},
		// The old fuzzy /clearance|spacing/ search landed here: 0.152 "mil".
		Physics: { 'Differential Pair': { differentialPair: { editName: 'differentialPair', form: { differentailPairSpacingMin: 0.152, strokeWidthMin: 0.127 }, isSetDefault: true, unit: 'mm' } } },
	},
	Net: netRules,
	ruleTemplateName: 'JLCPCB Capability(Two Layers Board)',
};
let currentRules: any = ruleConfig;
let currentNetRules: any = netRules;

// Component pins report coordinates in 10-mil units (the snapshot scales x10);
// `pad` extents are mil, rotation is radians.
const pins: Record<string, any[]> = {
	cU1: [{ primitiveId: 'U1p1', padNumber: '1', net: 'SIG', layer: 1, x: 0, y: 0, pad: ['RECT', 20, 20, 0] }],
	cR1: [{ primitiveId: 'R1p1', padNumber: '1', net: 'SIG', layer: 1, x: 50, y: 0, pad: ['RECT', 20, 20, 0] }],
	// A long pad rotated 90 degrees right across the straight line U1.1 -> R1.1.
	cX1: [{ primitiveId: 'X1p1', padNumber: '1', net: 'OTHER', layer: 1, x: 25, y: 0, pad: ['RECT', 100, 20, 0], rotation: Math.PI / 2 }],
};
(globalThis as any).eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'rules-doc', documentType: 3 }) },
	pcb_PrimitiveComponent: {
		getAll: async () => [
			{ primitiveId: 'cU1', designator: 'U1', x: 0, y: 0 },
			{ primitiveId: 'cR1', designator: 'R1', x: 500, y: 0 },
			{ primitiveId: 'cX1', designator: 'X1', x: 250, y: 0 },
		],
		getAllPinsByPrimitiveId: async (id: string) => pins[id] ?? [],
	},
	pcb_PrimitiveLine: { getAll: async () => [] },
	pcb_PrimitiveVia: { getAll: async () => [] },
	pcb_PrimitivePad: { getAll: async () => [] },
	pcb_PrimitivePour: { getAll: async () => [] },
	pcb_PrimitiveRegion: { getAll: async () => [] },
	pcb_PrimitivePolyline: { getAll: async () => [] },
	pcb_Layer: { getAllLayers: async () => [] },
	pcb_Net: { getAllNetsName: async () => ['SIG', 'OTHER'], getNetLength: async () => 0 },
	pcb_Drc: {
		getCurrentRuleConfiguration: async () => currentRules,
		getNetRules: async () => currentNetRules,
	},
};

const near = (actual: number, expected: number, msg?: string) => assert.ok(Math.abs(actual - expected) < 0.01, `${msg ?? ''} expected ~${expected}, got ${actual}`);

(async () => {
	const { clearanceResolverFromRules, resolveClearance, clearanceForKind, checkTraceObstacles } = await import('../src/extension/handlers/trace-obstacles');
	const { boardContextHandlers, isPointBlockedForRoute } = await import('../src/extension/handlers/board-context');

	// --- 1. resolver reads Safe Spacing table cells and converts mm -> mil ---
	let res = clearanceResolverFromRules(ruleConfig, netRules, ['SIG', 'VBUS', 'GHOST']);
	near(res.summary.clearanceMil, 4.016, 'Track-Track 0.102 mm');
	assert.notEqual(res.summary.clearanceMil, 0.152, 'never the diff-pair spacing the fuzzy search used to find');
	assert.equal(res.summary.ruleUnit, 'mm');
	assert.equal(res.summary.rawValue, 0.102);
	assert.equal(res.summary.ruleName, 'copperThickness1oz', 'net "default" means the isSetDefault rule, whatever it is called');
	assert.equal(res.summary.ruleKey, 'Rule.Spacing["Safe Spacing"]["copperThickness1oz"].table[0][0]');
	assert.match(res.summary.clearanceSource, /^rule:JLCPCB Capability\(Two Layers Board\)\/Safe Spacing\/copperThickness1oz/);
	near(clearanceForKind(res.for('SIG'), 'smdPad'), 5.984, 'SMD Pad-Track 0.152 mm');
	near(clearanceForKind(res.for('SIG'), 'thPad'), 5.984, 'TH Pad-Track');
	near(clearanceForKind(res.for('SIG'), 'via'), 5.984, 'Via-Track');
	assert.equal(res.summary.fallbackReason, undefined);
	// Net-class member gets its class's named rule; unknown rule name keeps the default and says so.
	near(res.for('VBUS').clearanceMil, 7.992, 'copperThickness2oz Track-Track 0.203 mm');
	assert.match(res.for('VBUS').source, /Safe Spacing\/copperThickness2oz \(net class POWER -> VBUS\)/);
	near(res.for('GHOST').clearanceMil, 4.016);
	assert.match(res.for('GHOST').source, /rule "noSuchRule" not found/);
	assert.ok(res.summary.perNet.SIG && res.summary.perNet.VBUS, 'requested nets are pre-reported');
	assert.equal(res.for('NOT_IN_RULES').clearanceMil, res.summary.clearanceMil, 'nets without a net rule use the default rule');

	// A mil rule (EasyEDA's own default 6 mil) and a stored profile ({config:{Spacing}}) shape.
	res = clearanceResolverFromRules({ Rule: { Spacing: { 'Safe Spacing': { default: safeRule('default', true, [[6], [6, 6], [10, 6, 6], [8, 6, 6, 6]], 'mil') } } } }, []);
	assert.equal(res.summary.clearanceMil, 6);
	assert.deepEqual(res.summary.clearanceByKind, { track: 6, smdPad: 6, thPad: 10, via: 8 });
	res = clearanceResolverFromRules({ name: 'stored', config: { Spacing: { 'Safe Spacing': { x: safeRule('x', true, jlcTable(0.127)) } } } }, undefined);
	near(res.summary.clearanceMil, 5);

	// --- 2. implausible / unknown units fall back to 6 mil with the reason ---
	res = clearanceResolverFromRules({ Rule: { Spacing: { 'Safe Spacing': { r: safeRule('r', true, jlcTable(0.152), null) } } } }, []);
	assert.equal(res.summary.clearanceMil, 6);
	assert.match(res.summary.clearanceSource, /^default:6mil \(.*unknown unit.*implausible as mil/);
	assert.match(res.summary.fallbackReason!, /table\[0\]\[0\] = 0\.152/);
	res = clearanceResolverFromRules({ Rule: { Spacing: { 'Safe Spacing': { r: safeRule('r', true, jlcTable(10)) } } } }, []);
	assert.equal(res.summary.clearanceMil, 6);
	assert.match(res.summary.clearanceSource, /393\.701 mil is outside the plausible 1-200 mil range/);
	res = clearanceResolverFromRules({ Rule: { Spacing: { 'Safe Spacing': { r: safeRule('r', true, jlcTable(4), 'parsec') } } } }, []);
	assert.equal(res.summary.clearanceMil, 4, 'unknown unit but plausible as mil: used, and flagged');
	assert.match(res.summary.clearanceSource, /unit "parsec" unknown, value assumed mil/);
	res = clearanceResolverFromRules(undefined, undefined, ['SIG']);
	assert.equal(res.summary.clearanceSource, 'default:6mil (no DRC rule configuration readable)');
	assert.equal(res.for('SIG').clearanceMil, 6);
	res = clearanceResolverFromRules({ Rule: { Physics: {} } }, []);
	assert.match(res.summary.clearanceSource, /has no Rule\.Spacing\["Safe Spacing"\] rules/);
	// A single implausible per-kind cell is dropped, not the whole rule.
	const badVia = jlcTable(0.102); badVia[3] = [0, 0.152, 0.152, 0.152];
	res = clearanceResolverFromRules({ Rule: { Spacing: { 'Safe Spacing': { r: safeRule('r', true, badVia) } } } }, []);
	near(clearanceForKind(res.for('SIG'), 'via'), 4.016, 'zero Via-Track cell replaced by Track-Track');
	assert.match(res.summary.clearanceSource, /implausible Via-Track=0/);

	// Explicit override; null is "not given" (Number(null) === 0 trap).
	res = await resolveClearance(['SIG'], { clearanceMil: 9 });
	assert.equal(res.summary.clearanceSource, 'param:clearanceMil');
	assert.equal(clearanceForKind(res.for('SIG'), 'smdPad'), 9);
	res = await resolveClearance(['SIG'], { clearanceMil: null });
	near(res.summary.clearanceMil, 4.016, 'null clearanceMil resolves from the board');

	// --- 3. real pad shapes in the pathfinder's cell test ---
	const rule = (await resolveClearance(['SIG'], {})).for('SIG'); // smdPad ~5.984
	const snap = (componentPads: any[]) => ({ lines: [], vias: [], standalonePads: [], componentPads, pours: [], keepouts: [] });
	const opts = { net: 'SIG', layer: 1, lineWidth: 10, clearance: rule };
	// Rotated 100x20 rect at (500,500), rotation pi/2 -> spans y 450..550, x 490..510.
	const rotated = snap([{ net: 'OTHER', layer: 1, x: 500, y: 500, pad: ['RECT', 100, 20, 0], rotation: Math.PI / 2, componentPrimitiveId: 'C9' }]);
	assert.equal(isPointBlockedForRoute(rotated, { x: 500, y: 558 }, opts), true, '8 mil off the rotated pad end: 8 <= 5 + 5.98 (old 18-mil circle said clear)');
	assert.equal(isPointBlockedForRoute(rotated, { x: 500, y: 566 }, opts), false, '16 mil off the end is clear');
	assert.equal(isPointBlockedForRoute(rotated, { x: 530, y: 500 }, opts), false, 'beside the narrow side: 20 mil gap is clear (an unrotated pad would cover it)');
	// Round 60-mil pad at (800,800): its bounding-box corner is empty copper.
	const round = snap([{ net: 'OTHER', layer: 1, x: 800, y: 800, pad: ['ELLIPSE', 60, 60], componentPrimitiveId: 'C8' }]);
	assert.equal(isPointBlockedForRoute(round, { x: 830, y: 830 }, opts), false, 'empty corner region of a round pad is routable');
	assert.equal(isPointBlockedForRoute(round, { x: 800, y: 838 }, opts), true, '~8 mil off the arc is inside clearance (old circle: 38 > 29, clear)');
	// Same-net pads never block; a drilled pad blocks every layer and uses the TH Pad cell.
	assert.equal(isPointBlockedForRoute(snap([{ net: 'SIG', layer: 1, x: 800, y: 800, pad: ['ELLIPSE', 60, 60] }]), { x: 800, y: 800 }, opts), false);
	const thRule = { clearanceMil: 4, source: 'test', byKind: { track: 4, smdPad: 6, thPad: 12, via: 8 } };
	const th = snap([{ net: 'OTHER', layer: 2, x: 0, y: 0, pad: ['ELLIPSE', 40, 40], hole: ['ROUND', 20, 20] }]);
	assert.equal(isPointBlockedForRoute(th, { x: 0, y: 34 }, { ...opts, clearance: thRule }), true, 'drilled bottom pad blocks top; 8.8 mil gap < TH Pad 12');
	const smdBottom = snap([{ net: 'OTHER', layer: 2, x: 0, y: 0, pad: ['ELLIPSE', 40, 40] }]);
	assert.equal(isPointBlockedForRoute(smdBottom, { x: 0, y: 0 }, { ...opts, clearance: thRule }), false, 'SMD pad on the other layer does not block');
	const smdTop = snap([{ net: 'OTHER', layer: 1, x: 0, y: 0, pad: ['ELLIPSE', 40, 40] }]);
	assert.equal(isPointBlockedForRoute(smdTop, { x: 0, y: 34 }, { ...opts, clearance: thRule }), false, 'same gap to an SMD pad is legal (SMD Pad 6 < 8.8)');

	// --- 4. route tools report the rule, and planner + final check agree ---
	const pathfind = boardContextHandlers['pcb.route.pathfind'];
	let r: any = await pathfind({ from_pad: 'U1.1', to_pad: 'R1.1', lineWidth: 10, gridMil: 10, searchMarginMil: 150, dryRun: true });
	near(r.clearanceMil, 4.016);
	assert.match(r.clearanceSource, /^rule:JLCPCB Capability\(Two Layers Board\)\/Safe Spacing\/copperThickness1oz/);
	near(r.clearanceByKind.smdPad, 5.984);
	assert.equal(r.obstacleCheck.clearanceSource, r.clearanceSource, 'final preflight resolved the same rule');
	assert.equal(r.obstacleCheck.blockingObstacleCount, 0, `path around the rotated pad is clean: ${JSON.stringify(r.obstacleCheck.obstacles?.slice(0, 3))}`);
	assert.ok(r.routePoints.some((p: any) => Math.abs(p.y) >= 55), `detoured around the 100-mil rotated pad: ${JSON.stringify(r.routePoints)}`);
	r = await pathfind({ from_pad: 'U1.1', to_pad: 'R1.1', lineWidth: 10, gridMil: 10, searchMarginMil: 150, dryRun: true, clearanceMil: 8 });
	assert.equal(r.clearanceSource, 'param:clearanceMil');
	assert.equal(r.clearanceMil, 8);

	r = await boardContextHandlers['pcb.route.net']({ net: 'SIG', lineWidth: 10, gridMil: 10, searchMarginMil: 150 });
	assert.match(r.clearanceSource, /^rule:JLCPCB/);
	assert.equal(r.routedPairCount, 1, JSON.stringify(r.pairs?.[0]?.error ?? r.pairs?.[0]?.obstacleCheck?.obstacles?.slice(0, 2)));
	r = await boardContextHandlers['pcb.route.andVerify']({ nets: ['SIG'], lineWidth: 10, gridMil: 10, searchMarginMil: 150 });
	assert.match(r.clearanceSource, /^rule:JLCPCB/);
	assert.match(r.route.nets[0].clearanceSource, /^rule:JLCPCB/);
	assert.ok(r.route.clearanceRules.perNet.SIG);
	r = await boardContextHandlers['pcb.route.retryPlan']({ nets: ['SIG'], lineWidth: 10, gridMil: 10, searchMarginMil: 150 });
	assert.match(r.clearanceSource, /^rule:JLCPCB/);

	// The standalone obstacle check uses the per-kind cells too.
	const seg = { net: 'SIG', layer: 1, startX: 200, startY: -66, endX: 300, endY: -66, lineWidth: 10 };
	r = await checkTraceObstacles({ segments: [seg], includeBoardBoundary: false });
	// Pad X1.1 spans y -50..50 -> gap to the track edge = 66 - 50 - 5 = 11 > 5.98: clear.
	assert.equal(r.blockingObstacleCount, 0, JSON.stringify(r.obstacles));
	r = await checkTraceObstacles({ segments: [{ ...seg, startY: -60, endY: -60 }], includeBoardBoundary: false });
	assert.equal(r.blockingObstacleCount, 1, 'gap 5 < SMD Pad-Track 5.98');
	near(r.obstacles[0].clearanceRequiredMil, 5.98);
	assert.match(r.obstacles[0].clearanceSource, /^rule:JLCPCB/);

	// Unreadable rules still give the 6-mil default (what every older smoke relies on).
	currentRules = undefined; currentNetRules = undefined;
	r = await pathfind({ from_pad: 'U1.1', to_pad: 'R1.1', lineWidth: 10, gridMil: 10, searchMarginMil: 150, dryRun: true });
	assert.equal(r.clearanceMil, 6);
	assert.match(r.clearanceSource, /^default:6mil/);

	// --- 5. a via disc (zero-length MULTI segment) sees tracks on EVERY copper layer ---
	const viaLines = [
		{ primitiveId: 'L1', net: 'OTHER', layer: 1, startX: 1020, startY: 900, endX: 1020, endY: 1100, lineWidth: 10 },
		{ primitiveId: 'L15', net: 'OTHER', layer: 15, startX: 980, startY: 900, endX: 980, endY: 1100, lineWidth: 10 },
	];
	const fetched: any[] = [];
	(globalThis as any).eda.pcb_PrimitiveLine.getAll = async (_n: any, layer: any) => {
		fetched.push(layer);
		return layer == null ? viaLines : viaLines.filter((l) => l.layer === layer);
	};
	const disc = { net: 'SIG', startX: 1000, startY: 1000, endX: 1000, endY: 1000, lineWidth: 24 };
	const blockerIds = (out: any) => out.obstacles.filter((o: any) => o.severity === 'blocker').map((o: any) => o.primitiveId).sort();
	r = await checkTraceObstacles({ segments: [{ ...disc, layer: 12 }], includeBoardBoundary: false });
	assert.deepEqual(blockerIds(r), ['L1', 'L15'], 'via on MULTI layer 12 is blocked by a top AND an inner-layer track');
	assert.deepEqual(fetched, [undefined], 'MULTI segment forces an all-layer track fetch');
	r = await checkTraceObstacles({ segments: [{ ...disc, layer: 'MultiLayer' }], includeBoardBoundary: false });
	assert.deepEqual(blockerIds(r), ['L1', 'L15'], 'named MULTI layer behaves the same');
	fetched.length = 0;
	r = await checkTraceObstacles({ segments: [{ ...disc, layer: 1 }], includeBoardBoundary: false });
	assert.deepEqual(blockerIds(r), ['L1'], 'a top-layer segment still sees only top copper');
	assert.deepEqual(fetched, [1]);
	r = await checkTraceObstacles({ segments: [{ ...disc, layer: 12 }, { ...disc, layer: 1, startX: 990, endX: 990 }], includeBoardBoundary: false });
	// Segment 1 sits 10 mil from the inner-layer L15 (would overlap) and 30 from L1 (clear).
	assert.deepEqual(r.obstacles.filter((o: any) => o.segmentIndex === 1 && o.severity === 'blocker').map((o: any) => o.primitiveId), [], 'mixed list: the layer-1 segment stays layer-filtered');
	assert.deepEqual(blockerIds(r), ['L1', 'L15']);

	console.log('Pathfinder rules: Safe Spacing table read in its own unit, implausible values fall back with a reason, real pad shapes block, tools report the rule, MULTI-layer via discs see every copper layer — passed.');
})().catch((err) => { console.error(err); process.exit(1); });
