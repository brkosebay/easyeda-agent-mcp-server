import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam, withQueryParams } from './query-params';

export function registerAnalysisTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_highlight_net',
		'Highlight a specific net in the PCB editor for visual inspection',
		withDocumentParam({
			net: z.string().describe('Net name to highlight'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.net.highlight', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_select_net',
		'Select all primitives of a specific net in the PCB editor',
		withDocumentParam({
			net: z.string().describe('Net name to select'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.net.select', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_clear_selection',
		'Clear all selection in the PCB editor',
		withDocumentParam({}),
		async (params) => {
			const result = await bridge.send('pcb.select.clear', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_navigate_to',
		'Navigate the PCB editor viewport to specific coordinates',
		withDocumentParam({
			x: z.number().describe('X coordinate to navigate to'),
			y: z.number().describe('Y coordinate to navigate to'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.document.navigateTo', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_navigate_to_region',
		'Navigate and zoom the PCB editor viewport to fit a specific region',
		withDocumentParam({
			left: z.number().describe('Left boundary X'),
			right: z.number().describe('Right boundary X'),
			top: z.number().describe('Top boundary Y'),
			bottom: z.number().describe('Bottom boundary Y'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.document.navigateToRegion', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_zoom_to_board',
		'Zoom the viewport to fit the entire board outline',
		withDocumentParam({}),
		async (params) => {
			const result = await bridge.send('pcb.document.zoomToBoardOutline', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_refresh_canvas',
		'Force a canvas redraw by cycling the ratline calculator and re-zooming. Use when newly created tracks/vias do not visually appear despite being present in API queries — common after batch routing.',
		withDocumentParam({
			zoom: z.boolean().optional().default(true).describe('Also zoom-to-board (default true)'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.document.refresh', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_layer_status',
		'Get every layer with id, name, layerStatus (0=NOTUSED, 1=SHOW, 2=HIDDEN), lock state, and transparency. Pair with pcb_get_canvas_filter when tracks/vias seem missing in the editor.',
		withDocumentParam({}),
		async (params) => {
			const result = await bridge.send('pcb.layer.getStatus', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_canvas_filter',
		'Get the current canvas filter — reveals if Track/Via/Pad/etc display has been turned off in the EDA UI. Useful for diagnosing "I created tracks but cannot see them".',
		withDocumentParam({}),
		async (params) => {
			const result = await bridge.send('pcb.document.getCanvasFilter', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_primitive_at_point',
		'Get the primitive at a specific point on the PCB',
		withDocumentParam({
			x: z.number().describe('X coordinate'),
			y: z.number().describe('Y coordinate'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.document.getPrimitiveAtPoint', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_primitives_in_region',
		'Get all primitives within a rectangular region on the PCB',
		withQueryParams({
			left: z.number().describe('Left boundary X'),
			right: z.number().describe('Right boundary X'),
			top: z.number().describe('Top boundary Y'),
			bottom: z.number().describe('Bottom boundary Y'),
			leftToRight: z
				.boolean()
				.optional()
				.describe('true=must be fully inside, false=intersecting also counts'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.document.getPrimitivesInRegion', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_canvas_origin',
		'Get or set the canvas origin offset relative to data origin',
		withDocumentParam({
			action: z.enum(['get', 'set']).describe('"get" to read, "set" to write'),
			offsetX: z.number().optional().describe('X offset (required for set)'),
			offsetY: z.number().optional().describe('Y offset (required for set)'),
		}),
		async ({ action, ...rest }) => {
			if (action === 'get') {
				const result = await bridge.send('pcb.document.getCanvasOrigin', rest);
				return { content: [{ type: 'text', text: JSON.stringify(result) }] };
			}
			const result = await bridge.send('pcb.document.setCanvasOrigin', rest);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_convert_coordinates',
		'Convert between canvas coordinates and data coordinates',
		withDocumentParam({
			direction: z.enum(['canvasToData', 'dataToCanvas']).describe('Conversion direction'),
			x: z.number().describe('X coordinate'),
			y: z.number().describe('Y coordinate'),
		}),
		async ({ direction, ...rest }) => {
			const method =
				direction === 'canvasToData'
					? 'pcb.document.convertCanvasToData'
					: 'pcb.document.convertDataToCanvas';
			const result = await bridge.send(method, rest);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_import_changes',
		'Import changes from schematic into the PCB (sync schematic to PCB)',
		withDocumentParam({
			uuid: z.string().optional().describe('Schematic UUID (uses associated schematic if not provided)'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.document.importChanges', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}
