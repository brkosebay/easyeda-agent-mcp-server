import assert from 'node:assert/strict';
import { checkTraceObstacles, layersTouch } from '../src/extension/handlers/trace-obstacles';

// Per-segment layer filtering for pcb_check_trace_obstacles and every preflight
// that shares checkTraceObstacles (pcb_create_track, route tools, batch edit).
//
// Geometry (mil):
//   seg A  y=0    x 0..1000   (bottom in most cases)
//   seg B  y=500  x 0..1000   (top in most cases)
//   T1  top    track x=500 y -100..100  crosses A's path only  -> must NOT block bottom A
//   T2  bottom track x=300 y 400..600   crosses B's path only  -> must NOT block top B
//   T3  bottom track x=700 y -100..100  crosses A               -> blocks A
//   V1  via (100,0)   -> blocks A (vias span all layers)
//   V2  via (600,500) -> blocks B
//   P1  pad layer 12 (MULTI) at (100,500)              -> blocks B
//   P2  pad layer 1 (SMD, top) at (900,0)              -> must NOT block bottom A
//   P3  pad reporting layer 1 but drilled at (200,0)   -> through-hole, blocks A
const lines = [
	{ primitiveId: 'T1', net: 'OTHER', layer: 1, startX: 500, startY: -100, endX: 500, endY: 100, lineWidth: 10 },
	{ primitiveId: 'T2', net: 'OTHER', layer: 2, startX: 300, startY: 400, endX: 300, endY: 600, lineWidth: 10 },
	{ primitiveId: 'T3', net: 'OTHER', layer: 2, startX: 700, startY: -100, endX: 700, endY: 100, lineWidth: 10 },
];
const vias = [
	{ primitiveId: 'V1', net: 'OTHER', x: 100, y: 0, diameter: 24 },
	{ primitiveId: 'V2', net: 'OTHER', x: 600, y: 500, diameter: 24 },
];
const pads = [
	{ primitiveId: 'P1', net: 'OTHER', layer: 12, x: 100, y: 500, pad: ['RECT', 20, 20, 0], hole: ['ROUND', 3, 3] },
	{ primitiveId: 'P2', net: 'OTHER', layer: 1, x: 900, y: 0, pad: ['RECT', 20, 20, 0], hole: null },
	{ primitiveId: 'P3', net: 'OTHER', layer: 1, x: 200, y: 0, pad: ['ELLIPSE', 30, 30], hole: ['ROUND', 1.5, 1.5] },
];

const lineGetAllLayers: Array<number | undefined> = [];
(globalThis as any).eda = {
	pcb_PrimitiveLine: {
		// Honour the layer argument like the real API does.
		getAll: async (_net: any, layer: any) => {
			lineGetAllLayers.push(layer);
			return layer == null ? lines : lines.filter((l) => l.layer === layer);
		},
	},
	pcb_PrimitiveVia: { getAll: async () => vias },
	pcb_PrimitivePad: { getAll: async () => pads },
	pcb_PrimitiveComponent: { getAll: async () => [], getAllPinsByPrimitiveId: async () => [] },
	pcb_PrimitivePour: { getAll: async () => [] },
	pcb_PrimitiveRegion: { getAll: async () => [] },
	pcb_Drc: { getCurrentRuleConfiguration: async () => undefined, getNetRules: async () => undefined },
};

const A = { startX: 0, startY: 0, endX: 1000, endY: 0 };
const B = { startX: 0, startY: 500, endX: 1000, endY: 500 };
const base = { net: 'SIG', lineWidth: 10, clearanceMil: 6, includeBoardBoundary: false };

function idsFor(result: any, segmentIndex: number): string[] {
	return result.obstacles
		.filter((o: any) => o.segmentIndex === segmentIndex && o.severity === 'blocker')
		.map((o: any) => o.primitiveId)
		.sort();
}

(async () => {
	// Mixed-layer segment lists, no top-level layer — the reported bug.
	const variants: Array<[string, any, any]> = [
		['numeric ids', 2, 1],
		['numeric strings', '2', '1'],
		['names', 'BOTTOM', 'TOP'],
		['mixed forms', 'BottomLayer', 1],
		['mixed forms reversed', 2, 'Top Layer'],
	];
	for (const [label, bottom, top] of variants) {
		lineGetAllLayers.length = 0;
		const r = await checkTraceObstacles({ ...base, segments: [{ layer: bottom, ...A }, { layer: top, ...B }] });
		assert.deepEqual(idsFor(r, 0), ['P3', 'T3', 'V1'], `${label}: bottom segment must see only bottom/multi-layer copper`);
		assert.deepEqual(idsFor(r, 1), ['P1', 'V2'], `${label}: top segment must see only top/multi-layer copper`);
		assert.equal(r.segments[0].layer, 2, `${label}: bottom layer normalised to 2`);
		assert.equal(r.segments[1].layer, 1, `${label}: top layer normalised to 1`);
		assert.deepEqual(lineGetAllLayers.slice().sort(), [1, 2], `${label}: tracks fetched per numeric layer`);
		assert.deepEqual(r.checked.tracksByLayer, { 1: 1, 2: 2 });
	}

	// Reversed roles: A on top, B on bottom.
	{
		const r = await checkTraceObstacles({ ...base, segments: [{ layer: 'TOP', ...A }, { layer: '2', ...B }] });
		assert.deepEqual(idsFor(r, 0), ['P2', 'P3', 'T1', 'V1'], 'top A sees T1 and the top SMD pad P2');
		assert.deepEqual(idsFor(r, 1), ['P1', 'T2', 'V2'], 'bottom B sees T2');
	}

	// Single segment with top-level string layer (the path that already worked).
	{
		lineGetAllLayers.length = 0;
		const r = await checkTraceObstacles({ ...base, layer: 'BOTTOM', ...A });
		assert.deepEqual(idsFor(r, 0), ['P3', 'T3', 'V1']);
		assert.deepEqual(lineGetAllLayers, [2]);
		assert.equal(r.checked.tracks, 2);
	}

	// Per-segment layer overrides the top-level layer.
	{
		const r = await checkTraceObstacles({ ...base, layer: 1, segments: [{ layer: '2', ...A }, B] });
		assert.deepEqual(idsFor(r, 0), ['P3', 'T3', 'V1'], 'segment layer 2 wins over top-level layer 1');
		assert.deepEqual(idsFor(r, 1), ['P1', 'V2'], 'segment without layer inherits top-level layer 1');
	}

	// A segment with no layer at all is checked against every layer; the
	// layered one stays filtered.
	{
		lineGetAllLayers.length = 0;
		const r = await checkTraceObstacles({ ...base, segments: [{ layer: 2, ...A }, B] });
		assert.deepEqual(lineGetAllLayers, [undefined], 'layer-less segment forces an all-layer fetch');
		assert.deepEqual(idsFor(r, 0), ['P3', 'T3', 'V1']);
		assert.deepEqual(idsFor(r, 1), ['P1', 'T2', 'V2']);
	}

	// Unknown layer names fail loudly instead of silently reporting clear.
	await assert.rejects(
		() => checkTraceObstacles({ ...base, segments: [{ layer: 'BOT', ...A }] }),
		/Unknown layer "BOT"/,
	);

	// layersTouch: id forms are interchangeable; MULTI touches all.
	assert.equal(layersTouch(2, '2'), true);
	assert.equal(layersTouch('BOTTOM', 2), true);
	assert.equal(layersTouch('bottom layer', 'BottomLayer'), true);
	assert.equal(layersTouch('TOP', 2), false);
	assert.equal(layersTouch('1', 'BOTTOM'), false);
	assert.equal(layersTouch(12, 2), true);
	assert.equal(layersTouch('MultiLayer', 'TOP'), true);
	assert.equal(layersTouch(15, 'Inner1'), true);
	assert.equal(layersTouch(15, 16), false);

	console.log('Trace obstacle layers: each segment checked only against its own layer (numeric, string, name, mixed); vias and drilled/MULTI pads block all layers.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
