import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';

const layerSchema = z.union([z.string(), z.number()]);

export function registerPourFillTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_get_all_pours',
		`Get all copper pour regions on the PCB, optionally filtered by net and layer. Returns { total, returned, truncated, items } (default limit 100).
Each entry includes a compact \`summary\` block (mode L/R/complex, bbox, vertex count, first/last point) so you can tell rectangle-mode pours from arbitrary polygons without dumping every vertex.
Pass verbose:true to also include the full source polygon — typically only needed when you're about to reshape the pour.`,
		withDocumentParam({
			net: z.string().optional().describe('Filter by net name'),
			layer: layerSchema.optional().describe('Filter by layer'),
			verbose: z.boolean().optional().describe('Include full polygon source arrays (default false — geometry is stripped to keep responses compact). Always set this when inspecting pours before reshape/delete.'),
			limit: z.number().int().positive().optional().describe('Max items returned (default 100)'),
			fields: z.array(z.string()).optional().describe('Whitelist of fields to keep per item'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.getAll.pour', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_pour',
		'Get one or more pours by primitive ID. Returns a compact summary plus (optionally) the full polygon source — same shape as pcb_get_all_pours.',
		withDocumentParam({
			primitiveIds: z.union([z.string(), z.array(z.string())]).describe('Single primitive ID or array of IDs'),
			verbose: z.boolean().optional().describe('Include full polygon source arrays (default false).'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.get.pour', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_pour_inspect',
		`Inspect a single pour's geometry without dumping every vertex. Returns mode (L/R/complex), bbox, vertex count, first/last point, and the live routing/fill settings — the minimum an agent needs to decide whether to reshape, re-pour, or delete.
Use this BEFORE pcb_modify_primitive (type:"pour") or pcb_pour_set_rectangle when you need to reason about the existing shape.`,
		withDocumentParam({
			primitiveId: z.string().describe('The pour primitive ID'),
			includeSource: z.boolean().optional().describe('Include the raw polygon source array (default false — only set when you actually need every vertex).'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.pour.inspect', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_pour_set_rectangle',
		`Reshape an existing pour to a rectangle by setting an R-mode source polygon ["R", cx, cy, w, h, rotation, cornerRadius].
Convenience wrapper around pcb_modify_primitive (type:"pour") for the common "make this pour a rectangle" case — skips having to remember the R-mode tuple format and validates dimensions.
Other routing settings (net, layer, fillMethod, …) can be updated in the same call.`,
		withDocumentParam({
			primitiveId: z.string().describe('The pour primitive ID'),
			cx: z.number().describe('Rectangle center X (mil)'),
			cy: z.number().describe('Rectangle center Y (mil)'),
			w: z.number().positive().describe('Rectangle width (mil)'),
			h: z.number().positive().describe('Rectangle height (mil)'),
			rotation: z.number().optional().describe('Rotation in degrees (default 0)'),
			cornerRadius: z.number().optional().describe('Corner radius in mil (default 0)'),
			net: z.string().optional().describe('Optionally also change net'),
			layer: layerSchema.optional().describe('Optionally also change layer'),
			pourFillMethod: z.enum(['solid', '45grid', '90grid']).optional().describe('Optionally also change fill method'),
			preserveSilos: z.boolean().optional(),
			pourName: z.string().optional(),
			pourPriority: z.number().optional(),
			lineWidth: z.number().optional(),
			primitiveLock: z.boolean().optional(),
		}),
		async (params) => {
			const result = await bridge.send('pcb.pour.setRectangle', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_delete_pours',
		`Delete copper pour regions by ID. Returns a per-ID outcome (deleted, locked, or not-found) so you can see exactly which pours were removed and why others weren't.
Locked pours are skipped by default — pass force:true to unlock-then-delete.`,
		withDocumentParam({
			ids: z.array(z.string()).describe('Array of pour primitive IDs to delete'),
			force: z.boolean().optional().describe('Unlock locked pours before deleting (default false — locked pours are skipped and reported).'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.delete.pour', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_get_all_fills',
		'Get all fill regions on the PCB, optionally filtered by layer and net. Returns { total, returned, truncated, items } (default limit 100).',
		withDocumentParam({
			layer: layerSchema.optional().describe('Filter by layer'),
			net: z.string().optional().describe('Filter by net name'),
			limit: z.number().int().positive().optional().describe('Max items returned (default 100)'),
			fields: z.array(z.string()).optional().describe('Whitelist of fields to keep per item'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.getAll.fill', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_delete_fills',
		'Delete fill regions by their IDs',
		withDocumentParam({
			ids: z.array(z.string()).describe('Array of fill primitive IDs to delete'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.delete.fill', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}
