import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';

const DEFAULT_DOCUMENT_QUERY_TIMEOUT_MS = 5_000;

function timeoutPayload(params: Record<string, unknown>): Record<string, unknown> {
	const timeoutMs = Number((params as any).timeoutMs);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { ...params };

	// Forward timeoutMs so the extension handler sees it; _timeoutMs sets the
	// bridge-side timer with margin so the handler's deadline fires first.
	return { ...params, _timeoutMs: timeoutMs + 5000 };
}

// pcb_navigate_to_region and pcb_get_primitives_in_region are registered by
// registerAnalysisTools; registering them here too would double-register the
// same tool name.
export function registerPcbDocumentTools(server: McpServer, bridge: WebSocketBridge): void {
	// === Navigation ===

	server.tool(
		'pcb_zoom_to_board',
		'Zoom the viewport to fit the entire board outline',
		{
			timeoutMs: z.number().int().positive().default(DEFAULT_DOCUMENT_QUERY_TIMEOUT_MS).describe('Maximum wait in milliseconds if renderer is slow.'),
		},
		async ({ timeoutMs, ...rest }) => {
			const result = await bridge.send('pcb.document.zoomToBoardOutline', timeoutPayload({ ...rest, timeoutMs }));
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_refresh_canvas',
		'Force a canvas redraw by cycling the ratline calculator and re-zooming. Use when newly created tracks/vias do not visually appear despite being present in API queries — common after batch routing.',
		{
			timeoutMs: z.number().int().positive().default(DEFAULT_DOCUMENT_QUERY_TIMEOUT_MS).describe('Maximum wait in milliseconds if renderer is slow.'),
			zoom: z.boolean().optional().default(true).describe('Also zoom-to-board (default: true)'),
		},
		async ({ zoom, timeoutMs, ...rest }) => {
			const result = await bridge.send('pcb.document.refresh', timeoutPayload({ zoom, ...rest, timeoutMs }));
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_layer_status',
		'Get every layer with its visibility (layerStatus: 0=NOTUSED, 1=SHOW, 2=HIDDEN), lock state, and transparency. Pair with pcb_get_canvas_filter when tracks/vias appear missing in the editor.',
		{},
		async () => {
			const result = await bridge.send('pcb.layer.getStatus');
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_canvas_filter',
		'Get the current canvas filter — reveals if Track, Via, Pad, or other primitive types have been hidden in the UI. Useful for diagnosing "I created tracks but cannot see them" cases.',
		{},
		async () => {
			const result = await bridge.send('pcb.document.getCanvasFilter');
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	// === Primitive Query ===

	server.tool(
		'pcb_get_primitive_at_point',
		'Get the primitive at a specific point on the PCB',
		{
			x: z.number().describe('X coordinate'),
			y: z.number().describe('Y coordinate'),
			timeoutMs: z.number().int().positive().default(DEFAULT_DOCUMENT_QUERY_TIMEOUT_MS).describe('Maximum wait in milliseconds if query is slow.'),
		},
		async ({ x, y, timeoutMs }) => {
			const result = await bridge.send('pcb.document.getPrimitiveAtPoint', timeoutPayload({ x, y, timeoutMs }));
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	// === Coordinate System ===

	server.tool(
		'pcb_get_canvas_origin',
		'Get the canvas origin offset relative to data origin',
		{},
		async () => {
			const result = await bridge.send('pcb.document.getCanvasOrigin');
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_set_canvas_origin',
		'Set the canvas origin offset relative to data origin',
		{
			offsetX: z.number().describe('X offset of canvas origin from data origin'),
			offsetY: z.number().describe('Y offset of canvas origin from data origin'),
		},
		async ({ offsetX, offsetY }) => {
			const result = await bridge.send('pcb.document.setCanvasOrigin', { offsetX, offsetY });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_convert_canvas_to_data',
		'Convert canvas coordinates to data coordinates',
		{
			x: z.number().describe('Canvas X coordinate'),
			y: z.number().describe('Canvas Y coordinate'),
		},
		async ({ x, y }) => {
			const result = await bridge.send('pcb.document.convertCanvasToData', { x, y });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_convert_data_to_canvas',
		'Convert data coordinates to canvas coordinates',
		{
			x: z.number().describe('Data X coordinate'),
			y: z.number().describe('Data Y coordinate'),
		},
		async ({ x, y }) => {
			const result = await bridge.send('pcb.document.convertDataToCanvas', { x, y });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	// === Import ===

	server.tool(
		'pcb_import_changes',
		'Import changes from schematic into the PCB (sync schematic to PCB)',
		{
			uuid: z.string().optional().describe('Schematic UUID (uses associated schematic if not provided)'),
		},
		async ({ uuid }) => {
			const result = await bridge.send('pcb.document.importChanges', { uuid });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	// === Get by ID (all primitive types) ===

	server.tool(
		'pcb_get_components',
		'Get one or more PCB components by primitive ID(s)',
		{
			primitiveIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of IDs'),
		},
		async ({ primitiveIds }) => {
			const result = await bridge.send('pcb.get.component', { primitiveIds });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_component',
		'Find a PCB footprint by designator (e.g. "U5"): primitiveId, x, y (mil), rotation, layer, lock state and its pads (number, net, position in mil). Use the primitiveId with pcb_move_component / pcb_modify_component.',
		{
			designator: z.string().describe('Component designator, e.g. "U5"'),
			includePads: z.boolean().optional().describe('Include the pad list (default true)'),
			instance_id: z.string().optional(),
			document: z.string().optional().describe('PCB document UUID (default: active tab)'),
		},
		async (params) => {
			const result = await bridge.send('pcb.component.findByDesignator', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_tracks',
		'Get one or more track segments (lines) by primitive ID(s)',
		{
			primitiveIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of IDs'),
		},
		async ({ primitiveIds }) => {
			const result = await bridge.send('pcb.get.line', { primitiveIds });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_polyline_tracks',
		'Get one or more polyline tracks by primitive ID(s)',
		{
			primitiveIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of IDs'),
		},
		async ({ primitiveIds }) => {
			const result = await bridge.send('pcb.get.polyline', { primitiveIds });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_vias',
		'Get one or more vias by primitive ID(s)',
		{
			primitiveIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of IDs'),
		},
		async ({ primitiveIds }) => {
			const result = await bridge.send('pcb.get.via', { primitiveIds });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_pads',
		'Get one or more pads by primitive ID(s)',
		{
			primitiveIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of IDs'),
		},
		async ({ primitiveIds }) => {
			const result = await bridge.send('pcb.get.pad', { primitiveIds });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_pours',
		'Get one or more copper pours by primitive ID(s)',
		{
			primitiveIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of IDs'),
		},
		async ({ primitiveIds }) => {
			const result = await bridge.send('pcb.get.pour', { primitiveIds });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_fills',
		'Get one or more fill regions by primitive ID(s)',
		{
			primitiveIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of IDs'),
		},
		async ({ primitiveIds }) => {
			const result = await bridge.send('pcb.get.fill', { primitiveIds });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_arcs',
		'Get one or more arc segments by primitive ID(s)',
		{
			primitiveIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of IDs'),
		},
		async ({ primitiveIds }) => {
			const result = await bridge.send('pcb.get.arc', { primitiveIds });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_regions',
		'Get one or more design rule regions by primitive ID(s)',
		{
			primitiveIds: z
				.union([z.string(), z.array(z.string())])
				.describe('Single primitive ID or array of IDs'),
		},
		async ({ primitiveIds }) => {
			const result = await bridge.send('pcb.get.region', { primitiveIds });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}
