import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam, withInstanceParam } from './query-params';

// editor_open_document: cold opens of large PCBs routinely exceed 15 s.
const DEFAULT_OPEN_DOCUMENT_WAIT_MS = 45_000;
// Request deadline beyond the extension's wait, so the wait always ends first.
const OPEN_DOCUMENT_HEADROOM_MS = 10_000;

// Screenshots: the extension downscales before base64-encoding (a full-res
// capture is ~730 KB of base64). Older extensions ignore the param.
const maxWidthParam = z.number().int().min(0).max(8192).optional().default(1280)
	.describe('Downscale captures wider than this many px before encoding (default 1280); 0 = full resolution.');

type Capture = {
	mimeType: string; size: number; base64: string; width?: number; height?: number;
	scaledFrom?: { width: number; height: number; size: number }; downscaleError?: string;
};

function captureSummary(r: Capture): string {
	const dims = r.width && r.height ? `, ${r.width}x${r.height}` : '';
	const from = r.scaledFrom ? `; downscaled from ${r.scaledFrom.width}x${r.scaledFrom.height}, ${r.scaledFrom.size} bytes` : '';
	const kept = r.downscaleError ? `; full resolution kept: ${r.downscaleError}` : '';
	return `Captured ${r.size} bytes (${r.mimeType}${dims}${from}${kept}).`;
}

export function registerEditorTools(server: McpServer, bridge: WebSocketBridge): void {
	const setTimeoutParam = (params: Record<string, unknown>): Record<string, unknown> => {
		const payload: Record<string, unknown> = { ...params };
		const explicit = Number((params as any).timeoutMs);
		const underscore = Number((params as any)._timeoutMs);
		const timeoutMs = Number.isFinite(explicit) && explicit > 0
			? explicit
			: (Number.isFinite(underscore) && underscore > 0 ? underscore : undefined);
		if (timeoutMs != null) {
			payload.timeoutMs = timeoutMs;
			// _timeoutMs sizes the bridge-side timer with margin so the
			// handler's own deadline fires first.
			payload._timeoutMs = timeoutMs + 5000;
		}
		return payload;
	};

	server.tool(
		'project_get_structure',
		'Project structure: boards, schematics, PCBs, panels, and active document.',
		withInstanceParam({}),
		async (params) => {
			const result = await bridge.send('editor.project.getStructure', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'editor_get_current_document',
		'Info about the focused document (schematic page or PCB) with parent context.',
		withInstanceParam({}),
		async (params) => {
			const result = await bridge.send('editor.getCurrentDocument', params);
			// Every schematic page carries its full title-block property bag
			// (~2 KB each, 97% of the payload) — identity is what callers need.
			return { content: [{ type: 'text', text: JSON.stringify(dropKeysDeep(result, TITLE_BLOCK_KEYS)) }] };
		},
	);

	server.tool(
		'editor_open_document',
		'Open/switch to a document by UUID (PCB, schematic, schematic page, panel). Waits until it is the active tab (large PCBs load slowly; default up to 45 s) and returns at once if already active. A timeout never blocks other tools; calling again with the same UUID joins the in-progress open.',
		withInstanceParam({
			documentUuid: z.string().optional().describe('Document UUID or tab id ("<uuid>@<projectUuid>"). Required (aliases: uuid, document).'),
			uuid: z.string().optional().describe('Alias of documentUuid.'),
			document: z.string().optional().describe('Alias of documentUuid.'),
			timeoutMs: z.number().int().positive().max(300_000).optional().describe('Max wait for the document to become active (default 45000).'),
		}),
		async ({ documentUuid, uuid, document, timeoutMs, ...params }) => {
			const target = documentUuid ?? uuid ?? document;
			if (!target) throw new Error('editor_open_document requires documentUuid (the PCB / schematic / page UUID from editor_get_open_tabs or project_get_structure).');
			// The extension waits up to `timeoutMs` and must finish before the
			// request deadline (`_timeoutMs`): opening is gated like a write, so
			// a request still running at that deadline would quarantine edits.
			const explicit = Number(params._timeoutMs);
			let waitMs = timeoutMs ?? DEFAULT_OPEN_DOCUMENT_WAIT_MS;
			let deadlineMs = waitMs + OPEN_DOCUMENT_HEADROOM_MS;
			if (Number.isFinite(explicit) && explicit > 0) {
				waitMs = Math.max(1_000, Math.min(waitMs, explicit - Math.min(OPEN_DOCUMENT_HEADROOM_MS, Math.max(1_000, explicit * 0.2))));
				deadlineMs = explicit;
			}
			// `document` is never forwarded: the daemon would treat it as the
			// routing document and the extension would activate it before the
			// handler runs, without this wait budget.
			const result = await bridge.send('editor.openDocument', {
				...params,
				documentUuid: target,
				timeoutMs: waitMs,
				// Absolute, so time spent queued behind other requests counts.
				waitUntil: Date.now() + waitMs,
				_timeoutMs: deadlineMs,
			});
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'editor_get_open_tabs',
		'Open tabs with the active tab marked. includeTree adds the raw split-screen layout tree (large).',
		withInstanceParam({
			includeTree: z.boolean().optional().default(false),
		}),
		async ({ includeTree, ...params }) => {
			const result: any = await bridge.send('editor.getOpenTabs', params);
			// The raw tree is ~99% of the payload (it even embeds cached DRC
			// panels); `tabs` already lists every tab.
			const slim = includeTree || !result || typeof result !== 'object' ? result : (({ splitScreenTree, ...rest }) => rest)(result);
			return { content: [{ type: 'text', text: JSON.stringify(slim) }] };
		},
	);

	server.tool(
		'wait_for_extension',
		'Block until the EasyEDA extension is connected to this MCP server. Use at the start of ad-hoc scripts before calling pcb_*/sch_* tools — avoids the "not connected" race when the agent fires before the extension attaches.',
		withInstanceParam({
			timeoutMs: z.number().int().positive().optional().default(15000).describe('Max wait (ms)'),
		}),
		async ({ timeoutMs }) => {
			const deadline = Date.now() + (timeoutMs ?? 15000);
			let lastRefresh = 0;
			while (Date.now() < deadline) {
				// In daemon mode this (re)connects to the daemon and respawns it
				// if it died — without it a dead daemon never shows the
				// extension as connected. Throttled to once a second.
				if (!bridge.isConnected() && Date.now() - lastRefresh > 1_000) {
					lastRefresh = Date.now();
					try { await (bridge as any).refreshAllInstanceInfo?.(); } catch { /* daemon still starting */ }
				}
				if (bridge.isConnected()) {
					// Re-query the extension (bounded, bypasses its request queue)
					// so a wedged or stale connection shows up here instead of on
					// the next tool call.
					try { await (bridge as any).refreshAllInstanceInfo?.(); } catch { /* report cached state */ }
					const instances: any[] = bridge.getConnectedInstances();
					const warnings: string[] = [];
					for (const i of instances) {
						const gate = i?.gate;
						if (!i?.bridgeGeneration) warnings.push(`Instance ${i?.instanceId}: extension predates the gate watchdog — reinstall the EasyEDA extension.`);
						if (gate?.status === 'busy' && (gate.active?.runningMs ?? 0) > 10_000) warnings.push(`Instance ${i?.instanceId}: EasyEDA call "${gate.active?.label}" has been running ${Math.round(gate.active.runningMs / 1000)}s (${gate.queued} queued). Press Esc / close dialogs in EasyEDA; native_operation_reset releases the queue.`);
						if (gate?.status === 'reconciliation-required') warnings.push(`Instance ${i?.instanceId}: a timed-out write needs native_operation_reconcile.`);
					}
					return { content: [{ type: 'text', text: JSON.stringify({ ready: true, instances, warnings: warnings.length ? warnings : undefined }) }] };
				}
				await new Promise((r) => setTimeout(r, 250));
			}
			return {
				content: [{ type: 'text', text: JSON.stringify({ ready: false, hint: 'Extension did not attach in time. Click Connect Claude in EasyEDA, or check that the extension is loaded.' }) }],
				isError: true,
			};
		},
	);

	server.tool(
		'pcb_screenshot_board',
		'Refresh ratlines, zoom-fit the board outline, and capture a PNG (downscaled to maxWidth, default 1280 px) — one call instead of three. Inline image content. Desktop Electron only.',
		withInstanceParam({
			tabId: z.string().optional(),
			maxWidth: maxWidthParam,
		}),
		async (params) => {
			try {
				const result = (await bridge.send('pcb.screenshot.board', params)) as Capture;
				return {
					content: [
						{ type: 'image', data: result.base64, mimeType: result.mimeType },
						{ type: 'text', text: captureSummary(result) },
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
		'pcb_screenshot_closeup',
		'Centre the PCB view on a region/point/trace segment and capture a PNG. EasyEDA Pro 2.2.47 exposes no region zoom, so the capture uses the CURRENT zoom level (zoom in manually for a tighter crop); regionApplied is "centered" when the pan succeeded. View-only: never blocks document edits. Desktop Electron only.',
		withDocumentParam({
			left: z.number().optional(),
			right: z.number().optional(),
			top: z.number().optional(),
			bottom: z.number().optional(),
			x: z.number().optional().describe('Center x in mil; use with y + radiusMil.'),
			y: z.number().optional().describe('Center y in mil; use with x + radiusMil.'),
			radiusMil: z.number().positive().optional().default(120).describe('Half-size around x/y.'),
			startX: z.number().optional().describe('Trace segment start x in mil; use with startY/endX/endY.'),
			startY: z.number().optional(),
			endX: z.number().optional(),
			endY: z.number().optional(),
			marginMil: z.number().nonnegative().optional().default(120).describe('Extra margin around a segment or explicit region.'),
			tabId: z.string().optional(),
			settleMs: z.number().int().nonnegative().optional().default(150).describe('Small render settle delay after zoom.'),
			confirmMs: z.number().int().positive().max(10_000).optional().describe('How long to poll the viewport for zoom confirmation (ms, default 1500). The zoom never blocks longer than this.'),
			timeoutMs: z.number().int().positive().optional().describe('Screenshot deadline in ms (handler default 15000).'),
			maxWidth: maxWidthParam,
		}),
		async (params) => {
			try {
				const result = (await bridge.send('pcb.screenshot.closeup', setTimeoutParam(params))) as Capture & { region: Record<string, number> };
				const { base64, mimeType, size, width, height, scaledFrom, downscaleError, region } = result;
				return {
					content: [
						{ type: 'image', data: base64, mimeType },
						{ type: 'text', text: JSON.stringify({ size, mimeType, width, height, scaledFrom, downscaleError, region }) },
					],
				};
			} catch (err: any) {
				return {
					content: [{ type: 'text', text: `Close-up screenshot failed: ${err?.message ?? err}` }],
					isError: true,
				};
			}
		},
	);

	server.tool(
		'editor_screenshot',
		'Capture the current canvas as a PNG (downscaled to maxWidth, default 1280 px). Returns inline image content. NOTE: EasyEDA Pro web app currently returns undefined for this API; works on desktop Electron. Falls back to a structured error.',
		withInstanceParam({
			tabId: z.string().optional().describe('Tab UUID; default = focused canvas'),
			maxWidth: maxWidthParam,
		}),
		async (params) => {
			try {
				const result = (await bridge.send('editor.screenshot', params)) as Capture;
				return {
					content: [
						{ type: 'image', data: result.base64, mimeType: result.mimeType },
						{ type: 'text', text: captureSummary(result) },
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
		'Bring a rectangle into view (mil for PCB, 0.01-inch for sch). On EasyEDA Pro 2.2.47 the region-zoom API is unhandled, so this centres the view on the rectangle at the current zoom and returns {panned, zoomApplied:false}. View-only: never blocks document edits.',
		withInstanceParam({
			left: z.number(),
			right: z.number(),
			top: z.number(),
			bottom: z.number(),
			tabId: z.string().optional(),
			confirmMs: z.number().int().positive().max(10_000).optional().describe('How long to poll the viewport for confirmation (ms, default 1500). Never blocks longer than this.'),
		}),
		async (params) => {
			const result = await bridge.send('editor.zoomToRegion', setTimeoutParam(params));
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'editor_zoom_to',
		'Center on (x,y) with optional scaleRatio (1-100, e.g. 200 = 200%). On EasyEDA Pro 2.2.47 the zoom call is unhandled: falls back to centring on (x,y) without changing zoom (scaleRatioApplied:false).',
		withInstanceParam({
			x: z.number().optional(),
			y: z.number().optional(),
			scaleRatio: z.number().optional(),
			tabId: z.string().optional(),
			timeoutMs: z.number().int().positive().optional().describe('Maximum wait in milliseconds if the viewport operation is slow. Defaults to 30000 in the extension handler.'),
		}),
		async (params) => {
			const result = await bridge.send('editor.zoomTo', setTimeoutParam(params));
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'editor_zoom_to_all',
		'Zoom-fit all primitives.',
		withInstanceParam({
			tabId: z.string().optional(),
			timeoutMs: z.number().int().positive().optional().describe('Maximum wait in milliseconds if the viewport operation is slow. Defaults to 30000 in the extension handler.'),
		}),
		async (params) => {
			const result = await bridge.send('editor.zoomToAllPrimitives', setTimeoutParam(params));
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'editor_zoom_to_selected',
		'Zoom-fit currently selected primitives.',
		withInstanceParam({
			tabId: z.string().optional(),
			timeoutMs: z.number().int().positive().optional().describe('Maximum wait in milliseconds if the viewport operation is slow. Defaults to 30000 in the extension handler.'),
		}),
		async (params) => {
			const result = await bridge.send('editor.zoomToSelected', setTimeoutParam(params));
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'editor_clear_markers',
		'Remove all indicator markers from the canvas.',
		withInstanceParam({ tabId: z.string().optional() }),
		async (params) => {
			const result = await bridge.send('editor.clearMarkers', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}

const TITLE_BLOCK_KEYS = new Set(['titleBlockData', 'showTitleBlock']);

function dropKeysDeep(value: unknown, keys: Set<string>): unknown {
	if (Array.isArray(value)) return value.map((v) => dropKeysDeep(v, keys));
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (!keys.has(k)) out[k] = dropKeysDeep(v, keys);
		return out;
	}
	return value;
}
