// Payload/offender fixes:
//   1. pcb_run_drc verbose leaves carry primitiveIds/pads (same rules as
//      drc.ts extractDrcOffenders), objs/sourceUnits dropped;
//   2. pcb.extract.design reads the SDK `otherProperty` bag (no raw-primitive
//      fallback), manufacturerId → mpn, pad units once; slimSnapshot still
//      cleans pre-fix extension output;
//   7. sch_extract_design omits pinIndex unless asked, supports `fields`;
//   8. sch.drc.summarize matches pcb.drc.summarize (passed, primitiveIds) and
//      net labels named after their net are not components.
// Run: npx ts-node --transpile-only scripts/payload-trim-smoke.ts
import assert from 'node:assert/strict';
import { z } from 'zod';

type Handler = (args: any) => Promise<any>;
function fakeServer() {
	const tools: Record<string, Handler> = {};
	const schemas: Record<string, any> = {};
	const descriptions: Record<string, string> = {};
	const server = { tool: (name: string, description: string, schema: any, handler: Handler) => { tools[name] = handler; schemas[name] = schema; descriptions[name] = description; } };
	// Parse through the real zod shape so undeclared keys are stripped as in the MCP SDK.
	const call = async (name: string, args: any) => tools[name](z.object(schemas[name]).parse(args));
	return { server, tools, schemas, descriptions, call };
}
const text = (r: any) => r.content[0].text as string;
const json = (r: any) => JSON.parse(text(r));

// --- PCB DRC leaves (raw EasyEDA units; normalizeDrcUnits scales ×10) ---
const connC1 = {
	errorType: 'Connection Error', errorObjType: 'SMD Pad', obj1: { typeName: 'SMD Pad', suffix: '(GND): C1_1' },
	net: 'GND', objs: ['e6e8'], globalIndex: 'err397', pos: { x: 100.2972, y: -148 },
};
const connR21 = { errorType: 'Connection Error', errorObjType: 'SMD Pad', obj1: { typeName: 'SMD Pad', suffix: '(GND): R21_2' }, net: 'GND', globalIndex: 'err398' };
const clearTrackPad = {
	errorType: 'Clearance Error', errorObjType: 'Track to SMD Pad',
	obj1: { typeName: 'Track', suffix: '(GND): e25457' }, obj2: { typeName: 'SMD Pad', suffix: '(+3V3): U3_41' },
	objs: ['e25457', 'e3e41'], globalIndex: 'err4287',
};
const clearViaTrack = {
	errorType: 'Clearance Error', errorObjType: 'Via to Track',
	obj1: { typeName: 'Via', suffix: '(+3V3): e900', globalIndex: 'err12' }, obj2: { typeName: 'Track', id: 'e901' }, globalIndex: 'err4288',
};
const netIndexed = { errorType: 'Connection Error', errorObjType: 'Net', globalIndex: 'GND', globalIndexIsNet: true, objs: ['e77'] };
const pcbTree = [
	{ name: 'Connection Error', list: [{ name: 'GND', list: [connC1, connR21] }, { name: 'Nets', list: [netIndexed] }] },
	{ name: 'Clearance Error', list: [{ name: 'Track to SMD Pad', list: [clearTrackPad] }, { name: 'Via to Track', list: [clearViaTrack] }] },
];

// --- Schematic DRC leaves (plausible: same leaf shape, pins read like pads) ---
const schPinU3a = { errorType: 'Connection Error', errorObjType: 'Pin', obj1: { typeName: 'Pin', suffix: '(No Net): U3_7' }, objs: ['e12'], globalIndex: 'err3' };
const schPinU3b = { errorType: 'Connection Error', errorObjType: 'Pin', obj1: { typeName: 'Pin', suffix: '(No Net): U3_8' }, objs: ['e13'], globalIndex: 'err4' };
// A real diode pin sitting on net "D1" must still group under D1.
const schDiodePin = { errorType: 'Connection Error', errorObjType: 'Pin', obj1: { typeName: 'Pin', suffix: '(D1): D1_2' }, objs: ['e30'], globalIndex: 'err8' };
// Data-bus net label "D1" — not component D1.
const schNetLabel = { errorType: 'Net Error', errorObjType: 'Net Label', obj1: { typeName: 'Net Label', suffix: '(D1): D1' }, objs: ['e88'], net: 'D1', globalIndex: 'err5' };
// Power flag whose typeName gives no hint: label equals its net.
const schPowerFlag = { errorType: 'Net Error', errorObjType: 'Power', obj1: { typeName: 'Power', suffix: '(VCC3): VCC3' }, globalIndex: 'err6' };
// Net label known only by its primitive id: the id survives.
const schLabelById = { errorType: 'Net Error', errorObjType: 'Net Label', obj1: { typeName: 'Net Label', suffix: '(D2): e90' }, globalIndex: 'err9' };
const schDupDesignator = {
	errorType: 'Designator Error', errorObjType: 'Component',
	obj1: { typeName: 'Component', suffix: 'R5' }, obj2: { typeName: 'Component', suffix: 'R5' }, objs: ['e20', 'e21'], globalIndex: 'err7',
};
const schTree = [
	{ name: 'Connection Error', list: [schPinU3a, schPinU3b, schDiodePin] },
	{ name: 'Net Error', list: [schNetLabel, schPowerFlag, schLabelById] },
	{ name: 'Designator Error', list: [schDupDesignator] },
];

// --- PCB components for pcb.extract.design ---
const bagR1 = { Description: 'Thick film resistor', Value: '10k', Datasheet: 'https://x/ds.pdf', Tolerance: '1%', Voltage: 50, Lead: true, Notes: 'x'.repeat(300) };
const rawR1: any = {
	async: true, primitiveType: 'Component', primitiveId: 'e1', component: { libraryUuid: 'lib', uuid: 'dev' },
	footprint: { libraryUuid: 'lib', uuid: 'fp', name: 'R0603' }, layer: 1, x: 100, y: -200, rotation: 90,
	designator: 'R1', name: '10k', manufacturer: 'Yageo', manufacturerId: 'RC0603FR-0710KL', supplier: 'LCSC', supplierId: 'C98220',
	otherProperty: bagR1,
};
rawR1.getState_OtherProperty = () => bagR1;
// No property bag at all — pre-fix this leaked the whole primitive.
const rawU1: any = {
	async: true, primitiveType: 'Component', primitiveId: 'e2', component: { libraryUuid: 'lib', uuid: 'dev2', nested: { deep: true } },
	layer: 1, x: 0, y: 0, rotation: 0, designator: 'U1', manufacturerId: 'STM32F103C8T6',
};
const pcbPins: Record<string, any[]> = {
	e1: [{ padNumber: '1', net: 'VCC', layer: 1, x: 10, y: -20 }, { padNumber: '2', net: 'GND', layer: 1, x: 11, y: -20 }],
	e2: [{ padNumber: '1', net: 'GND', layer: 1, x: 0, y: 0 }],
};

let schDrcResult: any = schTree;
(globalThis as any).eda = {
	pcb_Drc: { check: async () => pcbTree },
	sch_Drc: { check: async () => schDrcResult },
	dmt_Project: { getCurrentProjectInfo: async () => ({ name: 'P', uuid: 'p1' }) },
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'd1', name: 'PCB1', type: 3 }) },
	pcb_Layer: { getAllLayers: async () => [{ name: 'TopLayer', id: 1 }] },
	pcb_PrimitiveComponent: {
		getAll: async () => [rawR1, rawU1],
		getAllPinsByPrimitiveId: async (id: string) => pcbPins[id] ?? [],
	},
	pcb_Net: { getAllNetsName: async () => ['VCC', 'GND'] },
	pcb_PrimitiveVia: { getAll: async () => [] },
	pcb_PrimitiveLine: { getAll: async () => [] },
	pcb_PrimitiveRegion: { getAll: async () => [] },
};

(async () => {
	const drc = await import('../src/extension/handlers/drc');

	// ===== 1. pcb_run_drc =====
	const { registerReadTools, drcLeafOffenders } = await import('../src/mcp-server/tools/read-tools');
	// The MCP-side parser must agree with the extension's extractDrcOffenders.
	for (const leaf of [connC1, connR21, clearTrackPad, clearViaTrack, netIndexed, schPinU3a, schDupDesignator, schLabelById]) {
		const ref = drc.extractDrcOffenders(leaf);
		const got = drcLeafOffenders(leaf);
		assert.deepEqual(got.primitiveIds, ref.primitiveIds, `primitiveIds parity for ${leaf.globalIndex}`);
		assert.deepEqual(got.pads, ref.pads, `pads parity for ${leaf.globalIndex}`);
	}
	const read = fakeServer();
	let drcVerbose = true;
	registerReadTools(read.server as any, { send: async (method: string, p: any) => {
		assert.equal(method, 'pcb.drc.check');
		return drcVerbose ? drc.drcHandlers['pcb.drc.check'](p) : true;
	} } as any);
	assert.match(read.descriptions.pcb_run_drc, /primitiveIds/);
	const verboseRes = await read.call('pcb_run_drc', { document: 'd', verbose: true });
	assert.ok(!text(verboseRes).includes('sourceUnits'), 'per-node sourceUnits dropped');
	const leaves = drc.flattenDrcTree(json(verboseRes));
	assert.equal(leaves.length, 5, 'tree shape kept');
	const byErr = (id: string) => leaves.find((l: any) => l.globalIndex === id);
	assert.deepEqual(byErr('err4287').primitiveIds, ['e25457', 'e3e41']);
	assert.deepEqual(byErr('err4287').pads, [{ component: 'U3', pad: '41' }]);
	assert.equal(byErr('err4287').objs, undefined, 'objs superseded by primitiveIds');
	assert.equal(byErr('err4287').units, 'mil');
	assert.deepEqual(byErr('err397').pos, { x: 1002.972, y: -1480 }, 'units still normalized');
	assert.equal(byErr('err398').primitiveIds, undefined, 'suffix-only pad: no ids');
	assert.deepEqual(byErr('err398').pads, [{ component: 'R21', pad: '2' }]);
	assert.deepEqual(byErr('err4288').primitiveIds.slice().sort(), ['e900', 'e901']);
	assert.ok(leaves.every((l: any) => !(l.primitiveIds ?? []).some((id: string) => /^err\d+$/.test(id))), 'no DRC ids as primitives');
	assert.deepEqual(leaves.find((l: any) => l.globalIndex === 'GND').primitiveIds, ['e77']);
	drcVerbose = false;
	assert.equal(text(await read.call('pcb_run_drc', { document: 'd' })), 'true', 'pass/fail boolean untouched');

	// ===== 2. pcb.extract.design + pcb_extract_design =====
	const { pcbExtractHandlers } = await import('../src/extension/handlers/pcb-extract');
	const snap: any = await pcbExtractHandlers['pcb.extract.design']({ includeAllPads: true });
	const r1 = snap.components.e1;
	assert.deepEqual(r1.otherProperties, { Description: 'Thick film resistor', Value: '10k', Tolerance: '1%', Voltage: 50, Lead: true }, 'bag: Datasheet + long strings dropped, description kept');
	assert.equal(r1.mpn, 'RC0603FR-0710KL', 'manufacturerId is the MPN');
	assert.equal(r1.manufacturer, 'Yageo');
	assert.equal(r1.supplierId, 'C98220');
	assert.equal(r1.name, '10k');
	assert.equal(r1.footprint, 'R0603');
	const u1 = snap.components.e2;
	assert.equal(u1.otherProperties, undefined, 'no bag → no otherProperties (no raw-primitive fallback)');
	assert.equal(u1.mpn, 'STM32F103C8T6');
	const compJson = JSON.stringify(snap.components);
	for (const junk of ['primitiveType', '"async"', 'libraryUuid', 'nested']) assert.ok(!compJson.includes(junk), `no SDK junk (${junk})`);
	assert.equal(snap.padUnits, 'mil');
	assert.equal(snap.pads.length, 3);
	assert.ok(snap.pads.every((p: any) => p.units === undefined && p.sourceUnits === undefined), 'no per-pad unit strings');
	assert.equal(snap.pads.find((p: any) => p.designator === 'R1' && p.padNumber === '1').x, 100, 'pad coords scaled to mil');
	assert.equal(snap.nets.GND.pinCount, 2);
	const noPads: any = await pcbExtractHandlers['pcb.extract.design']({});
	assert.equal(noPads.padUnits, undefined);
	assert.equal(noPads.padCount, 3);
	const verboseSnap: any = await pcbExtractHandlers['pcb.extract.design']({ verbose: true });
	assert.equal(verboseSnap.components.e1.otherProperties.Description, 'Thick film resistor', 'verbose keeps the full bag');
	assert.equal(verboseSnap.components.e1.otherProperties.Notes.length, 300);

	const { registerPcbExtractTools, slimSnapshot } = await import('../src/mcp-server/tools/pcb-extract-tools');
	const ext = fakeServer();
	registerPcbExtractTools(ext.server as any, { send: async (_m: string, p: any) => pcbExtractHandlers['pcb.extract.design'](p) } as any);
	assert.deepEqual(json(await ext.call('pcb_extract_design', { document: 'd', includeAllPads: true })), JSON.parse(JSON.stringify(snap)), 'slimSnapshot is a no-op on new output');
	// Pre-fix extension output: raw primitive as otherProperties + per-pad units.
	const legacy = slimSnapshot({
		components: { e2: { designator: 'U1', otherProperties: { async: true, primitiveType: 'Component', x: 0, manufacturerId: 'STM32F103C8T6', otherProperty: { Tolerance: '5%', Datasheet: 'http://x' }, component: {} } } },
		pads: [{ designator: 'U1', padNumber: '1', units: 'mil', sourceUnits: 'EasyEDA component-pad units (10 mil); normalized by MCP' }],
	});
	assert.deepEqual(legacy.components.e2, { designator: 'U1', mpn: 'STM32F103C8T6', otherProperties: { Tolerance: '5%' } });
	assert.deepEqual(legacy.pads, [{ designator: 'U1', padNumber: '1' }]);
	assert.equal(legacy.padUnits, 'mil');

	// ===== 7. sch_extract_design =====
	const schSnap = {
		componentCount: 2, netCount: 1,
		components: {
			R1: { designator: 'R1', primitiveId: 'p1', deviceClass: 'resistor', value: '10kΩ', pins: { 1: { name: '', net: 'VCC' }, 2: { name: '', net: 'EN' } } },
			U1: { designator: 'U1', primitiveId: 'p2', deviceClass: 'ic', pins: { 5: { name: 'EN', net: 'EN' } } },
		},
		nets: { EN: { name: 'EN', pinCount: 2, members: [{ designator: 'R1', pinNumber: '2', pinName: '' }, { designator: 'U1', pinNumber: '5', pinName: 'EN' }], isPower: false, isGround: false, autoNamed: false } },
		pinIndex: [{ designator: 'R1', pinNumber: '1', pinName: '' }, { designator: 'R1', pinNumber: '2', pinName: '' }, { designator: 'U1', pinNumber: '5', pinName: 'EN' }],
		stats: { byClass: { resistor: 1, ic: 1 }, passiveByValue: { resistors: 1, capacitors: 0, inductors: 0 }, nets: { power: 0, ground: 0, signal: 1, autoNamed: 0 } },
	};
	const { registerSchAnalysisTools } = await import('../src/mcp-server/tools/sch-analysis-tools');
	const sch = fakeServer();
	const schSends: any[] = [];
	registerSchAnalysisTools(sch.server as any, { send: async (method: string, p: any) => { schSends.push({ method, p }); return JSON.parse(JSON.stringify(schSnap)); } } as any);
	const full = json(await sch.call('sch_extract_design', { document: 'd' }));
	assert.equal(full.pinIndex, undefined, 'pinIndex dropped by default');
	assert.deepEqual(full.components, schSnap.components);
	assert.deepEqual(full.nets, schSnap.nets);
	assert.equal(schSends[0].p.fields, undefined, 'fields handled MCP-side');
	const projected = json(await sch.call('sch_extract_design', { document: 'd', fields: ['nets', 'pinIndex'] }));
	assert.deepEqual(Object.keys(projected).sort(), ['_availableFields', 'nets', 'pinIndex']);
	assert.equal(projected.pinIndex.length, 3, 'pinIndex on request');
	assert.ok(projected._availableFields.includes('components'));
	// Analyzers still work on the agent-facing (pinIndex-free) snapshot.
	const traced = json(await sch.call('sch_trace_net', { document: 'd', net: 'EN', snapshot: full }));
	assert.equal(traced.memberCount, 2);
	assert.equal(traced.passives[0].otherNet, 'VCC');
	const explained = json(await sch.call('sch_explain_component', { document: 'd', designator: 'R1', snapshot: full }));
	assert.ok(explained && !explained.error, JSON.stringify(explained));

	// ===== 8. sch.drc.summarize =====
	const { schDocumentHandlers, sanitizeSchDrcLeaf } = await import('../src/extension/handlers/sch-document');
	assert.equal(sanitizeSchDrcLeaf(schPinU3a), schPinU3a, 'pins untouched');
	assert.equal(sanitizeSchDrcLeaf(schNetLabel).obj1.suffix, undefined);
	assert.equal(sanitizeSchDrcLeaf(schLabelById).obj1.suffix, '(D2): e90', 'primitive id suffix kept');
	const byCat: any = await schDocumentHandlers['sch.drc.summarize']({ groupBy: 'category' });
	assert.equal(byCat.passed, false);
	assert.equal(byCat.totalViolations, 7);
	const cat = new Map<string, any>(byCat.topGroups.map((g: any) => [g.key, g]));
	const pinGroup = cat.get('Connection Error / Pin');
	assert.deepEqual(pinGroup.primitiveIds, ['e12', 'e13', 'e30']);
	assert.deepEqual(pinGroup.offenderIds, ['err3', 'err4', 'err8']);
	assert.deepEqual(pinGroup.samples[0].pads, [{ component: 'U3', pad: '7' }]);
	assert.equal(pinGroup.samples[0].errorId, 'err3');
	const labelGroup = cat.get('Net Error / Net Label');
	assert.deepEqual(labelGroup.primitiveIds, ['e88', 'e90']);
	assert.equal(labelGroup.samples[0].componentRefs, undefined, 'net label D1 is not a component');
	assert.equal(labelGroup.samples[0].between.obj1.suffix, '(D1): D1', 'raw label kept for display');
	assert.deepEqual(cat.get('Designator Error / Component').primitiveIds, ['e20', 'e21']);

	const byComp: any = await schDocumentHandlers['sch.drc.summarize']({ groupBy: 'component' });
	const comp = new Map<string, any>(byComp.topGroups.map((g: any) => [g.key, g]));
	assert.equal(comp.get('U3')?.count, 2);
	assert.equal(comp.get('D1')?.count, 1, 'only the real diode pin groups under D1');
	assert.deepEqual(comp.get('D1').primitiveIds, ['e30']);
	assert.equal(comp.get('R5')?.count, 1);
	assert.equal(comp.get('unknown-component')?.count, 3, 'net label, power flag, id-only label');
	assert.ok(!comp.has('VCC3') && !comp.has('D2'), [...comp.keys()].join(','));

	const { registerSchReadTools } = await import('../src/mcp-server/tools/sch-read-tools');
	const sr = fakeServer();
	registerSchReadTools(sr.server as any, { send: async (method: string, p: any) => schDocumentHandlers[method](p) } as any);
	assert.match(sr.descriptions.sch_drc_summarize, /primitiveIds/);
	const trimmed = json(await sr.call('sch_drc_summarize', { document: 'd', groupBy: 'category', maxIds: 1 }));
	const tp = trimmed.topGroups.find((g: any) => g.key === 'Connection Error / Pin');
	assert.deepEqual(tp.primitiveIds, ['e12']);
	assert.equal(tp.morePrimitiveIds, 2);
	assert.deepEqual(tp.offenderIds, ['err3']);
	assert.equal(tp.moreOffenderIds, 2);
	assert.equal(tp.samples.length, 1, 'samplesPerGroup default 1');
	assert.equal(tp.samples[0].objs, undefined, 'objs superseded by primitiveIds in samples');
	schDrcResult = true;
	const boolSummary: any = await schDocumentHandlers['sch.drc.summarize']({});
	assert.equal(boolSummary.passed, true);
	assert.equal(boolSummary.totalViolations, null, 'unknown count, like pcb.drc.summarize');

	console.log('payload-trim smoke: OK');
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
