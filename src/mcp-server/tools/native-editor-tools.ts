// Native editor actions through EasyEDA's own editor bus (see
// src/extension/handlers/native-editor.ts): undo / redo / cancel-current-command
// and an offscreen board render that never moves the user's view.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam, withInstanceParam } from './query-params';

export function registerNativeEditorTools(server: McpServer, bridge: WebSocketBridge): void {
	const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
	const history = (kind: 'undo' | 'redo') => withDocumentParam({
		steps: z.number().int().min(1).max(20).optional().default(1),
		cancelFirst: z.boolean().optional().default(true).describe('return to the select tool first (the editor ignores history while a tool is active)'),
	});

	server.tool(
		'editor_undo',
		'Undo the last edit(s) on the active PCB through EasyEDA\'s own history (= Ctrl+Z). Reports whether the board actually changed. Document-wide: it can revert another agent\'s work, so it is refused while other agents hold work leases (orchestrator: override_leases).',
		history('undo'),
		async (params) => text(await bridge.send('editor.native.undo', { ...params, _timeoutMs: 20_000 })),
	);

	server.tool(
		'editor_redo',
		'Redo edit(s) undone with editor_undo on the active PCB (= Ctrl+Y). Reports whether the board actually changed.',
		history('redo'),
		async (params) => text(await bridge.send('editor.native.redo', { ...params, _timeoutMs: 20_000 })),
	);

	server.tool(
		'editor_cancel_command',
		'Put the PCB editor back into the select tool (= Esc): ends an active routing/placement/drawing mode that blocks other actions. Works even while a request holds the queue. Does not close dialogs.',
		withInstanceParam({}),
		async (params) => text(await bridge.send('editor.native.cancelCommand', { ...params, _timeoutMs: 10_000 })),
	);

	server.tool(
		'pcb_render_image',
		'Offscreen PNG render of the PCB by EasyEDA\'s renderer — your view does not move (unlike pcb_screenshot_*). No region = whole design (exact framing). left/right/top/bottom (API mil) = close-up crop of that area (framing approximate; a margin is added). width = output pixels.',
		withDocumentParam({
			width: z.number().int().min(200).max(4096).optional().default(1600),
			left: z.number().optional(),
			right: z.number().optional(),
			top: z.number().optional(),
			bottom: z.number().optional(),
		}),
		async (params) => {
			const result = (await bridge.send('pcb.native.renderImage', { ...params, _timeoutMs: 30_000 })) as {
				mimeType: string; base64: string; size: number; width: number; height: number; note?: string; crop?: unknown;
			};
			return {
				content: [
					{ type: 'image' as const, data: result.base64, mimeType: result.mimeType },
					{ type: 'text' as const, text: JSON.stringify({ width: result.width, height: result.height, size: result.size, crop: result.crop, note: result.note }) },
				],
			};
		},
	);
}
