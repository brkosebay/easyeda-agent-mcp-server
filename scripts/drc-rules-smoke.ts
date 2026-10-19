// Shared DRC-rule parser (src/shared/drc-rules.ts): Track width and Via Size
// rules per net, in mm and mil profiles, plus its two consumers outside the
// pathfinder — routing presets (extension) and the obstacle-map analyzer (MCP).
// Rule payloads mirror EasyEDA Pro 2.2.47: the mm values are the shipped
// "JLCPCB Capability(Two Layers Board)" profile.
// Run: npx ts-node --transpile-only scripts/drc-rules-smoke.ts
import assert from 'node:assert/strict';
import {
	clearanceForNet,
	netsWithRules,
	resolveTrackWidth,
	resolveViaSize,
	ruleValueToMil,
	trackWidthForNet,
	viaSizeForNet,
} from '../src/shared/drc-rules';
import { buildObstacleMap } from '../src/mcp-server/analyzers/obstacle-map';

const near = (actual: number | undefined, expected: number, msg?: string) =>
	assert.ok(actual != null && Math.abs(actual - expected) < 0.01, `${msg ?? ''} expected ~${expected}, got ${actual}`);

const ROWS = ['Track', 'SMD Pad', 'TH Pad', 'Via', 'Fill Region/Teardrop', 'Slot Region', 'Line', 'Text/Image', 'Board Outline', 'Hole'];
const table = (tt: number, other: number) => ROWS.map((_, r) => Array.from({ length: Math.min(r + 1, 9) }, (_, c) => (r === 0 && c === 0 ? tt : other)));
const jlcPhysics = {
	Track: {
		copperThickness1oz: { editName: 'copperThickness1oz', form: { strokeWidthDefault: 0.254, strokeWidthMax: 2.54, strokeWidthMin: 0.127 }, isSetDefault: true, unit: 'mm' },
		copperThickness2oz: { editName: 'copperThickness2oz', form: { strokeWidthDefault: 0.254, strokeWidthMax: 2.54, strokeWidthMin: 0.203 }, isSetDefault: false, unit: 'mm' },
	},
	'Via Size': {
		viaSize: { editName: 'viaSize', form: { viaInnerdiameterDefault: 0.305, viaInnerdiameterMax: 6.3, viaInnerdiameterMin: 0.3, viaOuterdiameterDefault: 0.61, viaOuterdiameterMax: 10, viaOuterdiameterMin: 0.5 }, isSetDefault: true, unit: 'mm' },
	},
	// Never a width: the old fuzzy /width|trace/ search could land on these.
	'Differential Pair': { differentialPair: { editName: 'differentialPair', form: { strokeWidthDefault: 0.1, differentailPairSpacingMin: 0.152 }, isSetDefault: true, unit: 'mm' } },
};
const netRules: any[] = [
	{ type: 'netClass', name: 'POWER', 'Safe Spacing': 'copperThickness2oz', Track: 'copperThickness2oz', 'Via Size': 'default', sub: [{ type: 'net', name: 'VBUS', 'Safe Spacing': 'copperThickness2oz', Track: 'copperThickness2oz', 'Via Size': 'default' }] },
	{ type: 'net', name: 'SIG', 'Safe Spacing': 'default', Track: 'default', 'Via Size': 'default' },
	{ type: 'net', name: 'GHOST', Track: 'gone' },
];
const jlc: any = {
	Rule: {
		Spacing: { 'Safe Spacing': {
			copperThickness1oz: { editName: 'copperThickness1oz', unit: 'mm', isSetDefault: true, row: ROWS, column: ROWS.slice(0, 9), table: table(0.102, 0.152) },
			copperThickness2oz: { editName: 'copperThickness2oz', unit: 'mm', isSetDefault: false, row: ROWS, column: ROWS.slice(0, 9), table: table(0.203, 0.152) },
		} },
		Physics: jlcPhysics,
	},
	Net: netRules,
	ruleTemplateName: 'JLCPCB Capability(Two Layers Board)',
};
const milProfile: any = {
	Rule: {
		Spacing: { 'Safe Spacing': { default: { editName: 'default', unit: 'mil', isSetDefault: true, row: ROWS, column: ROWS.slice(0, 9), table: table(6, 6) } } },
		Physics: {
			Track: { default: { editName: 'default', unit: 'mil', isSetDefault: true, form: { strokeWidthMin: 6, strokeWidthDefault: 10, strokeWidthMax: 100 } } },
			'Via Size': { default: { editName: 'default', unit: 'mil', isSetDefault: true, form: { viaOuterdiameterMin: 20, viaOuterdiameterDefault: 24, viaOuterdiameterMax: 400, viaInnerdiameterMin: 10, viaInnerdiameterDefault: 12, viaInnerdiameterMax: 250 } } },
		},
	},
	ruleTemplateName: 'Mil Board',
};

(async () => {
	// --- 1. Track width: mm profile, default rule and net-class rule ---
	assert.equal(ruleValueToMil(0.254, 'mm'), 10);
	assert.equal(ruleValueToMil(1, 'parsec'), undefined);
	let w = trackWidthForNet(jlc, netRules, 'SIG')!;
	near(w.widthMil, 10, 'strokeWidthDefault 0.254 mm');
	near(w.minMil, 5, 'strokeWidthMin 0.127 mm');
	near(w.maxMil, 100, 'strokeWidthMax 2.54 mm');
	assert.equal(w.unit, 'mm');
	assert.equal(w.ruleName, 'copperThickness1oz');
	assert.equal(w.assignedBy, undefined, 'SIG uses the board default rule');
	assert.equal(w.source, 'rule:JLCPCB Capability(Two Layers Board)/Track/copperThickness1oz');
	assert.equal(w.ruleKey, 'Rule.Physics["Track"]["copperThickness1oz"].form.strokeWidthDefault');
	w = trackWidthForNet(jlc, netRules, 'VBUS')!;
	near(w.minMil, 7.992, 'class POWER -> copperThickness2oz min 0.203 mm');
	assert.equal(w.assignedBy, 'net class POWER -> VBUS');
	assert.match(w.source, /Track\/copperThickness2oz \(net class POWER -> VBUS\)/);
	w = trackWidthForNet(jlc, netRules, 'GHOST')!;
	assert.equal(w.ruleName, 'copperThickness1oz');
	assert.match(w.source, /net rule GHOST rule "gone" not found; default rule used/);
	near(trackWidthForNet(jlc, undefined, 'SIG')!.widthMil, 10, 'net rows fall back to the config Net array');
	// Stored-profile shape ({name, config:{...}}) and a mil profile.
	near(trackWidthForNet({ name: 'stored', config: { Physics: jlcPhysics } }, [], 'X')!.widthMil, 10);
	w = trackWidthForNet(milProfile, [], 'ANY')!;
	assert.deepEqual([w.widthMil, w.minMil, w.maxMil, w.unit], [10, 6, 100, 'mil']);

	// --- 2. Via size: mm and mil ---
	let v = viaSizeForNet(jlc, netRules, 'SIG')!;
	near(v.diameterMil, 24.016, 'viaOuterdiameterDefault 0.61 mm');
	near(v.drillMil, 12.008, 'viaInnerdiameterDefault 0.305 mm');
	near(v.minDiameterMil, 19.685);
	near(v.minDrillMil, 11.811);
	near(v.maxDiameterMil, 393.701);
	assert.equal(v.source, 'rule:JLCPCB Capability(Two Layers Board)/Via Size/viaSize');
	v = viaSizeForNet(milProfile, [], 'ANY')!;
	assert.deepEqual([v.diameterMil, v.drillMil, v.minDiameterMil, v.maxDrillMil], [24, 12, 20, 250]);

	// --- 3. unusable rules: undefined plus a reason, never a guessed number ---
	assert.equal(trackWidthForNet(undefined, undefined, 'SIG'), undefined);
	assert.equal(resolveTrackWidth(undefined, undefined, 'SIG').reason, 'no DRC rule configuration readable');
	const noUnit = { Rule: { Physics: { Track: { t: { editName: 't', isSetDefault: true, form: { strokeWidthDefault: 0.254 } } } } } };
	assert.match(resolveTrackWidth(noUnit, [], 'SIG').reason!, /strokeWidthDefault = 0\.254 with unknown unit "" is implausible as mil/);
	const huge = { Rule: { Physics: { Track: { t: { editName: 't', isSetDefault: true, unit: 'mm', form: { strokeWidthDefault: 50 } } } } } };
	assert.match(resolveTrackWidth(huge, [], 'SIG').reason!, /1968\.504 mil is outside the plausible 1-1000 mil range/);
	const badVia = { Rule: { Physics: { 'Via Size': { v: { editName: 'v', isSetDefault: true, unit: 'mm', form: { viaOuterdiameterDefault: 0.3, viaInnerdiameterDefault: 0.4 } } } } } };
	assert.match(resolveViaSize(badVia, [], 'SIG').reason!, /drill 15\.748 mil is not smaller than its diameter 11\.811 mil/);
	assert.match(resolveViaSize({ Rule: { Physics: {} } }, [], 'SIG').reason!, /has no Rule\.Physics\["Via Size"\] rules/);
	assert.equal(resolveTrackWidth({ Rule: { Physics: { Track: { t: { editName: 't', isSetDefault: false, unit: 'mm', form: { strokeWidthDefault: 0.2 } }, u: { editName: 'u', isSetDefault: false, unit: 'mm', form: { strokeWidthDefault: 0.3 } } } } } }, [], 'SIG').reason, 'no Track rule is marked isSetDefault');

	// Clearance from the shared module directly (the same parser trace-obstacles re-exports).
	near(clearanceForNet(jlc, netRules, 'SIG').clearanceMil, 4.016);
	near(clearanceForNet(jlc, netRules, 'VBUS').clearanceMil, 7.992);
	assert.deepEqual(netsWithRules(jlc, netRules).sort(), ['GHOST', 'SIG', 'VBUS']);

	// --- 4. obstacle-map (MCP side) resolves net rules through the shared parser ---
	let map = buildObstacleMap({}, { netRules: jlc });
	near(map.netRules.SIG.clearanceMil, 4.016);
	near(map.netRules.SIG.widthMil, 10);
	near(map.netRules.VBUS.minWidthMil, 7.992);
	assert.match(map.netRules.VBUS.clearanceSource!, /^rule:JLCPCB.*copperThickness2oz/);
	near(map.netRules.SIG.clearanceByKind?.via, 5.984);
	map = buildObstacleMap({}, { netRules, ruleConfig: jlc });
	near(map.netRules.VBUS.clearanceMil, 7.992, 'bare rows + options.ruleConfig');
	map = buildObstacleMap({}, { netRules: { ruleConfig: jlc, netRules } });
	near(map.netRules.SIG.widthMil, 10, '{ruleConfig, netRules} payload');
	map = buildObstacleMap({}, { netRules, defaultClearanceMil: 6, defaultWidthMil: 8 });
	assert.equal(map.netRules.SIG.clearanceMil, 6, 'names only: option default, not a fuzzy-matched number');
	assert.equal(map.netRules.SIG.widthMil, 8);
	assert.match(map.netRules.SIG.clearanceSource!, /^default \(no rule configuration supplied/);
	map = buildObstacleMap({}, { netRules: [{ net: 'HAND', widthMil: 12, clearanceMil: 7 }] });
	assert.deepEqual([map.netRules.HAND.widthMil, map.netRules.HAND.clearanceMil, map.netRules.HAND.widthSource], [12, 7, 'payload:widthMil']);

	// --- 5. routing presets (extension): rules win, heuristics are labelled ---
	let currentRules: any = jlc;
	(globalThis as any).eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'drc-rules-doc', documentType: 3 }) },
		pcb_PrimitiveComponent: { getAll: async () => [], getAllPinsByPrimitiveId: async () => [] },
		pcb_PrimitiveLine: { getAll: async () => [] },
		pcb_PrimitiveVia: { getAll: async () => [] },
		pcb_PrimitivePad: { getAll: async () => [] },
		pcb_PrimitivePour: { getAll: async () => [] },
		pcb_PrimitiveRegion: { getAll: async () => [] },
		pcb_PrimitivePolyline: { getAll: async () => [] },
		pcb_Layer: { getAllLayers: async () => [] },
		pcb_Net: { getAllNetsName: async () => ['SIG', 'VBUS', 'GND'], getNetLength: async () => 0 },
		pcb_Drc: {
			getCurrentRuleConfiguration: async () => currentRules,
			getNetRules: async () => (currentRules ? netRules : undefined),
			// getAllNetClasses / getAllDifferentialPairs deliberately missing: must not throw.
		},
	};
	const { boardContextHandlers } = await import('../src/extension/handlers/board-context');
	const presetsFor = async () => (await boardContextHandlers['pcb.routing.presets']({ nets: ['SIG', 'VBUS', 'GND', 'USB_DP'], forceRefresh: true })).presets;
	let p = await presetsFor();
	near(p.SIG.lineWidth, 10);
	assert.match(p.SIG.source.lineWidth, /^rule:JLCPCB.*\/Track\/copperThickness1oz$/);
	near(p.SIG.clearanceMil, 4.016);
	assert.match(p.SIG.source.clearanceMil, /^rule:.*Safe Spacing\/copperThickness1oz/);
	near(p.SIG.diameter, 24.016);
	near(p.SIG.holeDiameter, 12.008);
	assert.match(p.SIG.source.diameter, /^rule:.*Via Size\/viaSize/);
	near(p.SIG.minLineWidth, 5);
	assert.equal(p.SIG.heuristic.lineWidth, 8, 'what the heuristic alone would have said is still visible');
	// VBUS has its own (class) Track rule -> that rule's default width, not the 30-mil heuristic.
	near(p.VBUS.lineWidth, 10);
	assert.match(p.VBUS.source.lineWidth, /copperThickness2oz \(net class POWER -> VBUS\)/);
	near(p.VBUS.clearanceMil, 7.992);
	// GND rides the board default rule: heuristic 20 mil kept, inside the rule's 5..100 limits.
	assert.equal(p.GND.lineWidth, 20);
	assert.match(p.GND.source.lineWidth, /^heuristic \(ground net heuristic\) within rule:.*Track\/copperThickness1oz min\/max$/);
	near(p.USB_DP.lineWidth, 10, 'diff/USB signal nets take the rule default width');

	currentRules = undefined;
	p = await presetsFor();
	assert.equal(p.SIG.lineWidth, 8);
	assert.match(p.SIG.source.lineWidth, /^heuristic \(default signal; no DRC rule configuration readable\)$/);
	assert.match(p.SIG.source.clearanceMil, /^heuristic \(default signal; no DRC rule configuration readable\)$/);
	assert.equal(p.VBUS.lineWidth, 30);
	assert.equal(p.SIG.heuristic, undefined);

	const worklist = await boardContextHandlers['pcb.context.netWorklist']({ includeSinglePad: true });
	assert.ok(Array.isArray(worklist.nets));

	console.log('DRC rules: Track width and Via Size read per net in mm and mil, unusable rules return a reason, obstacle-map and routing presets use the shared parser with per-value sources — passed.');
})().catch((err) => { console.error(err); process.exit(1); });
