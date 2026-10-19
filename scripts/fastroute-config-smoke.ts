// Offline checks for the fastroute integration: Specctra parse/write, the
// EasyEDA 10-mil <-> micron round trip, and EasyEDA rules -> fastroute config.
//   npx ts-node --transpile-only scripts/fastroute-config-smoke.ts [board.dsn]
// With a DSN path (an EasyEDA export), the round trip also runs on the real board.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	denormalizeSes,
	normalizeDsnToMicrons,
	parseSexpr,
	readDsnNetwork,
	readResolution,
	replaceNetClasses,
	writeSexpr,
	type SList,
} from '../src/mcp-server/autoroute/specctra';
import { buildFastrouteConfig, pairsFileText, physicalLayerIndex, tuneFileText } from '../src/mcp-server/autoroute/fastroute-config';
import { resolveBoardOutlineClearance } from '../src/shared/drc-rules';
import { addPourPlanes, calibrateFromComponents, calibrateFromVias, dsnPlacements, dsnWiringVias, pourCanvasPolygon, rawSourceVertices } from '../src/mcp-server/autoroute/pour-planes';
import { incompleteNets, newViolations } from '../src/mcp-server/autoroute/board-copper';
import { childLists, dsnNetCopper, firstChild, sesNetCopper, setDsnWiring, shrinkPinPadstacks, stripViaPins } from '../src/mcp-server/autoroute/specctra';
import { sesRoutesToOperations } from '../src/mcp-server/tools/manufacture-tools';

const DSN = `(PCB "T"
  (parser (host_cad "EasyEDA Pro") (host_version "2.2.47.7"))
  (resolution mil 1000)
  (structure
    (boundary (path signal 0 0 0 204.72 0 204.72 149.61 0 149.61 0 0))
    (via via0 via1)
    (rule (clear 0.41))
    (rule (width 1.01))
    (layer 1 (type signal))
    (layer 2 (type signal))
    (layer 15 (type signal))
    (layer 16 (type signal))
  )
  (placement (component u1 (place u1 0 0 front 0)))
  (library
    (image u1
      (pin p0 0 13.78 135.83)
      (pin p0 (rotate 90) 346 157.48 15.75)
    )
    (padstack p0 (shape (circle 1 2.4)) (shape (rect 2 -1 -1 1 1)))
    (padstack via0 (shape (circle 1 2.4)) (shape (circle 2 2.4)))
  )
  (network
    (net USB_D+ (pins u1-0))
    (net USB_D- (pins u1-346))
    (net GND (pins u1-0))
    (class '' (circuit (use_via via0)) (rule (width 1) (clearance 0.4)))
    (class USB_D+ 'USB_D+' (circuit (use_via via0)) (rule (width 1) (clearance 0.4)))
    (class GND 'GND' (circuit (use_via via0)) (rule (width 1) (clearance 0.4)))
  )
  (wiring
    (wire (path 1 4.72 49.41 43.31 63.29 43.31) (net GND) (type protect))
    (via via0 82.68 24.8 (net GND) (type protect))
  )
)`;

// --- parse / write ----------------------------------------------------------
{
	const t = parseSexpr(DSN);
	const again = parseSexpr(writeSexpr(t));
	assert.equal(writeSexpr(again), writeSexpr(t), 'write -> parse -> write is stable');
	assert.deepEqual(readResolution(t), { unit: 'mil', value: 1000 });
	const q = parseSexpr('(pcb (parser (string_quote ")) (net "A B" (pins x-1)))');
	assert.equal(writeSexpr(q).includes('"A B"'), true, 'quoted names survive');
}

// --- network read -------------------------------------------------------------
{
	const net = readDsnNetwork(parseSexpr(DSN));
	assert.deepEqual(net.layers, ['1', '2', '15', '16']);
	assert.deepEqual(net.nets, ['USB_D+', 'USB_D-', 'GND']);
	assert.deepEqual(net.classes.find((c) => c.name === 'USB_D+')?.nets, ['USB_D+'], 'single quotes stripped');
	assert.deepEqual(net.viaPadstacks, ['via0', 'via1']);
}

// --- normalize -> denormalize ---------------------------------------------------
{
	const t = parseSexpr(DSN);
	const norm = normalizeDsnToMicrons(t);
	assert.deepEqual(norm.unhandledNumericKeywords, []);
	assert.deepEqual(readResolution(t), { unit: 'um', value: 10 });
	const structure = t.items.find((n: any) => n.kind === 'list' && n.items[0].text === 'structure') as SList;
	const boundaryPath = (structure.items[1] as SList).items[1] as SList;
	assert.equal(Number((boundaryPath.items[5] as any).text), 204.72 * 254, 'boundary x scaled x254');
	const library = t.items.find((n: any) => n.kind === 'list' && n.items[0].text === 'library') as SList;
	const image = library.items[1] as SList;
	const pin = image.items[2] as SList;
	assert.equal((pin.items[2] as any).text, '0', 'numeric pin id untouched');
	assert.equal(Number((pin.items[3] as any).text), 13.78 * 254);
	const rotated = image.items[3] as SList;
	assert.equal(((rotated.items[2] as SList).items[1] as any).text, '90', 'rotation untouched');
	assert.equal(((structure.items.find((n: any) => n.kind === 'list' && n.items[0].text === 'layer') as SList).items[1] as any).text, '1', 'layer name untouched');

	// fastroute writes SES integers in 0.1 um board units with the DSN resolution
	const sesUm = `(session T (base_design T)
  (placement (resolution um 10) (component u1 (place u1 0 0 front 0)))
  (routes (resolution um 10)
    (library_out (padstack via0 (shape (circle "1" ${2.4 * 2540} 0 0))))
    (network_out
      (net GND
        (wire (path "1" ${4.72 * 2540} ${49.41 * 2540} ${43.31 * 2540} ${63.29 * 2540} ${43.31 * 2540}) (type protect))
        (via via0 ${82.68 * 2540} ${24.8 * 2540} (type protect))
      )
    )
  )
)`;
	const ses = parseSexpr(sesUm);
	denormalizeSes(ses, norm.umPerUnit, norm.original);
	assert.deepEqual(readResolution(ses), { unit: 'mil', value: 1000 });
	const text = writeSexpr(ses);
	assert.ok(text.includes('(path "1" 4720 49410 43310 63290 43310)'), `wire back in EasyEDA board units: ${text}`);
	assert.ok(text.includes('(via via0 82680 24800'), 'via back in EasyEDA board units');
	assert.ok(text.includes('(circle "1" 2400 0 0)'), 'padstack back in EasyEDA board units');
}

// --- rules -> config ------------------------------------------------------------
const ruleConfig = {
	config: {
		Spacing: {
			'Safe Spacing': {
				copperThickness1oz: {
					editName: 'copperThickness1oz', unit: 'mil', isSetDefault: true,
					column: ['Track', 'SMD Pad', 'TH Pad', 'Via', 'Fill Region/Teardrop', 'Slot Region', 'Line', 'Text/Image', 'Board Outline'],
					row: ['Track', 'SMD Pad', 'TH Pad', 'Via', 'Fill Region/Teardrop', 'Slot Region', 'Line', 'Text/Image', 'Board Outline', 'Hole'],
					table: [[4.0157], [4, 4], [4, 4, 4], [4, 4, 4, 4], [4, 4, 4, 4, 4], [11.811], [5.98], [5.98], [11.811, 11.811], [6.9]],
				},
			},
		},
		Physics: {
			Track: {
				copperThickness1oz: { editName: 'copperThickness1oz', unit: 'mil', isSetDefault: true, form: { strokeWidthMin: 4.0157, strokeWidthDefault: 10, strokeWidthMax: 100 } },
				power: { editName: 'power', unit: 'mil', isSetDefault: false, form: { strokeWidthMin: 10, strokeWidthDefault: 20, strokeWidthMax: 100 } },
			},
			'Differential Pair': {
				differentialPair: {
					editName: 'differentialPair', unit: 'mil', isSetDefault: true,
					form: { strokeWidthMin: 5, strokeWidthDefault: 8, strokeWidthMax: 100, differentailPairSpacingMin: 5.9843, differentailPairSpacingMax: 0, differentailPairSpacingDefault: 5.9843, differentailPairLenTolerMax: 10 },
				},
			},
		},
	},
	name: 'Custom Config',
};
const netRules = [
	{ type: 'net', name: 'GND', Track: 'power', 'Safe Spacing': 'default' },
	{ type: 'net', name: 'USB_D+', Track: 'default' },
];

{
	const edge = resolveBoardOutlineClearance(ruleConfig);
	assert.equal(edge.rule?.clearanceMil, 11.811);

	const network = readDsnNetwork(parseSexpr(DSN));
	const cfg = buildFastrouteConfig(network, {
		ruleConfig,
		netRules,
		diffPairs: [{ name: 'USB_D', positiveNet: 'USB_D+', negativeNet: 'USB_D-' }],
		equalLengthGroups: [{ name: 'USB MATCH', nets: ['USB_D+', 'USB_D-'] }, { name: 'empty', nets: [] }],
	}, { rules: 'easyeda', lengthToleranceMm: 0.5, boardThicknessMm: 1.6, clearanceMarginUm: 5 });

	assert.equal(cfg.pairs.length, 1);
	assert.equal(cfg.pairs[0].gapMm, 0.152, 'gap = 5.9843 mil');
	assert.equal(cfg.pairs[0].skewMm, 0.254, 'skew = 10 mil length tolerance');
	assert.equal(cfg.tuneGroups.length, 0, 'pair-equal group and empty group skipped');
	assert.ok(cfg.warnings.some((w) => w.includes('same nets as diff pair')));

	const pairClass = cfg.classes!.find((c) => c.nets.includes('USB_D+'))!;
	assert.equal(pairClass.name, 'pair_USB_D');
	assert.deepEqual(pairClass.nets.sort(), ['USB_D+', 'USB_D-']);
	assert.equal(pairClass.widthUm, 203.2, 'pair width = diff-pair strokeWidthDefault 8 mil');
	assert.equal(pairClass.clearanceUm, 107.1, '4.0157 mil + 5 um, ceil 0.1 um');
	const gnd = cfg.classes!.find((c) => c.nets.includes('GND'))!;
	assert.equal(gnd.widthUm, 508, 'GND on the 20 mil power track rule');
	assert.equal(gnd.useVia, 'via0');
	assert.deepEqual(cfg.noNeckdownClasses, ['pair_USB_D']);
	// Largest rule minimum (GND power 10 mil), capped at the narrowest class (pair 8 mil).
	assert.equal(cfg.minTraceWidthUm, 203.2);
	assert.equal(cfg.edgeClearanceUm, 305);
	// Via lengths are not counted unless asked (EasyEDA's DRC measures tracks only).
	assert.equal(cfg.layerHeightsMm, undefined);
	const withVias = buildFastrouteConfig(network, {
		ruleConfig,
		netRules,
		diffPairs: [{ name: 'USB_D', positiveNet: 'USB_D+', negativeNet: 'USB_D-' }],
	}, { rules: 'easyeda', lengthToleranceMm: 0.5, boardThicknessMm: 1.6, clearanceMarginUm: 5, countViaLengths: true });
	// DSN order 1, 2, 15, 16 = top, bottom, inner1, inner2
	assert.deepEqual(withVias.layerHeightsMm, [0, 1.5512, 0.2454, 1.3256]);
	assert.equal(physicalLayerIndex('16', 4), 2);

	assert.equal(pairsFileText(cfg.pairs), 'pair USB_D+ USB_D- gap=0.152 skew=0.254  # USB_D\n');

	const withGroup = buildFastrouteConfig(network, undefined, {
		rules: 'dsn', lengthToleranceMm: 0.5, boardThicknessMm: 1.6, clearanceMarginUm: 5,
		lengthGroups: [{ name: 'bus a', nets: ['USB_D+', 'GND'], toleranceMm: 0.2 }],
	});
	assert.equal(withGroup.classes, null, 'rules:"dsn" keeps exported classes');
	assert.equal(tuneFileText(withGroup.tuneGroups), 'group bus_a tolerance=0.2\n  USB_D+\n  GND\n');

	const t = parseSexpr(DSN);
	normalizeDsnToMicrons(t);
	replaceNetClasses(t, cfg.classes!);
	const out = writeSexpr(t);
	assert.ok(!out.includes("'USB_D+'"), 'quoted EasyEDA classes removed');
	assert.ok(out.includes('(class pair_USB_D USB_D+ USB_D-'), out);
}

// --- pours -> planes, wiring locks ------------------------------------------------
{
	// DSN origin = board lower-left; canvas Y up, board spans canvas y -1496.063..0.
	const t = parseSexpr(DSN);
	const dsnVias = dsnWiringVias(t);
	assert.deepEqual(dsnVias, [{ x: 82.68, y: 24.8, net: 'GND' }]);
	const cal = calibrateFromVias(
		[...dsnVias, { x: 10, y: 20, net: 'USB_D+' }, { x: 30, y: 40, net: 'GND' }],
		[{ x: 826.8, y: 248 - 1496.063, net: 'GND' }, { x: 100, y: 200 - 1496.063, net: 'USB_D+' }, { x: 300, y: 400 - 1496.063, net: 'GND' }],
	)!;
	assert.equal(cal.support, 3);
	assert.equal(cal.offsetX, 0);
	assert.equal(cal.offsetY, -149.6, 'offset = canvas/10 - dsn');

	// R-mode summary (canvas) -> rounded rectangle polygon
	const full = pourCanvasPolygon({ coordinateSpace: 'canvas-mil-negY', summary: { mode: 'R', rectangle: { rotation: 0, cornerRadius: 39.37 }, bbox: { minX: 0, maxX: 2047.2, minY: -1496.1, maxY: 0 } } });
	assert.ok(!('reason' in full) && full.polygon.length > 20);
	// L-mode: raw source (y down) related to canvas through the summary sample points
	assert.deepEqual(rawSourceVertices([0, 0, 'L', 100, 0, 'ARC', 90, 100, 50]).points, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }]);
	const lpoly = pourCanvasPolygon({ coordinateSpace: 'canvas-mil-negY', source: ['L', 0, 0, 100, 0, 100, 50, 0, 50], summary: { mode: 'L', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: -50 }] } });
	assert.ok(!('reason' in lpoly));
	assert.deepEqual((lpoly as any).polygon[2], { x: 100, y: -50 });

	const network = readDsnNetwork(t);
	const res = addPourPlanes(t, [
		{ primitiveId: 'p15', net: 'GND', layer: 15, pourName: 'L2', polygon: (full as any).polygon, holes: 0 },
		{ primitiveId: 'p1', net: 'GND', layer: 1, pourName: 'TOP', polygon: (full as any).polygon, holes: 0 },
		{ primitiveId: 'px', net: 'NOPE', layer: 2, polygon: (full as any).polygon, holes: 0 },
	], { offsetX: 0, offsetY: -149.6 }, { dsnNets: new Set(network.nets), dsnLayers: network.layers, markPowerLayers: true });
	assert.deepEqual(res.powerLayers, ['15'], 'trace-free solid inner pour becomes a power layer; layer 1 has wiring and is outer');
	assert.equal(res.planes.length, 2);
	assert.ok(res.planes.every((p) => p.shape === 'board-outline'));
	assert.ok(res.warnings.some((w) => w.includes('NOPE')));
	const out = writeSexpr(t);
	assert.ok(/\(layer 15\s*\(type power\)/.test(out));
	assert.ok(out.includes('(plane GND\n') || out.includes('(plane GND'), 'plane emitted');
	assert.equal(res.planes.filter((p) => p.passed).length, 2, 'planes mode passes every pour');

	// innerOnly: only the solid inner (power-layer) plane reaches the DSN.
	const ti = parseSexpr(DSN);
	const inner = addPourPlanes(ti, [
		{ primitiveId: 'p15', net: 'GND', layer: 15, pourName: 'L2', polygon: (full as any).polygon, holes: 0 },
		{ primitiveId: 'p1', net: 'GND', layer: 1, pourName: 'TOP', polygon: (full as any).polygon, holes: 0 },
	], { offsetX: 0, offsetY: -149.6 }, { dsnNets: new Set(network.nets), dsnLayers: network.layers, markPowerLayers: true, innerOnly: true });
	assert.deepEqual(inner.planes.map((p) => [p.dsnLayer, p.passed]), [['15', true], ['1', false]]);
	const innerOut = writeSexpr(ti);
	assert.equal((innerOut.match(/\(plane GND/g) ?? []).length, 1, 'outer pour not written');
	assert.ok(/\(plane GND\s*\(polygon 15 /.test(innerOut), innerOut);

	// Placement-only boards have no vias: calibrate from component positions.
	assert.deepEqual(dsnPlacements(parseSexpr('(PCB x (placement (component img (place R1 10 20 front 0) (place R2 30 40 back 90))))')), [{ ref: 'R1', x: 10, y: 20 }, { ref: 'R2', x: 30, y: 40 }]);
	const parts = [{ ref: 'R1', x: 10, y: 20 }, { ref: 'R2', x: 30, y: 40 }, { ref: 'C1', x: 50, y: 60 }, { ref: 'U1', x: 1, y: 2 }];
	const canvasParts = parts.map((p) => ({ ref: p.ref, x: p.x * 10, y: (p.y - 149.6) * 10 }));
	canvasParts[3] = { ref: 'U1', x: 999, y: 999 }; // one outlier
	assert.deepEqual(calibrateFromComponents(parts, canvasParts), { offsetX: 0, offsetY: -149.6, support: 3 });
	assert.equal(calibrateFromComponents(parts.slice(0, 2), [{ ref: 'R1', x: 0, y: 0 }, { ref: 'R2', x: 5000, y: 0 }]), undefined, 'no majority, no offset');

	// wiring locks + copper metrics
	const w = parseSexpr(DSN);
	const before = dsnNetCopper(w, 0.254);
	assert.equal(before.get('GND')!.vias, 1);
	assert.equal(Math.round(before.get('GND')!.lengthMm * 1e4) / 1e4, Math.round(13.88 * 0.254 * 1e4) / 1e4, 'wire (49.41,43.31)->(63.29,43.31)');
	const counts = setDsnWiring(w, (net) => (net === 'GND' ? 'unlock' : 'keep'));
	assert.deepEqual(counts, { keep: 0, unlock: 2, remove: 0 });
	assert.ok(!writeSexpr(w).includes('protect'));
	setDsnWiring(w, () => 'remove');
	assert.equal(dsnNetCopper(w, 1).size, 0);
	const ses = parseSexpr('(session s (routes (resolution um 10) (network_out (net A (wire (path "1" 100 0 0 30000 40000)) (via v 0 0)))))');
	assert.deepEqual(sesNetCopper(ses, 1 / 10000).get('A'), { lengthMm: 5, vias: 1, wires: 1 });
}

// --- via pins -------------------------------------------------------------------------
{
	// EasyEDA exports each via as a wiring via AND as a numeric image pin on its net.
	const t = parseSexpr(`(PCB "T" (resolution mil 1000)
		(placement (component u1 (place u1 0 0 front 0)))
		(library (image u1 (pin p1 1e1 5 5) (pin v 7 5 5) (pin v 8 6 6)))
		(network (net A (pins u1-1e1 u1-7)) (net B (pins u1-8)))
		(wiring (via v 5 5 (net A) (type protect)) (via v 6 6 (net A) (type protect))))`);
	assert.equal(stripViaPins(t), 1, 'only the numeric pin on a same-net via');
	const out = writeSexpr(t);
	assert.ok(/\(pins\s+u1-1e1\s*\)/.test(out), `component pad on the via kept: ${out}`);
	assert.ok(out.includes('u1-8') && out.includes('(pin v 8 6 6)'), 'pin on another net\'s via kept');
	assert.ok(!out.includes('(pin v 7 5 5)'), 'via pin removed from the image');
	assert.equal(childLists(firstChild(t, 'wiring')!, 'via').length, 2, 'wiring vias stay');
}

// --- abutting pads --------------------------------------------------------------------
{
	// J2 VBUS: 1300 x 300 um pads 300 um apart, i.e. touching; via padstack untouched.
	const t = parseSexpr(`(PCB "T" (structure (via v))
		(library
			(image J (pin p 1 0 0) (pin p 2 0 300) (pin c 3 0 900))
			(padstack p (shape (polygon 1 2.54 -650 150 650 150 650 -150 -650 -150 -650 150)))
			(padstack c (shape (circle 1 500)) (shape (rect 2 -250 -250 250 250)))
			(padstack v (shape (circle 1 600)))))`);
	assert.equal(shrinkPinPadstacks(t, 2), 2);
	const out = writeSexpr(t);
	assert.ok(out.includes('(polygon 1 0 -648 148 648 148 648 -148 -648 -148 -648 148)'), out);
	assert.ok(out.includes('(circle 1 496)') && out.includes('(rect 2 -248 -248 248 248)'), out);
	assert.ok(out.includes('(circle 1 600)'), 'via padstack kept');
}

// --- SES import in the board frame --------------------------------------------------
{
	// PCB_COMPACT: F1 pad 2 at (494.073, -1062.992), D3 pad 1 at (452.756, -863.582);
	// EasyEDA's DSN put them at (49.41, 43.31) and (45.28, 63.25): y + 1496.06 mil.
	const ses = `(session s (routes (resolution mil 1000) (network_out
		(net VIN_FUSED (wire (path "1" 4720 45280 63250 49410 43310)))
		(net GND (wire (path "1" 1000 0 0 1000 0) (type protect)) (via via0 82680 24800 (type protect))))))`;
	const plan = sesRoutesToOperations(ses, { boardOffsetMil: { x: 0, y: -1496, method: 'vias', support: 140 } });
	assert.equal(plan.measurement.coordinateMode, 'board_calibrated');
	assert.deepEqual(plan.operations, [{ type: 'create_track', net: 'VIN_FUSED', layer: 1, startX: 452.8, startY: -863.5, endX: 494.1, endY: -1062.9, lineWidth: 47.2 }], 'fixed GND copper skipped; y shifted by the measured offset');
	// Without an offset the identity canvas transform of this board leaves y off by the board height.
	const identity = sesRoutesToOperations(ses, { coordinateTransform: { mode: 'canvas_to_data', probeDistanceMil: 1000, origin: { x: 0, y: 0 }, xProbe: { x: 1000, y: 0 }, yProbe: { x: 0, y: 1000 } } });
	assert.equal((identity.operations[0] as any).startY, 632.5);
}

// --- DRC before / after -------------------------------------------------------------
{
	const v = (category: string, nets: string[], x: number, y: number, fixCategory?: string) => {
		const where = `${Math.round(x / 5)}|${Math.round(y / 5)}`;
		return { key: `${category}|${nets.slice().sort().join(',')}|${where}`, category, nets, location: { x, y }, ...(fixCategory ? { fixCategory } : {}) };
	};
	const before = { total: 2, violations: [v('Clearance', ['A', 'B'], 100, 100), v('Connection', ['GND'], 0, 0, 'route_missing_connection')] };
	const after = { total: 3, violations: [v('Clearance', ['A', 'B'], 101, 99), v('Clearance', ['A', 'B'], 101, 99), v('Connection', ['VBUS'], 50, 50, 'route_missing_connection')] };
	const added = newViolations(before, after);
	assert.deepEqual(added.map((x) => `${x.category}:${x.nets}`), ['Clearance:A,B', 'Connection:VBUS'], 'same spot on the 5 mil grid is carried over once; the duplicate and the new net are new');
	assert.deepEqual(Array.from(incompleteNets(before)), ['GND']);
	assert.deepEqual(Array.from(incompleteNets({ total: 1, violations: [v('Clearance', ['X'], 0, 0, 'clearance_or_short')] })), [], 'a clearance violation is not a missing connection');
}

// --- real board -------------------------------------------------------------------
const realPath = process.argv[2];
if (realPath) {
	const original = readFileSync(realPath, 'utf8');
	const t = parseSexpr(original);
	const norm = normalizeDsnToMicrons(t);
	assert.deepEqual(norm.unhandledNumericKeywords, [], `unhandled numeric keywords on the real board: ${norm.unhandledNumericKeywords}`);
	// Round trip the real wiring: normalized DSN -> SES board units (x10, as
	// fastroute writes them) -> denormalized, against the original x1000.
	const section = (tree: SList, head: string) => tree.items.find((n: any) => n.kind === 'list' && n.items[0].text === head) as SList;
	// Geometric numbers of a (wire (path L W x y ...)) or (via P x y): everything but the layer / padstack.
	const geometry = (w: SList): number[] => {
		const shape = w.items[1] as any;
		if (headOfItem(w) === 'via') return [Number((w.items[2] as any).text), Number((w.items[3] as any).text)];
		return shape.items.slice(2).map((a: any) => Number(a.text));
	};
	const toBoardUnits = (w: SList): SList => {
		const copy: SList = JSON.parse(JSON.stringify(w));
		if (headOfItem(copy) === 'via') for (const k of [2, 3]) (copy.items[k] as any).text = String(Math.round(Number((copy.items[k] as any).text) * 10));
		else for (const a of (copy.items[1] as SList).items.slice(2) as any[]) a.text = String(Math.round(Number(a.text) * 10));
		return copy;
	};
	const ses = parseSexpr('(session x (routes (resolution um 10) (network_out)))');
	const netOut = (ses.items[2] as SList).items[2] as SList;
	for (const w of section(t, 'wiring').items.slice(1) as SList[]) netOut.items.push(toBoardUnits(w));
	denormalizeSes(ses, norm.umPerUnit, norm.original);
	const origWiring = section(parseSexpr(original), 'wiring').items.slice(1) as SList[];
	let compared = 0;
	let worst = 0;
	origWiring.forEach((w, i) => {
		const a = geometry(w);
		const b = geometry(netOut.items[i + 1] as SList);
		a.forEach((v, k) => { worst = Math.max(worst, Math.abs(v * 1000 - b[k])); compared++; });
	});
	assert.ok(compared > 0 && worst <= 1, `round trip within 1 board unit (0.001 DSN unit), worst ${worst}`);
	const viaCount = origWiring.filter((w) => headOfItem(w) === 'via').length;
	const stripped = parseSexpr(original);
	const viaPins = stripViaPins(stripped);
	assert.equal(viaPins, viaCount, 'every exported via had a pin twin');
	console.log(`real board: ${origWiring.length} wires/vias, ${compared} numbers round-tripped, worst error ${worst} board units; ${viaPins} via pins stripped`);
}

function headOfItem(n: SList): string {
	return (n.items[0] as any).text;
}

console.log('fastroute-config-smoke: ok');
