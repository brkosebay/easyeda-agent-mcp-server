import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam, withQueryParams } from './query-params';
import { extractDrcOffenders, type DrcPadRef } from '../../shared/drc-offenders';

const GET_ALL_HANDLER_MAP: Record<string, string> = {
	component: 'pcb.getAll.component',
	track: 'pcb.getAll.line',
	polyline: 'pcb.getAll.polyline',
	via: 'pcb.getAll.via',
	pad: 'pcb.getAll.pad',
	pour: 'pcb.getAll.pour',
	fill: 'pcb.getAll.fill',
	arc: 'pcb.getAll.arc',
	region: 'pcb.getAll.region',
};

const GET_BY_ID_HANDLER_MAP: Record<string, string> = {
	component: 'pcb.get.component',
	track: 'pcb.get.line',
	polyline: 'pcb.get.polyline',
	via: 'pcb.get.via',
	pad: 'pcb.get.pad',
	pour: 'pcb.get.pour',
	fill: 'pcb.get.fill',
	arc: 'pcb.get.arc',
	region: 'pcb.get.region',
};

const PRIMITIVE_TYPES = [
	'component', 'track', 'polyline', 'via', 'pad', 'pour', 'fill', 'arc', 'region',
] as const;
	const DEFAULT_PAD_LOOKUP_TIMEOUT_MS = 5_000;

export function registerReadTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_get_all_primitives',
		'List PCB primitives by type with optional net/layer filters. Returns a { total, returned, truncated, items } envelope (default limit 100 — raise limit for more). Compact by default — pass compact:false for full geometry. See pcb_help("primitives") for field reference.',
		withQueryParams({
			type: z.enum(PRIMITIVE_TYPES).describe('Primitive type'),
			net: z.string().optional().describe('Filter by net'),
			layer: z.union([z.string(), z.number()]).optional().describe('Filter by layer (ID or name)'),
			primitiveLock: z.boolean().optional().describe('Filter by lock status'),
		}),
		async ({ type, compact, ...rest }) => {
			const result = await bridge.send(GET_ALL_HANDLER_MAP[type], { ...rest, compact: compact ?? true });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_primitives_by_id',
		'Look up primitives by ID. Compact by default; set compact:false for full geometry.',
		withQueryParams({
			type: z.enum(PRIMITIVE_TYPES).describe('Primitive type'),
			primitiveIds: z.union([z.string(), z.array(z.string())]).describe('ID or array of IDs'),
		}),
		async ({ type, compact, ...rest }) => {
			const result = await bridge.send(GET_BY_ID_HANDLER_MAP[type], { ...rest, compact: compact ?? true });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_all_nets',
		'List all net names on the PCB.',
		withDocumentParam({}),
		async (params) => {
			const result = await bridge.send('pcb.net.getAllNames', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_net_primitives',
		'Get primitives belonging to a net (compact by default). Type names are matched case-insensitively and aliased onto the runtime names (line/trace/wire → Track, copperArea → Pour, footprint → Component); an unrecognized type returns an error listing the accepted values. Pads are not stored on the net, so requesting "pad" triggers a component-pin scan instead.',
		withQueryParams({
			net: z.string().describe('Net name'),
			types: z.array(z.string()).optional().describe('Primitive types filter, case-insensitive: Track (aka line/trace/wire), Via, Arc, Polyline, Pour, Poured, Fill, Region, Pad, Hole, Component, Text. Omit for all copper primitives on the net.'),
		}),
		async ({ compact, ...rest }) => {
			const result = await bridge.send('pcb.net.getPrimitives', { ...rest, compact: compact ?? true });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_net_length',
		'Get total routed length of a net (mil).',
		withDocumentParam({ net: z.string().describe('Net name') }),
		async (params) => {
			const result = await bridge.send('pcb.net.getLength', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_design_rules',
		'Get the active DRC rule configuration.',
		withDocumentParam({}),
		async (params) => {
			const result = await bridge.send('pcb.drc.getRuleConfiguration', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_net_rules',
		'Get net-specific DRC rules.',
		withDocumentParam({}),
		async (params) => {
			const result = await bridge.send('pcb.drc.getNetRules', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_pad',
		'Find the PCB location of a component pin/pad by its designator and pin number — e.g. where pin 3 of R1 sits on the board. Returns {primitiveId, x, y, layer, net}.',
		withDocumentParam({
			reference: z.string().describe('Designator (e.g. "R1", "U2")'),
			padNumber: z.union([z.string(), z.number()]).describe('Pad number/name'),
			timeoutMs: z.number().int().positive().default(DEFAULT_PAD_LOOKUP_TIMEOUT_MS).describe('Maximum wait in milliseconds if pad lookup is slow.'),
		}),
		async (params) => {
			const payload: Record<string, unknown> = { ...params };
			const timeoutMs = Number((params as any).timeoutMs);
			if (Number.isFinite(timeoutMs) && timeoutMs > 0) payload._timeoutMs = timeoutMs;
			if ('timeoutMs' in payload) delete payload.timeoutMs;
			const result = await bridge.send('pcb.pad.findByRef', payload);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_component_pins',
		'List all pads of a component by primitive ID.',
		withQueryParams({
			primitiveId: z.string().describe('Component primitive ID'),
		}),
		async ({ compact, ...rest }) => {
			const result = await bridge.send('pcb.component.getPins', { ...rest, compact: compact ?? true });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_run_drc',
		'Run Design Rule Check. Returns pass/fail; verbose:true returns the violation tree (often 50–700 KB — prefer pcb_drc_summarize or pcb_drc_violations_detailed). Each verbose leaf carries primitiveIds (the offending tracks/vias/pads to move, delete or reroute) and pads ({component, pad}); globalIndex ("err397") names the violation, not copper.',
		withQueryParams({
			strict: z.boolean().default(true).describe('Strict mode'),
			ui: z.boolean().default(false).describe('Show DRC panel'),
			verbose: z.boolean().default(false).describe('Return full violation tree'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.drc.check', params);
			return { content: [{ type: 'text', text: JSON.stringify(annotateDrcTree(result)) }] };
		},
	);

	server.tool(
		'pcb_get_selected',
		'Get currently selected primitives in the PCB editor.',
		withQueryParams({}),
		async ({ compact, ...rest }) => {
			const result = await bridge.send('pcb.select.getAll', { ...rest, compact: compact ?? true });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_help',
		'Inline reference for tool conventions. Topics: "polygon" (pour/fill/region shapes), "layer" (layer ID/name table), "viaType" (numeric/string mapping), "compact" (response sizing), "units" (mil vs mm), "primitives" (field reference per type), "timeout" (overriding the per-tool default).',
		{ topic: z.enum(['polygon', 'layer', 'viaType', 'compact', 'units', 'primitives', 'timeout']) },
		async ({ topic }) => {
			return { content: [{ type: 'text', text: HELP[topic] }] };
		},
	);
}

// --- pcb_run_drc offender annotation ---------------------------------------
// Same parser the extension uses for pcb_drc_summarize (src/shared/drc-offenders.ts).
export function drcLeafOffenders(v: any): { primitiveIds: string[]; pads: DrcPadRef[] } {
	const { primitiveIds, pads } = extractDrcOffenders(v);
	return { primitiveIds, pads };
}

// Adds primitiveIds/pads to every leaf of the verbose DRC tree (keeping its
// shape), drops `objs` once primitiveIds supersede it, and drops the
// per-node `sourceUnits` sentence (`units:"mil"` stays). pass/fail booleans
// pass through untouched.
export function annotateDrcTree(result: unknown): unknown {
	const walk = (node: any): any => {
		if (Array.isArray(node)) return node.map(walk);
		if (!node || typeof node !== 'object') return node;
		const out: Record<string, any> = {};
		for (const [key, value] of Object.entries(node)) {
			if (key !== 'sourceUnits') out[key] = walk(value);
		}
		if (node.errorType && !Array.isArray(node.list)) {
			const { primitiveIds, pads } = drcLeafOffenders(node);
			if (primitiveIds.length > 0) { out.primitiveIds = primitiveIds; delete out.objs; }
			if (pads.length > 0) out.pads = pads;
		}
		return out;
	};
	return result && typeof result === 'object' ? walk(result) : result;
}

const HELP: Record<string, string> = {
	polygon: `Polygon input accepts four shapes:
1. {points: [{x,y},{x,y},...]} — friendly, auto-closes the ring
2. [{x,y},{x,y},...] — same as above without the wrapper
3. ["L", x1,y1, x2,y2, ...] — friendly line ring; auto-closes and converts to EasyEDA's native line source
4. ["R", centerX, centerY, w, h, rotation, cornerRadius] — friendly rectangle mode; converted to EasyEDA's top-left rectangle source
All coordinates in mil. Pour/fill/region need a copper layer.`,
	layer: `Layer accepts either a numeric ID or a name string.
IDs: 1=Top, 2=Bottom, 3=TopSilk, 4=BottomSilk, 5=TopMask, 6=BottomMask,
7=TopPaste, 8=BottomPaste, 9=TopAssembly, 10=BottomAssembly,
11=BoardOutline, 12=Multi, 13=Document, 14=Mechanical,
15..44=Inner1..Inner30, 71..100=Custom1..Custom30.
Names: "TopLayer", "BottomLayer", "Inner1", "BoardOutline", etc. Case-insensitive.`,
	viaType: `viaType accepts either a number or string:
0 / "Through" — through-hole via (default)
1 / "BlindBuried" — blind/buried via
2 / "Suture" / "Stitch" — stitching via`,
	compact: `Read tools default to compact:true — only identity + key geometry fields.
Pass compact:false to get full data (e.g. complete pour polygon source).
Pass fields:["a","b"] for explicit field projection.
Pass filter:{net:"GND"} or filter:{designator:"R*"} for AND-filtering.
Pass limit:N to truncate.
Filtering happens BEFORE limiting. getAll envelopes report {total, matched, returned, truncated}:
total = everything the query matched, matched = survivors of filter,
returned = items after limit, truncated = true only when items were really cut off.`,
	units: `All PCB coordinates and lengths are in mil (1 mil = 0.0254 mm) — EasyEDA's internal data unit.
Use pcb_create_via_mm to create vias with mm-based diameters.
pcb_get_component_pins and pcb_run_drc normalize EasyEDA coordinate output to mil and include units metadata where useful.
Schematic coordinates are in 0.01 inch.`,
	primitives: `Common fields per primitive type (compact mode):
component: primitiveId, designator, name, layer, x, y, rotation, primitiveLock
track (Line): primitiveId, net, layer, startX, startY, endX, endY, lineWidth
polyline: primitiveId, net, layer, lineWidth (also stores point list — verbose only)
via: primitiveId, net, x, y, holeDiameter, diameter, viaType
pad: primitiveId, net, layer, padNumber, x, y, rotation
pour: primitiveId, net, layer, pourName, pourPriority, pourFillMethod, summary
fill: primitiveId, net, layer, fillMode, lineWidth
arc: primitiveId, net, layer, startX, startY, endX, endY, arcAngle, lineWidth
region: primitiveId, layer, ruleType, regionName, summary
summary (pour/region geometry): {mode:"L"|"R"|"complex", bbox, pointCount, points (first 8), closed}.
Y in summaries and in all track/pad/via coordinates uses coordinateSpace "canvas-mil-negY"
(mil, Y growing upward). Pour/region source arrays store Y positive-down and are normalized for you.`,
	timeout: `Default timeout behavior is set by each tool (typically 5000ms for quick read/viewport tools). Override per-call with _timeoutMs:
_timeoutMs: 300000  // 5 min, for long exports / autoroute / DRC on big boards
Set EDA_WS_TIMEOUT_MS env to change the global default.`,
};
