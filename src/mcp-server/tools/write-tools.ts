import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';

const DELETE_HANDLER_MAP: Record<string, string> = {
	component: 'pcb.delete.component',
	track: 'pcb.delete.line',
	polyline: 'pcb.delete.polyline',
	via: 'pcb.delete.via',
	pad: 'pcb.delete.pad',
	pour: 'pcb.delete.pour',
	fill: 'pcb.delete.fill',
	arc: 'pcb.delete.arc',
	region: 'pcb.delete.region',
};

const MODIFY_HANDLER_MAP: Record<string, string> = {
	via: 'pcb.modify.via',
	polyline: 'pcb.modify.polyline',
	arc: 'pcb.modify.arc',
	pad: 'pcb.modify.pad',
	pour: 'pcb.modify.pour',
	fill: 'pcb.modify.fill',
	region: 'pcb.modify.region',
};

const layerSchema = z.union([z.string(), z.number()]);
const polygonSchema = z.any();
const viaTypeSchema = z.union([z.number(), z.enum(['Through', 'BlindBuried', 'Suture'])]);

export function registerWriteTools(server: McpServer, bridge: WebSocketBridge): void {
	// === Create ===

	server.tool(
		'pcb_create_track',
		'Create a single Line track between two points (mil). Preferred over polyline_track for routed nets.',
		withDocumentParam({
			net: z.string().describe('Net name'),
			layer: layerSchema.describe('Layer ID or name — see pcb_help("layer")'),
			startX: z.number(),
			startY: z.number(),
			endX: z.number(),
			endY: z.number(),
			lineWidth: z.number().optional().describe('mil; uses design rule if omitted'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.line', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_polyline_track',
		'[LEGACY] Polyline graphic — does NOT carry a net (ratlines stay live). Use pcb_create_track or pcb_route_orthogonal instead.',
		withDocumentParam({
			net: z.string(),
			layer: layerSchema,
			polygon: z.array(z.object({ x: z.number(), y: z.number() })).min(2),
			lineWidth: z.number().optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.polyline', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_via',
		'Create a via in mil units. For mm input use pcb_create_via_mm.',
		withDocumentParam({
			net: z.string(),
			x: z.number(),
			y: z.number(),
			holeDiameter: z.number().describe('Drill hole (mil)'),
			diameter: z.number().describe('Pad outer diameter (mil)'),
			viaType: viaTypeSchema.optional().describe('0/Through (default), 1/BlindBuried, 2/Suture'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.via', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_via_mm',
		'Create a via with millimeter dimensions. Returns resolved mil values.',
		withDocumentParam({
			net: z.string(),
			x: z.number(),
			y: z.number(),
			drill_mm: z.number(),
			diameter_mm: z.number(),
			viaType: viaTypeSchema.optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.via.mm', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_arc',
		'Create an arc track segment.',
		withDocumentParam({
			net: z.string(),
			layer: layerSchema,
			startX: z.number(),
			startY: z.number(),
			endX: z.number(),
			endY: z.number(),
			arcAngle: z.number().describe('Degrees; negative = clockwise'),
			lineWidth: z.number().optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.arc', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_pad',
		'Create a standalone pad on the PCB.',
		withDocumentParam({
			layer: layerSchema,
			padNumber: z.string(),
			x: z.number(),
			y: z.number(),
			rotation: z.number().optional(),
			net: z.string().optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.pad', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_pour',
		'Create a copper pour. polygon: see pcb_help("polygon"). Layer must be copper.',
		withDocumentParam({
			net: z.string(),
			layer: layerSchema,
			polygon: polygonSchema,
			pourFillMethod: z.enum(['solid', '45grid', '90grid']).optional(),
			preserveSilos: z.boolean().optional(),
			pourName: z.string().optional(),
			pourPriority: z.number().optional().describe('Higher = poured first'),
			lineWidth: z.number().optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.pour', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_fill',
		'Create a fill region. polygon: see pcb_help("polygon").',
		withDocumentParam({
			layer: layerSchema,
			polygon: polygonSchema,
			net: z.string().optional(),
			lineWidth: z.number().optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.fill', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_region',
		'Create a design rule region (keepout/constraint). polygon: see pcb_help("polygon").',
		withDocumentParam({
			layer: layerSchema,
			polygon: polygonSchema,
			ruleType: z.array(z.string()).optional(),
			regionName: z.string().optional(),
			lineWidth: z.number().optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.region', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_route_orthogonal',
		'Route Manhattan path with real Line primitives. 1/2/3 segments depending on alignment + jogX/jogY.',
		withDocumentParam({
			net: z.string(),
			layer: layerSchema,
			fromX: z.number(),
			fromY: z.number(),
			toX: z.number(),
			toY: z.number(),
			lineWidth: z.number().optional(),
			jogX: z.number().optional().describe('Intermediate X for U-shape detour'),
			jogY: z.number().optional().describe('Intermediate Y for U-shape detour'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.route.orthogonal', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_delete_tracks_by_filter',
		'Bulk-delete Line tracks matching net/layer. preserveLocked skips locked. Returns count + IDs.',
		withDocumentParam({
			net: z.string().optional(),
			layer: layerSchema.optional(),
			preserveLocked: z.boolean().optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.deleteByFilter.line', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	// === Modify ===

	server.tool(
		'pcb_move_component',
		'Move/rotate/flip a component or change designator/lock.',
		withDocumentParam({
			primitiveId: z.string(),
			x: z.number().optional(),
			y: z.number().optional(),
			rotation: z.number().optional(),
			layer: layerSchema.optional().describe('"TopLayer"/"BottomLayer" to flip'),
			primitiveLock: z.boolean().optional(),
			designator: z.string().optional(),
		}),
		async ({ primitiveId, instance_id, document, ...property }) => {
			const result = await bridge.send('pcb.modify.component', { primitiveId, property, instance_id, document });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_modify_track',
		'Modify a Line track. Returns {modified, persisted, after, attempted} — re-fetches to verify.',
		withDocumentParam({
			primitiveId: z.string(),
			net: z.string().optional(),
			layer: layerSchema.optional(),
			startX: z.number().optional(),
			startY: z.number().optional(),
			endX: z.number().optional(),
			endY: z.number().optional(),
			lineWidth: z.number().optional(),
		}),
		async ({ primitiveId, instance_id, document, ...property }) => {
			const result = await bridge.send('pcb.modify.line', { primitiveId, property, instance_id, document });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_modify_primitive',
		'Modify any primitive. Property keys depend on type (see pcb_help("primitives")). All types accept primitiveLock.',
		withDocumentParam({
			type: z.enum(['via', 'polyline', 'arc', 'pad', 'pour', 'fill', 'region']),
			primitiveId: z.string(),
			property: z.record(z.string(), z.any()).describe('Properties to modify'),
		}),
		async ({ type, ...rest }) => {
			const result = await bridge.send(MODIFY_HANDLER_MAP[type], rest);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	// === Delete ===

	server.tool(
		'pcb_delete_primitives',
		'Delete primitives by type and IDs.',
		withDocumentParam({
			type: z.enum(['component', 'track', 'polyline', 'via', 'pad', 'pour', 'fill', 'arc', 'region']),
			ids: z.union([z.string(), z.array(z.string())]),
		}),
		async ({ type, ...rest }) => {
			const result = await bridge.send(DELETE_HANDLER_MAP[type], rest);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	// === Save ===

	server.tool(
		'pcb_save',
		'Save the current PCB document.',
		withDocumentParam({
			uuid: z.string().optional().describe('Document UUID (default: current)'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.document.save', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}
