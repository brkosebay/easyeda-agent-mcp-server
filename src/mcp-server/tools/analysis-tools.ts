import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam, withQueryParams } from './query-params';

const DEFAULT_DOCUMENT_QUERY_TIMEOUT_MS = 5_000;

function timeoutPayload(params: Record<string, unknown>): Record<string, unknown> {
	const timeoutMs = Number((params as any).timeoutMs);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { ...params };

	// Forward timeoutMs so the extension handler sees it; _timeoutMs sets the
	// bridge-side timer with margin so the handler's deadline fires first.
	return { ...params, _timeoutMs: timeoutMs + 5000 };
}

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
			timeoutMs: z.number().int().positive().default(DEFAULT_DOCUMENT_QUERY_TIMEOUT_MS).describe('Maximum wait in milliseconds if navigator call is slow.'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.document.navigateTo', timeoutPayload(params));
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_navigate_to_region',
		'Centre the PCB view on a region at the current zoom level (EasyEDA Pro 2.2.47 exposes no working region zoom). Returns {panned, zoomApplied:false, center}. View-only: never blocks document edits.',
		withDocumentParam({
			left: z.number().describe('Left boundary X'),
			right: z.number().describe('Right boundary X'),
			top: z.number().describe('Top boundary Y'),
			bottom: z.number().describe('Bottom boundary Y'),
			confirmMs: z.number().int().positive().max(10_000).optional().describe('How long to poll the viewport for confirmation (ms, default 1500). Never blocks longer than this.'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.document.navigateToRegion', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_zoom_to_board',
		'Zoom the viewport to fit the entire board outline',
		withDocumentParam({
			timeoutMs: z.number().int().positive().default(DEFAULT_DOCUMENT_QUERY_TIMEOUT_MS).describe('Maximum wait in milliseconds if renderer is slow.'),
		}),
		async ({ timeoutMs, ...rest }) => {
			const payload: Record<string, unknown> = { ...rest };
			const override = Number(timeoutMs);
			if (Number.isFinite(override) && override > 0) payload._timeoutMs = override;
			const result = await bridge.send('pcb.document.zoomToBoardOutline', payload);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_refresh_canvas',
		'Force a canvas redraw by cycling the ratline calculator and re-zooming. Use when newly created tracks/vias do not visually appear despite being present in API queries — common after batch routing.',
		withDocumentParam({
			timeoutMs: z.number().int().positive().default(DEFAULT_DOCUMENT_QUERY_TIMEOUT_MS).describe('Maximum wait in milliseconds if renderer is slow.'),
			zoom: z.boolean().optional().default(true).describe('Also zoom-to-board (default true)'),
		}),
		async ({ timeoutMs, ...rest }) => {
			const payload: Record<string, unknown> = { ...rest };
			const override = Number(timeoutMs);
			if (Number.isFinite(override) && override > 0) payload._timeoutMs = override;
			const result = await bridge.send('pcb.document.refresh', payload);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_layer_status',
		'Get layers with id, name, type, layerStatus (0=NOTUSED, 1=SHOW, 2=HIDDEN), lock state, and transparency. By default only layers in use (layerStatus≠0, plus Top/Bottom/outline/multi) with locked/transparency omitted when false/0; full:true returns every layer row. Pair with pcb_get_canvas_filter when tracks/vias seem missing in the editor.',
		withDocumentParam({
			full: z.boolean().optional().describe('Return all ~90 layer rows unfiltered (default false)'),
		}),
		async ({ full, ...params }) => {
			const result = await bridge.send('pcb.layer.getStatus', params);
			if (full || !Array.isArray(result)) return { content: [{ type: 'text', text: JSON.stringify(result) }] };
			const keep = new Set([1, 2, 11, 12]);
			const layers = (result as any[])
				.filter((l) => Number(l?.layerStatus) !== 0 || keep.has(Number(l?.id)))
				.map(({ locked, transparency, ...l }) => ({ ...l, ...(locked ? { locked } : {}), ...(transparency ? { transparency } : {}) }));
			const omitted = result.length - layers.length;
			return { content: [{ type: 'text', text: JSON.stringify({ layers, ...(omitted ? { omitted, note: 'unused layers omitted (full:true lists them)' } : {}) }) }] };
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
			timeoutMs: z.number().int().positive().default(DEFAULT_DOCUMENT_QUERY_TIMEOUT_MS).describe('Maximum wait in milliseconds if query is slow.'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.document.getPrimitiveAtPoint', timeoutPayload(params));
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_primitives_in_region',
		'Get primitives inside a rectangular region (mil, canvas space with negative Y below the origin). Served from the getAll* APIs and bbox-filtered server-side; returns a {total, matched, returned, truncated, items} envelope with per-type counts.',
		withQueryParams({
			left: z.number().describe('Left boundary X'),
			right: z.number().describe('Right boundary X'),
			top: z.number().describe('Top boundary Y'),
			bottom: z.number().describe('Bottom boundary Y'),
			leftToRight: z
				.boolean()
				.optional()
				.describe('true=must be fully inside, false/omitted=intersecting also counts'),
			types: z
				.array(z.string())
				.optional()
				.describe('Restrict the scan to these primitive types: Line, Arc, Pad, Via, Component, String, Fill, Region, Polyline, Pour.'),
			maxItems: z.number().int().positive().optional().describe('Cap on returned items (default 200).'),
			sourceTimeoutMs: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Per-primitive-source deadline in ms (default 3000). Sources that do not answer in time are reported in skippedTypes instead of stalling the query.'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.document.getPrimitivesInRegion', timeoutPayload(params));
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
		'Import changes from schematic into the PCB (sync schematic to PCB). EasyEDA\'s API (importChanges(uuid?)) has NO options: it always opens the GUI "Confirm importing changes" dialog with "Also update track\'s net" ticked, and returns no change list. This tool dispatches it, waits waitMs (default 5000) and returns {status:"imported"|"failed"} if EasyEDA answered, or {status:"awaiting-gui-confirmation"} when the dialog is waiting for a human — who should UNTICK "Also update track\'s net" when components were added, then Apply. The bridge queue is never held by the dialog; a repeat call while it is open does not open a second one (force:true overrides).',
		withDocumentParam({
			uuid: z.string().optional().describe('Schematic UUID (uses associated schematic if not provided)'),
			waitMs: z.number().int().positive().optional().describe('How long to wait for EasyEDA to answer before reporting a pending GUI confirmation (default 5000)'),
			force: z.boolean().optional().describe('Dispatch even if a previous import is still awaiting confirmation'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.document.importChanges', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}
