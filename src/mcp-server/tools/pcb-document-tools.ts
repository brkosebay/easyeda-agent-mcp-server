import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';

export function registerPcbDocumentTools(server: McpServer, bridge: WebSocketBridge): void {
	// === Navigation ===

	server.tool(
		'pcb_navigate_to_region',
		'Navigate and zoom the PCB editor viewport to fit a specific region',
		{
			left: z.number().describe('Left boundary X'),
			right: z.number().describe('Right boundary X'),
			top: z.number().describe('Top boundary Y'),
			bottom: z.number().describe('Bottom boundary Y'),
		},
		async ({ left, right, top, bottom }) => {
			const result = await bridge.send('pcb.document.navigateToRegion', { left, right, top, bottom });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_zoom_to_board',
		'Zoom the viewport to fit the entire board outline',
		{},
		async () => {
			const result = await bridge.send('pcb.document.zoomToBoardOutline');
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_refresh_canvas',
		'Force a canvas redraw by cycling the ratline calculator and re-zooming. Use when newly created tracks/vias do not visually appear despite being present in API queries — common after batch routing.',
		{
			zoom: z.boolean().optional().default(true).describe('Also zoom-to-board (default: true)'),
		},
		async ({ zoom }) => {
			const result = await bridge.send('pcb.document.refresh', { zoom });
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
		},
		async ({ x, y }) => {
			const result = await bridge.send('pcb.document.getPrimitiveAtPoint', { x, y });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_primitives_in_region',
		'Get all primitives within a rectangular region on the PCB',
		{
			left: z.number().describe('Left boundary X'),
			right: z.number().describe('Right boundary X'),
			top: z.number().describe('Top boundary Y'),
			bottom: z.number().describe('Bottom boundary Y'),
			leftToRight: z
				.boolean()
				.optional()
				.describe('Selection mode: true=must be fully inside, false=intersecting also counts'),
		},
		async ({ left, right, top, bottom, leftToRight }) => {
			const result = await bridge.send('pcb.document.getPrimitivesInRegion', {
				left,
				right,
				top,
				bottom,
				leftToRight,
			});
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
