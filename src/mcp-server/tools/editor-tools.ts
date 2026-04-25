import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withInstanceParam } from './query-params';

export function registerEditorTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'project_get_structure',
		'Project structure: boards, schematics, PCBs, panels, and active document.',
		withInstanceParam({}),
		async (params) => {
			const result = await bridge.send('editor.project.getStructure', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'editor_get_current_document',
		'Info about the focused document (schematic page or PCB) with parent context.',
		withInstanceParam({}),
		async (params) => {
			const result = await bridge.send('editor.getCurrentDocument', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'editor_open_document',
		'Open a document by UUID (schematic page / PCB / panel).',
		withInstanceParam({
			documentUuid: z.string(),
		}),
		async (params) => {
			const result = await bridge.send('editor.openDocument', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'editor_get_open_tabs',
		'Open tabs + split-screen tree, with active tab marked.',
		withInstanceParam({}),
		async (params) => {
			const result = await bridge.send('editor.getOpenTabs', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'editor_screenshot',
		'Capture the current canvas as a PNG. Returns inline image content. NOTE: EasyEDA Pro web app currently returns undefined for this API; works on desktop Electron. Falls back to a structured error.',
		withInstanceParam({
			tabId: z.string().optional().describe('Tab UUID; default = focused canvas'),
		}),
		async (params) => {
			try {
				const result = (await bridge.send('editor.screenshot', params)) as {
					mimeType: string;
					size: number;
					base64: string;
				};
				return {
					content: [
						{ type: 'image', data: result.base64, mimeType: result.mimeType },
						{ type: 'text', text: `Captured ${result.size} bytes (${result.mimeType}).` },
					],
				};
			} catch (err: any) {
				return {
					content: [{ type: 'text', text: `Screenshot failed: ${err?.message ?? err}` }],
					isError: true,
				};
			}
		},
	);

	server.tool(
		'editor_zoom_to_region',
		'Zoom the canvas to a rectangle (mil for PCB, 0.01-inch for sch).',
		withInstanceParam({
			left: z.number(),
			right: z.number(),
			top: z.number(),
			bottom: z.number(),
			tabId: z.string().optional(),
		}),
		async (params) => {
			const result = await bridge.send('editor.zoomToRegion', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'editor_zoom_to',
		'Center on (x,y) with optional scaleRatio (1-100, e.g. 200 = 200%).',
		withInstanceParam({
			x: z.number().optional(),
			y: z.number().optional(),
			scaleRatio: z.number().optional(),
			tabId: z.string().optional(),
		}),
		async (params) => {
			const result = await bridge.send('editor.zoomTo', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'editor_zoom_to_all',
		'Zoom-fit all primitives.',
		withInstanceParam({ tabId: z.string().optional() }),
		async (params) => {
			const result = await bridge.send('editor.zoomToAllPrimitives', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'editor_zoom_to_selected',
		'Zoom-fit currently selected primitives.',
		withInstanceParam({ tabId: z.string().optional() }),
		async (params) => {
			const result = await bridge.send('editor.zoomToSelected', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'editor_add_markers',
		'Draw indicator markers (arrows/boxes) on the canvas to highlight regions for the user. Pair with editor_clear_markers.',
		withInstanceParam({
			markers: z.array(z.any()).describe('Array of marker shape objects (rectangles/arrows/etc)'),
			color: z.object({ r: z.number(), g: z.number(), b: z.number(), alpha: z.number() }).optional(),
			lineWidth: z.number().optional(),
			zoom: z.boolean().optional().describe('Auto-zoom to markers'),
			tabId: z.string().optional(),
		}),
		async (params) => {
			const result = await bridge.send('editor.addMarkers', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);

	server.tool(
		'editor_clear_markers',
		'Remove all indicator markers from the canvas.',
		withInstanceParam({ tabId: z.string().optional() }),
		async (params) => {
			const result = await bridge.send('editor.clearMarkers', params);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		},
	);
}
