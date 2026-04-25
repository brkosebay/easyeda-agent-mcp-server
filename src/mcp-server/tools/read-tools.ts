import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam, withQueryParams } from './query-params';

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

export function registerReadTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_get_all_primitives',
		'List PCB primitives by type with optional net/layer filters. Compact by default — pass compact:false for full geometry. See pcb_help("primitives") for field reference.',
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
		'Get primitives belonging to a net (compact by default).',
		withQueryParams({
			net: z.string().describe('Net name'),
			types: z.array(z.string()).optional().describe('Primitive types filter (e.g. ["Line","Via","Pad"])'),
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
		}),
		async (params) => {
			const result = await bridge.send('pcb.pad.findByRef', params);
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
		'Run Design Rule Check. Returns pass/fail or violation array (verbose:true).',
		withQueryParams({
			strict: z.boolean().default(true).describe('Strict mode'),
			ui: z.boolean().default(false).describe('Show DRC panel'),
			verbose: z.boolean().default(true).describe('Return full violation list'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.drc.check', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
		'Inline reference for tool conventions. Topics: "polygon" (pour/fill/region shapes), "layer" (layer ID/name table), "viaType" (numeric/string mapping), "compact" (response sizing), "units" (mil vs mm), "primitives" (field reference per type), "timeout" (overriding the 45s default).',
		{ topic: z.enum(['polygon', 'layer', 'viaType', 'compact', 'units', 'primitives', 'timeout']) },
		async ({ topic }) => {
			return { content: [{ type: 'text', text: HELP[topic] }] };
		},
	);
}

const HELP: Record<string, string> = {
	polygon: `Polygon input accepts four shapes:
1. {points: [{x,y},{x,y},...]} — friendly, auto-closes the ring
2. [{x,y},{x,y},...] — same as above without the wrapper
3. ["L", x1,y1, x2,y2, ..., x1,y1] — native L-mode source array (closed)
4. ["R", cx, cy, w, h, rotation, cornerRadius] — native rectangle mode
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
Pass limit:N to truncate.`,
	units: `All PCB coordinates and lengths are in mil (1 mil = 0.0254 mm) — EasyEDA's internal data unit.
Use pcb_create_via_mm to create vias with mm-based diameters.
Schematic coordinates are in 0.01 inch.`,
	primitives: `Common fields per primitive type (compact mode):
component: primitiveId, designator, name, layer, x, y, rotation, primitiveLock
track (Line): primitiveId, net, layer, startX, startY, endX, endY, lineWidth
polyline: primitiveId, net, layer, lineWidth (also stores point list — verbose only)
via: primitiveId, net, x, y, holeDiameter, diameter, viaType
pad: primitiveId, net, layer, padNumber, x, y, rotation
pour: primitiveId, net, layer, pourName, pourPriority, pourFillMethod
fill: primitiveId, net, layer, fillMode, lineWidth
arc: primitiveId, net, layer, startX, startY, endX, endY, arcAngle, lineWidth
region: primitiveId, layer, ruleType, regionName`,
	timeout: `Default bridge timeout is 45000ms. Override per-call with _timeoutMs:
_timeoutMs: 300000  // 5 min, for long exports / autoroute / DRC on big boards
Set EDA_WS_TIMEOUT_MS env to change the global default.`,
};
