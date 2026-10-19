// DRC offender extraction — pcb.drc.summarize / pcb.drc.violationsDetailed
// must name the offending PRIMITIVES (objs + obj1/obj2 suffixes), not the DRC
// error ids ("err397") that collectIds() picks up from `globalIndex`.
// Run: npx ts-node --transpile-only scripts/drc-offenders-smoke.ts
import assert from 'node:assert/strict';

// Leaves in EasyEDA's raw DRC units (10 mil); normalizeDrcUnits scales ×10.
// Captured live: a GND SMD pad with no copper reaching it.
const connC1 = {
	visible: true, errorType: 'Connection Error', errorObjType: 'SMD Pad', ruleName: 'Common',
	obj1: { typeName: 'SMD Pad', suffix: '(GND): C1_1' }, isFree: false, net: 'GND',
	explanation: { str: 'Object 1 is disconnected from other objects of the same network' },
	objs: ['e6e8'], globalIndex: 'err397', pos: { x: 100.2972, y: -148 },
};
// Same net group, pad named only through its suffix (no objs at all).
const connR21 = {
	errorType: 'Connection Error', errorObjType: 'SMD Pad', ruleName: 'Common',
	obj1: { typeName: 'SMD Pad', suffix: '(GND): R21_2' }, net: 'GND',
	explanation: { str: 'Object 1 is disconnected from other objects of the same network' },
	globalIndex: 'err398',
};
// Clearance between a track and an SMD pad: two objs, two suffixes.
const clearTrackPad = {
	errorType: 'Clearance Error', errorObjType: 'Track to SMD Pad', ruleName: 'Safe Spacing',
	obj1: { typeName: 'Track', suffix: '(GND): e25457' },
	obj2: { typeName: 'SMD Pad', suffix: '(+3V3): U3_41' },
	net: 'GND',
	explanation: { str: 'Object 1 to object 2 clearance is {clearance}, should be {shouldBe}', param: { clearance: '4.2mil', shouldBe: '6mil' } },
	objs: ['e25457', 'e3e41'], globalIndex: 'err4287',
};
// Via/track clearance with ids only in obj fields; obj1.globalIndex is a DRC id.
const clearViaTrack = {
	errorType: 'Clearance Error', errorObjType: 'Via to Track', ruleName: 'Safe Spacing',
	obj1: { typeName: 'Via', suffix: '(+3V3): e900', globalIndex: 'err12' },
	obj2: { typeName: 'Track', id: 'e901' },
	net: '+3V3', globalIndex: 'err4288',
};
// globalIndex carrying a net name must not become an errorId.
const netIndexed = {
	errorType: 'Connection Error', errorObjType: 'Net', globalIndex: 'GND', globalIndexIsNet: true, objs: ['e77'],
};

// Nested: category → net group → leaves.
const tree = [
	{ name: 'Connection Error', list: [
		{ name: 'GND', list: [connC1, connR21] },
		{ name: 'Nets', list: [netIndexed] },
	] },
	{ name: 'Clearance Error', list: [
		{ name: 'Track to SMD Pad', list: [{ name: 'GND', list: [clearTrackPad] }] },
		{ name: 'Via to Track', list: [clearViaTrack] },
	] },
];

// Live board for location resolution. Pin coordinates are 10-mil units.
const pins: Record<string, any[]> = {
	e6: [{ primitiveId: 'e6e8', padNumber: '1', net: 'GND', layer: 1, x: 100, y: -148 }],
	e3: [{ primitiveId: 'e3e41', padNumber: '41', net: '+3V3', layer: 1, x: 200, y: -50 }],
	// R21's pad id is NOT in the DRC leaf — only the "R21_2" label resolves it.
	e21: [{ primitiveId: 'e21e5', padNumber: '2', net: 'GND', layer: 1, x: 300, y: -10 }],
};
(globalThis as any).eda = {
	pcb_Drc: { check: async () => tree },
	pcb_PrimitiveLine: {
		getAll: async () => [
			{ primitiveId: 'e25457', net: 'GND', layer: 1, startX: 1900, startY: -500, endX: 2100, endY: -500, lineWidth: 10 },
			{ primitiveId: 'e901', net: 'GND', layer: 1, startX: 0, startY: 0, endX: 100, endY: 0, lineWidth: 10 },
		],
	},
	pcb_PrimitiveVia: { getAll: async () => [{ primitiveId: 'e900', net: '+3V3', x: 50, y: 5 }] },
	pcb_PrimitivePad: { getAll: async () => [] },
	pcb_PrimitivePour: { getAll: async () => [] },
	pcb_PrimitiveRegion: { getAll: async () => [] },
	pcb_PrimitiveComponent: {
		getAll: async () => [
			{ primitiveId: 'e6', designator: 'C1', x: 1000, y: -1480 },
			{ primitiveId: 'e3', designator: 'U3', x: 2000, y: -500 },
			{ primitiveId: 'e21', designator: 'R21', x: 3000, y: -100 },
		],
		getAllPinsByPrimitiveId: async (id: string) => pins[id] ?? [],
	},
};

const ERR = /^err\d+$/i;

(async () => {
	const drc = await import('../src/extension/handlers/drc');
	const { extractDrcOffenders, drcErrorId, collectIds, extractComponentRefs, pickGroupKey, drcHandlers } = drc;

	// --- helper: connection error, one obj ---
	let o = extractDrcOffenders(connC1);
	assert.equal(o.errorId, 'err397');
	assert.deepEqual(o.primitiveIds, ['e6e8']);
	assert.deepEqual(o.componentRefs, ['C1']);
	assert.deepEqual(o.pads, [{ component: 'C1', pad: '1' }]);

	// --- helper: suffix-only pad label ---
	o = extractDrcOffenders(connR21);
	assert.equal(o.errorId, 'err398');
	assert.deepEqual(o.primitiveIds, []);
	assert.deepEqual(o.pads, [{ component: 'R21', pad: '2' }]);

	// --- helper: track ↔ SMD pad clearance, two objs + suffixes ---
	o = extractDrcOffenders(clearTrackPad);
	assert.equal(o.errorId, 'err4287');
	assert.deepEqual(o.primitiveIds, ['e25457', 'e3e41'], 'objs first, suffix id not duplicated');
	assert.deepEqual(o.componentRefs, ['U3'], 'primitive id e25457 is not a designator');
	assert.deepEqual(o.pads, [{ component: 'U3', pad: '41' }]);

	// --- helper: ids only in obj fields, DRC id in obj1.globalIndex dropped ---
	o = extractDrcOffenders(clearViaTrack);
	assert.equal(o.errorId, 'err4288');
	assert.deepEqual(o.primitiveIds, ['e900', 'e901']);
	assert.ok(!o.primitiveIds.some((id) => ERR.test(id)));
	assert.deepEqual(o.componentRefs, []);

	// --- helper: globalIndex that is a net name ---
	assert.equal(drcErrorId(netIndexed), undefined);
	assert.deepEqual(extractDrcOffenders(netIndexed).primitiveIds, ['e77']);
	assert.deepEqual(extractDrcOffenders(null), { primitiveIds: [], componentRefs: [], pads: [] });

	// --- collectIds() semantics unchanged (route-path depends on it) ---
	assert.deepEqual(collectIds(connC1), ['err397']);
	assert.deepEqual(collectIds(clearViaTrack), ['err12', 'e901', 'err4288']);

	// --- component grouping no longer invents "E25457" from primitive ids ---
	assert.deepEqual(extractComponentRefs(clearTrackPad), ['U3']);
	assert.equal(pickGroupKey(clearTrackPad, 'component'), 'U3');
	assert.equal(pickGroupKey(connC1, 'component'), 'C1');
	assert.equal(pickGroupKey({ errorType: 'X', objs: ['e2463'] }, 'component'), 'unknown-component');

	// --- pcb.drc.summarize: groups and samples expose primitiveIds ---
	const summary: any = await drcHandlers['pcb.drc.summarize']({ groupBy: 'category' });
	assert.equal(summary.totalViolations, 5, 'nested net groups flattened');
	const byKey = new Map<string, any>(summary.topGroups.map((g: any) => [g.key, g]));
	const conn = byKey.get('Connection Error / SMD Pad');
	assert.equal(conn.count, 2);
	assert.deepEqual(conn.primitiveIds, ['e6e8']);
	assert.deepEqual(conn.offenderIds, ['err397', 'err398'], 'offenderIds kept (DRC error ids)');
	assert.equal(conn.samples[0].errorId, 'err397');
	assert.deepEqual(conn.samples[0].primitiveIds, ['e6e8']);
	assert.deepEqual(conn.samples[0].componentRefs, ['C1']);
	assert.deepEqual(conn.samples[0].pads, [{ component: 'C1', pad: '1' }]);
	assert.deepEqual(conn.samples[0].pos, { x: 1002.972, y: -1480 });
	const clr = byKey.get('Clearance Error / Track to SMD Pad');
	assert.deepEqual(clr.primitiveIds, ['e25457', 'e3e41']);
	for (const g of summary.topGroups) assert.ok(!g.primitiveIds.some((id: string) => ERR.test(id)), `no DRC ids in ${g.key}`);

	const byComp: any = await drcHandlers['pcb.drc.summarize']({ groupBy: 'component' });
	const compKeys = byComp.topGroups.map((g: any) => g.key);
	assert.ok(compKeys.includes('U3') && compKeys.includes('C1') && compKeys.includes('R21'), compKeys.join(','));
	assert.ok(!compKeys.some((k: string) => /^E\d/.test(k)), `no primitive ids as components: ${compKeys}`);

	// --- pcb.drc.violationsDetailed: clean primitiveIds + errorId, resolution via labels ---
	const detailed: any = await drcHandlers['pcb.drc.violationsDetailed']({});
	assert.equal(detailed.totalViolations, 5);
	const find = (errorId: string) => detailed.violations.find((d: any) => d.errorId === errorId);
	let d = find('err4287');
	assert.deepEqual(d.primitiveIds, ['e25457', 'e3e41']);
	assert.deepEqual(d.componentRefs, ['U3']);
	assert.deepEqual(d.pads, [{ component: 'U3', pad: '41' }]);
	assert.ok(Array.isArray(d.offenderIds) && d.offenderIds.includes('err4287'), 'mixed offenderIds kept');
	assert.ok(d.offenders.some((r: any) => r.type === 'track' && r.primitiveId === 'e25457'), JSON.stringify(d.offenders));
	assert.ok(d.offenders.some((r: any) => r.type === 'component_pad' && r.reference === 'U3' && r.padNumber === '41'), JSON.stringify(d.offenders));
	d = find('err398');
	assert.deepEqual(d.primitiveIds, []);
	const r21 = d.offenders.find((r: any) => r.type === 'component_pad' && r.reference === 'R21');
	assert.ok(r21, `R21_2 suffix resolves to its pad: ${JSON.stringify(d.offenders)}`);
	assert.equal(r21.primitiveId, 'e21e5');
	assert.equal(d.locationSource, 'resolved_from_offender_id');
	d = find('err397');
	assert.equal(d.locationSource, 'native_drc');
	assert.deepEqual(d.primitiveIds, ['e6e8']);
	d = find('err4288');
	assert.deepEqual(d.primitiveIds.slice().sort(), ['e900', 'e901']);
	assert.ok(d.offenders.some((r: any) => r.type === 'via' && r.primitiveId === 'e900'));
	const netOnly = detailed.violations.find((x: any) => x.errorType === 'Connection Error' && x.errorId === undefined);
	assert.deepEqual(netOnly.primitiveIds, ['e77']);

	// --- MCP tool: maxIds trims primitiveIds too; samplesPerGroup trims samples ---
	const { registerPcbDrcTools } = await import('../src/mcp-server/tools/pcb-drc-tools');
	const tools: Record<string, Function> = {};
	const descriptions: Record<string, string> = {};
	const server = { tool: (name: string, description: string, _schema: unknown, handler: Function) => { tools[name] = handler; descriptions[name] = description; } };
	const bridge = { send: async (method: string, params: any) => drcHandlers[method](params) };
	registerPcbDrcTools(server as any, bridge as any);
	assert.match(descriptions.pcb_drc_summarize, /primitiveIds/);
	const res: any = await tools.pcb_drc_summarize({ groupBy: 'category', top: 10, includeSamples: true, maxIds: 1, samplesPerGroup: 1 });
	const parsed = JSON.parse(res.content[0].text);
	const clr2 = parsed.topGroups.find((g: any) => g.key === 'Clearance Error / Track to SMD Pad');
	assert.deepEqual(clr2.primitiveIds, ['e25457']);
	assert.equal(clr2.morePrimitiveIds, 1);
	const conn2 = parsed.topGroups.find((g: any) => g.key === 'Connection Error / SMD Pad');
	assert.deepEqual(conn2.offenderIds, ['err397']);
	assert.equal(conn2.moreOffenderIds, 1);
	assert.equal(conn2.morePrimitiveIds, undefined);
	assert.equal(conn2.samples.length, 1);
	assert.deepEqual(conn2.samples[0].primitiveIds, ['e6e8']);

	console.log('drc-offenders smoke: OK');
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
