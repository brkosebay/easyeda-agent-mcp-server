import { openNativeDocument } from '../document-context';
import { readWithTimeout, didTimeOut } from './_utils';
import { centerViewOnRegion } from './document';

// Canvas screenshot can hang on large boards or when the renderer is mid-frame.
// 15s is generous for an off-screen render but tight enough to surface as an
// error rather than a wedged session. Override with `params.timeoutMs`.
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 15_000;
const DEFAULT_CANVAS_ZOOM_TIMEOUT_MS = 30_000;
// zoomToRegion's promise never settles on any known EasyEDA build, so the
// region path dispatches it and polls the viewport instead of awaiting.
const DEFAULT_ZOOM_CONFIRM_MS = 1_500;
// The closeup path is worthless without a confirmed zoom, so it waits longer
// than a bare viewport command before giving up and flagging regionApplied.
const DEFAULT_CLOSEUP_CONFIRM_MS = 4_000;

function zoomConfirmWindowMs(params: any): number {
	const explicit = Number(params?.confirmMs);
	if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, 10_000);
	return DEFAULT_ZOOM_CONFIRM_MS;
}

async function dispatchZoomToRegion(
	label: string,
	region: { left: number; right: number; top: number; bottom: number },
	_params: any,
): Promise<Record<string, any>> {
	// View-only: never quarantines the document, never waits on the
	// unhandled zoomToRegion RPC (see centerViewOnRegion).
	return centerViewOnRegion(label, region);
}

// dmt_EditorControl zoom calls that have no host handler on 2.2.47 get this
// much time before the fallback / clean error.
const UNHANDLED_VIEW_CALL_MS = 3_000;

function getTimeoutMs(params: any, fallbackMs: number): number {
	const explicit = Number(params?.timeoutMs);
	const underscore = Number(params?._timeoutMs);
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	if (Number.isFinite(underscore) && underscore > 0) return underscore;
	return fallbackMs;
}

async function awaitCanvasCommand<T>(label: string, fn: () => Promise<T>, params: any): Promise<T> {
	const ms = Math.min(getTimeoutMs(params, DEFAULT_CANVAS_ZOOM_TIMEOUT_MS), UNHANDLED_VIEW_CALL_MS);
	const out = await readWithTimeout(fn, ms);
	if (didTimeOut(out)) {
		throw new Error(`${label} did not complete within ${ms}ms. EasyEDA's renderer may still be busy; retry with a higher timeoutMs or a narrower target.`);
	}
	return out as T;
}

async function awaitScreenshot<T>(label: string, p: Promise<T>, params: any): Promise<T> {
	const ms = getTimeoutMs(params, DEFAULT_SCREENSHOT_TIMEOUT_MS);
	const out = await readWithTimeout(() => p, ms);
	if (didTimeOut(out)) {
		throw new Error(
			`${label} timed out after ${ms}ms. EasyEDA's renderer is likely mid-frame or busy on a large canvas. Try again after pcb_zoom_to_board, or pass a higher timeoutMs.`,
		);
	}
	return out as T;
}

/**
 * Recursively strip keys that are useless to LLMs (e.g. titleBlockData, showTitleBlock).
 * Mutates in place for efficiency — callers should pass a fresh copy if needed.
 */
function stripBloat(obj: any): any {
	if (obj == null || typeof obj !== 'object') return obj;
	if (Array.isArray(obj)) {
		for (const item of obj) stripBloat(item);
		return obj;
	}
	delete obj.titleBlockData;
	delete obj.showTitleBlock;
	for (const val of Object.values(obj)) {
		if (val && typeof val === 'object') stripBloat(val);
	}
	return obj;
}

// Screenshot caveat: as of 2026-03-15 all three candidate EasyEDA Pro
// screenshot APIs return undefined / hang in the web app. They MAY work on
// desktop Electron. The handler below tries getCurrentRenderedAreaImage
// (the simplest path) and returns a structured error if it fails so callers
// know it's a runtime limitation, not a tool bug.

async function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result as string;
			resolve(dataUrl.split(',')[1] || '');
		};
		reader.onerror = () => reject(new Error('Failed to read blob'));
		reader.readAsDataURL(blob);
	});
}

// Full-resolution captures are ~730 KB of base64 each; an agent reads them as
// an image where 1280 px wide is plenty. `maxWidth: 0` keeps full resolution.
const DEFAULT_SCREENSHOT_MAX_WIDTH = 1280;
const DOWNSCALE_TIMEOUT_MS = 5_000;

interface EncodedScreenshot {
	mimeType: string;
	size: number;
	base64: string;
	width?: number;
	height?: number;
	/** Present when the capture was downscaled: the original dimensions/bytes. */
	scaledFrom?: { width: number; height: number; size: number };
	/** Why the full-resolution image was kept although a downscale was wanted. */
	downscaleError?: string;
}

type Downscaled = { blob: Blob; width: number; height: number; scaledFrom?: EncodedScreenshot['scaledFrom'] };

// Decode, and when wider than maxWidth redraw onto a smaller canvas
// (OffscreenCanvas, else a DOM canvas). The original is returned when it is
// already narrow enough or the re-encode would not be smaller.
async function downscaleImage(blob: Blob, maxWidth: number): Promise<Downscaled> {
	const g: any = globalThis;
	if (typeof g.createImageBitmap !== 'function') throw new Error('no image decoder (createImageBitmap) in this runtime');
	const bitmap = await g.createImageBitmap(blob);
	try {
		const width = Number(bitmap.width);
		const height = Number(bitmap.height);
		if (!(width > maxWidth) || !(height > 0)) return { blob, width, height };
		const w = maxWidth;
		const h = Math.max(1, Math.round((height * maxWidth) / width));
		const type = blob.type || 'image/png';
		const draw = (ctx: any): void => {
			if (!ctx) throw new Error('2D canvas context unavailable');
			ctx.imageSmoothingEnabled = true;
			ctx.imageSmoothingQuality = 'high';
			ctx.drawImage(bitmap, 0, 0, w, h);
		};
		let scaled: Blob | null;
		if (typeof g.OffscreenCanvas === 'function') {
			const canvas = new g.OffscreenCanvas(w, h);
			draw(canvas.getContext('2d'));
			scaled = await canvas.convertToBlob({ type });
		} else if (typeof g.document?.createElement === 'function') {
			const canvas = g.document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			draw(canvas.getContext('2d'));
			scaled = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type));
		} else {
			throw new Error('no canvas (OffscreenCanvas or document) in this runtime');
		}
		if (!scaled || scaled.size === 0 || scaled.size >= blob.size) return { blob, width, height };
		return { blob: scaled, width: w, height: h, scaledFrom: { width, height, size: blob.size } };
	} finally {
		try { bitmap.close?.(); } catch {/* already released */}
	}
}

// Shared tail of every screenshot handler: optional downscale, then base64.
// Downscaling is best-effort — any failure ships the original capture.
async function encodeScreenshot(blob: Blob, params: any): Promise<EncodedScreenshot> {
	const requested = Number(params?.maxWidth);
	const maxWidth = params?.maxWidth != null && Number.isFinite(requested) && requested >= 0
		? Math.floor(requested)
		: DEFAULT_SCREENSHOT_MAX_WIDTH;
	let image: Downscaled = { blob, width: NaN, height: NaN };
	let downscaleError: string | undefined;
	if (maxWidth > 0) {
		try {
			const out = await readWithTimeout(() => downscaleImage(blob, maxWidth), DOWNSCALE_TIMEOUT_MS);
			if (didTimeOut(out)) downscaleError = `downscale timed out after ${DOWNSCALE_TIMEOUT_MS}ms`;
			else image = out;
		} catch (err: any) {
			downscaleError = String(err?.message ?? err);
		}
	}
	const result: EncodedScreenshot = {
		mimeType: image.blob.type || blob.type || 'image/png',
		size: image.blob.size,
		base64: await blobToBase64(image.blob),
	};
	if (Number.isFinite(image.width) && Number.isFinite(image.height)) {
		result.width = image.width;
		result.height = image.height;
	}
	if (image.scaledFrom) result.scaledFrom = image.scaledFrom;
	if (downscaleError) result.downscaleError = downscaleError;
	return result;
}

function closeupRegion(params: Record<string, any>): { left: number; right: number; top: number; bottom: number } {
	const margin = Number.isFinite(Number(params.marginMil)) ? Number(params.marginMil) : 120;
	if (
		Number.isFinite(Number(params.left)) &&
		Number.isFinite(Number(params.right)) &&
		Number.isFinite(Number(params.top)) &&
		Number.isFinite(Number(params.bottom))
	) {
		return normalizeRegion(Number(params.left), Number(params.right), Number(params.top), Number(params.bottom), 0);
	}
	if (
		Number.isFinite(Number(params.startX)) &&
		Number.isFinite(Number(params.startY)) &&
		Number.isFinite(Number(params.endX)) &&
		Number.isFinite(Number(params.endY))
	) {
		return normalizeRegion(Number(params.startX), Number(params.endX), Number(params.startY), Number(params.endY), margin);
	}
	if (Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.y))) {
		const radius = Number.isFinite(Number(params.radiusMil)) ? Number(params.radiusMil) : margin;
		const x = Number(params.x);
		const y = Number(params.y);
		return { left: x - radius, right: x + radius, top: y + radius, bottom: y - radius };
	}
	throw new Error('pcb_screenshot_closeup needs either {left,right,top,bottom}, {x,y,radiusMil}, or {startX,startY,endX,endY,marginMil}.');
}

/**
 * PCB canvas space has Y increasing upward with negative values below the
 * origin, so `top` is the GREATER Y and `bottom` the lesser. The previous
 * min/max assignment inverted every region, which is why zoomToRegion silently
 * ignored the rectangle and the closeup rendered the whole board.
 */
function normalizeRegion(aX: number, bX: number, aY: number, bY: number, margin: number): { left: number; right: number; top: number; bottom: number } {
	return {
		left: Math.min(aX, bX) - margin,
		right: Math.max(aX, bX) + margin,
		top: Math.max(aY, bY) + margin,
		bottom: Math.min(aY, bY) - margin,
	};
}

// The open wait must end before the caller's gate deadline: editor.openDocument
// is classified as a write, so a request still running when the gate watchdog
// fires would quarantine every later edit.
const GATE_DEADLINE_MARGIN_MS = 1_500;

function openDocumentDeadline(params: Record<string, any>): number | undefined {
	const candidates: number[] = [];
	const gate = Number(params?._gateDeadlineAt);
	if (Number.isFinite(gate) && gate > 0) candidates.push(gate - GATE_DEADLINE_MARGIN_MS);
	// Absolute deadline stamped by the MCP tool: unlike _timeoutMs it already
	// accounts for time spent queued behind other requests.
	const until = Number(params?.waitUntil);
	if (Number.isFinite(until) && until > 0) candidates.push(until);
	const relative = Number(params?._timeoutMs);
	if (Number.isFinite(relative) && relative > 0) {
		candidates.push(Date.now() + relative - Math.min(10_000, Math.max(1_000, relative * 0.2)));
	}
	return candidates.length ? Math.min(...candidates) : undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export const editorHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'editor.project.getStructure': async () => {
		const [project, currentDoc] = await Promise.all([
			eda.dmt_Project.getCurrentProjectInfo(),
			eda.dmt_SelectControl.getCurrentDocumentInfo(),
		]);
		return { project: stripBloat(project), currentDocument: currentDoc };
	},

	'editor.getCurrentDocument': async () => {
		const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (!doc) {
			return { document: undefined };
		}

		const result: Record<string, any> = { document: doc };

		// Schematic page (documentType 1)
		if (doc.documentType === 1) {
			const [page, schematic] = await Promise.all([
				eda.dmt_Schematic.getCurrentSchematicPageInfo(),
				eda.dmt_Schematic.getCurrentSchematicInfo(),
			]);
			result.schematicPage = page;
			result.schematic = schematic;
		}

		// PCB (documentType 3)
		if (doc.documentType === 3) {
			const [pcb, board] = await Promise.all([
				eda.dmt_Pcb.getCurrentPcbInfo(),
				eda.dmt_Board.getCurrentBoardInfo(),
			]);
			result.pcb = pcb;
			result.board = board;
		}

		return result;
	},

	// Fire-and-verify tab switch shared with ensureDocument (document-context):
	// never quarantines the gate, returns at once when the document is already
	// active, and a retry joins an open that is still loading.
	'editor.openDocument': async (params) => {
		const target = params.documentUuid ?? params.uuid;
		if (typeof target !== 'string' || !target.trim()) throw new Error('editor.openDocument requires documentUuid.');
		const result = await openNativeDocument(target, {
			timeoutMs: params.timeoutMs,
			deadlineAt: openDocumentDeadline(params),
			pollMs: params.pollMs,
		});
		return { ...result.document, alreadyActive: result.alreadyActive, via: result.via, waitedMs: result.waitedMs };
	},

	// Screenshot the current canvas rendered area. Works on desktop Electron
	// (returns Blob); typically returns undefined on the EasyEDA web app.
	'editor.screenshot': async (params) => {
		const blob = await awaitScreenshot(
			'editor.screenshot',
			eda.dmt_EditorControl.getCurrentRenderedAreaImage(params?.tabId),
			params,
		);
		if (!blob) {
			throw new Error(
				'Screenshot returned undefined. EasyEDA Pro web app does not currently expose canvas screenshots; ' +
				'this typically works only on the desktop Electron build. (Reported to EasyEDA engineering.)',
			);
		}
		return encodeScreenshot(blob, params);
	},

	// One-shot "show me the board": refresh ratlines + zoom-fit + capture.
	// Avoids three round-trips when an agent just wants a clean PCB image.
	'pcb.screenshot.board': async (params) => {
		await eda.pcb_Document.stopCalculatingRatline().catch(() => {});
		await eda.pcb_Document.startCalculatingRatline().catch(() => {});
		await eda.pcb_Document.zoomToBoardOutline().catch(() => {});
		const blob = await awaitScreenshot(
			'pcb.screenshot.board',
			eda.dmt_EditorControl.getCurrentRenderedAreaImage(params?.tabId),
			params,
		);
		if (!blob) {
			throw new Error(
				'Screenshot returned undefined. EasyEDA Pro web app does not currently expose canvas screenshots; ' +
				'this typically works only on the desktop Electron build.',
			);
		}
		return encodeScreenshot(blob, params);
	},

	// Zoom into a small PCB region and capture the rendered viewport. This is
	// intentionally one bridge call so agents do not have to chain slow zoom +
	// screenshot calls while debugging local routing/clearance mistakes.
	'pcb.screenshot.closeup': async (params) => {
		const region = closeupRegion(params);
		// Capturing before the canvas has actually moved yields a full-board
		// image with the requested region merely echoed back, so wait for the
		// viewport to confirm the zoom (bounded) and retry once if it does not.
		// Region zoom is unavailable on EasyEDA Pro 2.2.47; centre the view on
		// the region (current zoom) and capture. Nothing here can quarantine.
		const zoom = await dispatchZoomToRegion('pcb.screenshot.closeup', region, params);
		const regionApplied: 'centered' | false | 'unknown' = zoom.panned === true ? 'centered' : zoom.panned === 'unknown' ? 'unknown' : false;
		const settleMs = Math.max(0, Math.min(2_000, Number(params.settleMs ?? 300)));
		if (settleMs > 0) await sleep(settleMs);
		const blob = await awaitScreenshot(
			'pcb.screenshot.closeup',
			eda.dmt_EditorControl.getCurrentRenderedAreaImage(params?.tabId),
			params,
		);
		if (!blob) {
			throw new Error(
				'Screenshot returned undefined. EasyEDA Pro web app does not currently expose canvas screenshots; ' +
				'this typically works only on the desktop Electron build.',
			);
		}
		return {
			...(await encodeScreenshot(blob, params)),
			region,
			regionApplied,
			zoom,
			warning: regionApplied === 'centered'
				? 'View was centred on the region at the current zoom level (EasyEDA 2.2.47 exposes no region zoom); the region may be smaller or larger than the frame. Zoom manually in EasyEDA for a tighter crop, or use pcb_inspect_area for numeric detail.'
				: `The view could not be centred on the region (${zoom.error ?? 'navigateToCoordinates did not confirm'}); this image shows the previous view. Use pcb_inspect_area for numeric detail.`,
		};
	},

	// Canvas viewport control — pan/zoom that the agent can trigger.
	'editor.zoomToRegion': async (params) => {
		const left = Number(params.left);
		const right = Number(params.right);
		const top = Number(params.top);
		const bottom = Number(params.bottom);
		if (![left, right, top, bottom].every(Number.isFinite)) {
			throw new Error('editor.zoomToRegion requires finite {left, right, top, bottom}.');
		}
		return dispatchZoomToRegion('editor.zoomToRegion', { left, right, top, bottom }, params);
	},
	'editor.zoomTo': async (params) => {
		try {
			return await awaitCanvasCommand(
				'editor.zoomTo',
				() => eda.dmt_EditorControl.zoomTo(params.x, params.y, params.scaleRatio, params.tabId),
				params,
			);
		} catch (err) {
			// Unhandled on 2.2.47: centre on the point instead (zoom unchanged).
			if (Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.y))) {
				const x = Number(params.x), y = Number(params.y);
				return { ...(await centerViewOnRegion('editor.zoomTo', { left: x, right: x, top: y, bottom: y })), scaleRatioApplied: false };
			}
			throw err;
		}
	},
	'editor.zoomToAllPrimitives': async (params) => {
		try {
			return await awaitCanvasCommand(
				'editor.zoomToAllPrimitives',
				() => eda.dmt_EditorControl.zoomToAllPrimitives(params?.tabId),
				params,
			);
		} catch (err) {
			// Unhandled on 2.2.47; on a PCB the board-outline fit is handled.
			const info: any = await readWithTimeout(() => eda.dmt_SelectControl.getCurrentDocumentInfo(), 2_000).catch(() => undefined);
			if (info && !didTimeOut(info) && info.documentType === 3) {
				const out = await readWithTimeout(() => eda.pcb_Document.zoomToBoardOutline(), 3_000);
				return { command: 'editor.zoomToAllPrimitives', via: 'pcb_Document.zoomToBoardOutline', applied: didTimeOut(out) ? 'unknown' : out === true };
			}
			throw err;
		}
	},
	'editor.zoomToSelected': async (params) => {
		return awaitCanvasCommand(
			'editor.zoomToSelected',
			() => eda.dmt_EditorControl.zoomToSelectedPrimitives(params?.tabId),
			params,
		);
	},

	// Visual indicator markers — draw arrows / boxes on the canvas to point
	// at things the agent wants the user to notice.
	'editor.addMarkers': async (params) => {
		return eda.dmt_EditorControl.generateIndicatorMarkers(
			params.markers,
			params.color,
			params.lineWidth,
			params.zoom,
			params.tabId,
		);
	},
	'editor.clearMarkers': async (params) => {
		return eda.dmt_EditorControl.removeIndicatorMarkers(params?.tabId);
	},

	'editor.getOpenTabs': async () => {
		const [tree, currentDoc] = await Promise.all([
			eda.dmt_EditorControl.getSplitScreenTree(),
			eda.dmt_SelectControl.getCurrentDocumentInfo(),
		]);

		const tabs: Array<{ title: string; tabId: string; isActive: boolean }> = [];
		const activeUuid = currentDoc?.uuid;

		function collectTabs(node: any): void {
			if (node.tabs) {
				for (const tab of node.tabs) {
					tabs.push({
						title: tab.title,
						tabId: tab.tabId,
						isActive: activeUuid ? tab.tabId.startsWith(activeUuid) : false,
					});
				}
			}
			if (node.children) {
				for (const child of node.children) {
					collectTabs(child);
				}
			}
		}

		if (tree) {
			collectTabs(tree);
		}

		return { tabs, splitScreenTree: tree };
	},
};
