import { readWithTimeout as callWithTimeout, envelopeStateArray, flattenState, flattenStateArray, normalizeLayer, didTimeOut } from './_utils';
import type { PolygonTransform } from './pour-fill';
import { readPourSource, resolveCanvasTransform, summarizePolygonSource } from './pour-fill';
import { normalizePadShapeUnits } from './trace-obstacles';

const DEFAULT_BOARD_ZOOM_TIMEOUT_MS = 5_000;
const DEFAULT_PRIMITIVE_QUERY_TIMEOUT_MS = 5_000;
// navigateToRegion never settles its promise on any known EasyEDA build, so
// the handler dispatches it and then watches the viewport for a bounded
// window instead of awaiting anything.
const DEFAULT_REGION_CONFIRM_MS = 1_500;
const REGION_POLL_INTERVAL_MS = 120;
const VIEWPORT_PROBE_TIMEOUT_MS = 500;
const DEFAULT_REGION_MAX_ITEMS = 200;

export interface Viewport { left: number; right: number; top: number; bottom: number }
export interface RegionBox { left: number; right: number; top: number; bottom: number }
interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Last pcb_save issued through the bridge (see 'pcb.document.save').
let pendingSave: { uuid: string; startedAt: number; settled: boolean; result: unknown; error?: string } | undefined;
// Last pcb_import_changes dispatch (its promise settles only after GUI confirmation).
let pendingImport: { startedAt: number; settled: boolean } | undefined;

/** Fire an SDK call whose promise may never settle; failures are swallowed. */
export function dispatchUnawaited(fn: () => Promise<unknown>): void {
	try {
		Promise.resolve().then(fn).catch(() => {});
	} catch {/* */}
}

/**
 * Cheap viewport probe: `zoomTo()` with no arguments reports the current
 * region without changing it. Raced against a short deadline so a wedged
 * renderer yields "unknown" instead of blocking the caller.
 */
export async function readViewport(tabId?: string): Promise<Viewport | undefined> {
	const out = await callWithTimeout(
		() => eda.dmt_EditorControl.zoomTo(undefined, undefined, undefined, tabId),
		VIEWPORT_PROBE_TIMEOUT_MS,
	).catch(() => undefined);
	if (!out || didTimeOut(out) || typeof out !== 'object') return undefined;
	const v = out as Viewport;
	const values = [v.left, v.right, v.top, v.bottom];
	if (!values.every((n) => Number.isFinite(n))) return undefined;
	return { left: v.left, right: v.right, top: v.top, bottom: v.bottom };
}

function viewportChanged(a: Viewport | undefined, b: Viewport | undefined): boolean {
	if (!a || !b) return false;
	const epsilon = 0.5;
	return Math.abs(a.left - b.left) > epsilon
		|| Math.abs(a.right - b.right) > epsilon
		|| Math.abs(a.top - b.top) > epsilon
		|| Math.abs(a.bottom - b.bottom) > epsilon;
}

function viewportCentersOn(viewport: Viewport | undefined, region: RegionBox): boolean {
	if (!viewport) return false;
	const centerX = (viewport.left + viewport.right) / 2;
	const centerY = (viewport.top + viewport.bottom) / 2;
	return centerX >= Math.min(region.left, region.right)
		&& centerX <= Math.max(region.left, region.right)
		&& centerY >= Math.min(region.top, region.bottom)
		&& centerY <= Math.max(region.top, region.bottom);
}

function confirmWindowMs(params: Record<string, any>): number {
	const explicit = Number(params?.confirmMs ?? params?.timeoutMs);
	if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, 10_000);
	return DEFAULT_REGION_CONFIRM_MS;
}

/**
 * Dispatch a viewport command that may never resolve, then poll for evidence
 * that the canvas actually moved. Always returns; `confirmed:false` means the
 * command was sent but no viewport change was observed in the window.
 */
export async function dispatchViewportCommand(args: {
	label: string;
	fire: () => Promise<unknown>;
	region: RegionBox;
	tabId?: string;
	windowMs: number;
}): Promise<Record<string, any>> {
	const { label, fire, region, tabId, windowMs } = args;
	const before = await readViewport(tabId);
	const startedAt = Date.now();
	dispatchUnawaited(fire);

	let after = before;
	let confirmed = false;
	// `zoomTo()` with no arguments is itself an SDK call that never settles on
	// some builds. When it never answers we cannot distinguish "the zoom was
	// ignored" from "we cannot see the viewport", so report that separately
	// instead of claiming the command failed.
	let probeAvailable = before !== undefined;
	while (Date.now() - startedAt < windowMs) {
		await sleep(REGION_POLL_INTERVAL_MS);
		const current = await readViewport(tabId);
		if (current) {
			after = current;
			probeAvailable = true;
		}
		if (viewportChanged(before, current) || viewportCentersOn(current, region)) {
			confirmed = true;
			break;
		}
	}

	return {
		command: label,
		dispatched: true,
		confirmed,
		viewportProbeAvailable: probeAvailable,
		region,
		viewportBefore: before,
		viewportAfter: after,
		waitedMs: Date.now() - startedAt,
		confirmWindowMs: windowMs,
		note: confirmed
			? undefined
			: probeAvailable
				? 'Command was sent; EasyEDA never resolves this API and no viewport change was observed within the confirmation window. The canvas may still have moved.'
				: 'Command was sent, but this build also never resolves the read-only viewport probe (zoomTo() with no arguments), so the move can be neither confirmed nor ruled out. Treat the region as requested, not verified.',
	};
}

const VIEW_CALL_TIMEOUT_MS = 3_000;

/**
 * Bring a region into view on EasyEDA Pro 2.2.47. The extension API's region
 * zoom calls (dmt_EditorControl.zoomToRegion / zoomTo / zoomToAllPrimitives,
 * pcb_Document.navigateToRegion) have no host handler on this build — their
 * promises never settle and the canvas never moves. The calls that ARE
 * handled are navigateToCoordinates (centre the view on a point at the
 * current zoom; mil, same frame as other PCB/SCH API coordinates) and
 * pcb_Document.zoomToBoardOutline (fit board). So centre on the region and
 * say plainly that the zoom level was not changed.
 */
export async function centerViewOnRegion(label: string, region: RegionBox): Promise<Record<string, any>> {
	const center = { x: (region.left + region.right) / 2, y: (region.top + region.bottom) / 2 };
	const info: any = await callWithTimeout(() => eda.dmt_SelectControl.getCurrentDocumentInfo(), VIEW_CALL_TIMEOUT_MS).catch(() => undefined);
	const docType = info && !didTimeOut(info) ? info.documentType : undefined;
	let via: string | undefined;
	let panned: boolean | 'unknown' = false;
	let error: string | undefined;
	try {
		if (docType === 3) {
			via = 'pcb_Document.navigateToCoordinates';
			const out = await callWithTimeout(() => eda.pcb_Document.navigateToCoordinates(center.x, center.y), VIEW_CALL_TIMEOUT_MS);
			panned = didTimeOut(out) ? 'unknown' : out === true;
		} else if (docType === 1) {
			via = 'sch_Document.navigateToCoordinates';
			const out = await callWithTimeout(() => (eda.sch_Document as any).navigateToCoordinates(center.x, center.y), VIEW_CALL_TIMEOUT_MS);
			panned = didTimeOut(out) ? 'unknown' : out === true;
		} else {
			error = 'Active tab is neither a PCB nor a schematic.';
		}
	} catch (err: any) {
		error = err?.message ?? String(err);
	}
	return {
		command: label,
		region,
		center,
		panned,
		zoomApplied: false,
		via,
		error,
		note: 'EasyEDA Pro 2.2.47 has no working region-zoom call in the extension API (zoomToRegion/zoomTo/navigateToRegion are unhandled and never resolve), so the view was centred on the region at the CURRENT zoom level. For a tighter view zoom in manually in EasyEDA; pcb_zoom_to_board fits the whole board.',
	};
}

function normalizeRegionParams(params: Record<string, any>): RegionBox {
	const left = Number(params?.left);
	const right = Number(params?.right);
	const top = Number(params?.top);
	const bottom = Number(params?.bottom);
	if (![left, right, top, bottom].every(Number.isFinite)) {
		throw new Error('Region requires finite {left, right, top, bottom} in mil (canvas space, Y negative below the origin).');
	}
	return { left, right, top, bottom };
}

function regionBounds(region: RegionBox): Bounds {
	return {
		minX: Math.min(region.left, region.right),
		maxX: Math.max(region.left, region.right),
		minY: Math.min(region.top, region.bottom),
		maxY: Math.max(region.top, region.bottom),
	};
}

function num(value: any): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function halfExtentOf(flat: any): { halfX: number; halfY: number } {
	const diameter = num(flat?.diameter);
	if (diameter != null) return { halfX: diameter / 2, halfY: diameter / 2 };
	const pad = flat?.pad;
	if (Array.isArray(pad)) {
		const w = num(pad[1]);
		const h = num(pad[2]);
		if (w != null && h != null) return { halfX: w / 2, halfY: h / 2 };
	}
	const width = num(flat?.width);
	const height = num(flat?.height);
	if (width != null && height != null) return { halfX: width / 2, halfY: height / 2 };
	return { halfX: 0, halfY: 0 };
}

function boundsOfPrimitive(flat: any, instance: any, transform: PolygonTransform): Bounds | undefined {
	const startX = num(flat?.startX);
	const startY = num(flat?.startY);
	const endX = num(flat?.endX);
	const endY = num(flat?.endY);
	if (startX != null && startY != null && endX != null && endY != null) {
		const pad = (num(flat?.lineWidth) ?? 0) / 2;
		return {
			minX: Math.min(startX, endX) - pad,
			maxX: Math.max(startX, endX) + pad,
			minY: Math.min(startY, endY) - pad,
			maxY: Math.max(startY, endY) + pad,
		};
	}

	const x = num(flat?.x);
	const y = num(flat?.y);
	if (x != null && y != null) {
		const { halfX, halfY } = halfExtentOf(flat);
		return { minX: x - halfX, maxX: x + halfX, minY: y - halfY, maxY: y + halfY };
	}

	if (!transform.resolved) return undefined;
	const summary = summarizePolygonSource(readPourSource(instance), transform);
	const bbox = summary?.bbox;
	if (bbox && [bbox.minX, bbox.maxX, bbox.minY, bbox.maxY].every((n: any) => Number.isFinite(n))) {
		return { minX: bbox.minX, maxX: bbox.maxX, minY: bbox.minY, maxY: bbox.maxY };
	}
	return undefined;
}

function boundsInside(box: Bounds, region: Bounds): boolean {
	return box.minX >= region.minX && box.maxX <= region.maxX && box.minY >= region.minY && box.maxY <= region.maxY;
}

function boundsOverlap(box: Bounds, region: Bounds): boolean {
	return box.minX <= region.maxX && box.maxX >= region.minX && box.minY <= region.maxY && box.maxY >= region.minY;
}

// Per-source deadline. Some getAll* APIs (String/Fill/Arc on several builds)
// return a promise that never settles; without an individual race one wedged
// source stalls the whole region query regardless of the caller's timeout.
const REGION_SOURCE_TIMEOUT_MS = 3_000;

/** Look up a primitive API lazily so a build that lacks it is skipped, not thrown. */
function regionApi(name: string): any {
	return (eda as any)?.[name];
}

const REGION_SOURCES: Array<{ type: string; load: () => Promise<any[]> }> = [
	{ type: 'Line', load: () => regionApi('pcb_PrimitiveLine').getAll(undefined, undefined, undefined) },
	{ type: 'Arc', load: () => regionApi('pcb_PrimitiveArc').getAll(undefined, undefined, undefined) },
	{ type: 'Pad', load: () => regionApi('pcb_PrimitivePad').getAll(undefined, undefined, undefined) },
	{ type: 'Via', load: () => regionApi('pcb_PrimitiveVia').getAll(undefined, undefined) },
	{ type: 'Component', load: () => regionApi('pcb_PrimitiveComponent').getAll() },
	{ type: 'String', load: () => regionApi('pcb_PrimitiveString').getAll(undefined, undefined, undefined) },
	{ type: 'Fill', load: () => regionApi('pcb_PrimitiveFill').getAll(undefined, undefined, undefined) },
	{ type: 'Region', load: () => regionApi('pcb_PrimitiveRegion').getAll(undefined, undefined, undefined) },
	{ type: 'Polyline', load: () => regionApi('pcb_PrimitivePolyline').getAll(undefined, undefined, undefined) },
	{ type: 'Pour', load: () => regionApi('pcb_PrimitivePour').getAll(undefined, undefined, undefined) },
];

/**
 * Load one region source under its own deadline. Never rejects and never
 * hangs: a missing API, a rejection, or a promise that never settles all come
 * back as `{ instances: [], reason }` so the caller can record it in
 * `skippedTypes` and keep going.
 */
async function loadRegionSource(
	source: { type: string; load: () => Promise<any[]> },
	timeoutMs: number,
): Promise<{ instances: any[]; reason?: string }> {
	try {
		const out = await callWithTimeout(async () => {
			const value = await source.load();
			return Array.isArray(value) ? value : [];
		}, timeoutMs);
		if (didTimeOut(out)) {
			return { instances: [], reason: `getAll did not settle within ${timeoutMs}ms (EasyEDA never resolves this API on this build)` };
		}
		return { instances: out as any[] };
	} catch (err: any) {
		return { instances: [], reason: err?.message ?? String(err) };
	}
}

function getTimeoutMs(params: any, fallbackMs: number = DEFAULT_BOARD_ZOOM_TIMEOUT_MS): number {
	const explicit = Number(params?.timeoutMs);
	const underscore = Number(params?._timeoutMs);
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	if (Number.isFinite(underscore) && underscore > 0) return underscore;
	return fallbackMs;
}

async function awaitBoardZoomCommand<T>(params: Record<string, any>, fn: () => Promise<T>): Promise<T> {
	const ms = getTimeoutMs(params);
	const out = await callWithTimeout(fn, ms);
	if (didTimeOut(out)) {
		throw new Error(`pcb.document.zoomToBoardOutline did not finish within ${ms}ms. EasyEDA's renderer may still be busy; retry with a higher timeoutMs or a smaller target.`);
	}
	return out as T;
}

async function awaitDocumentQueryCommand<T>(
	label: string,
	fn: () => Promise<T>,
	params: Record<string, any>,
): Promise<T> {
	const ms = getTimeoutMs(params, DEFAULT_PRIMITIVE_QUERY_TIMEOUT_MS);
	const out = await callWithTimeout(fn, ms);
	if (didTimeOut(out)) {
		throw new Error(`${label} did not complete within ${ms}ms. EasyEDA may be blocked on a large query. Retry with a higher timeoutMs or a smaller target.`);
	}
	return out as T;
}

export const documentHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// === Document ===

	// save(uuid) REQUIRES the document uuid (typings: `save(uuid: string)`);
	// the tool used to forward `params.uuid`, which is normally undefined, and
	// the call then never settled. Resolve the active PCB uuid, observe the
	// promise under a deadline, and never start a second save while EasyEDA
	// still owes an answer for the previous one.
	'pcb.document.save': async (params) => {
		const now = Date.now();
		const previous = pendingSave;
		if (previous && !previous.settled && params.force !== true) {
			return {
				saved: 'unknown',
				status: 'previous-save-pending',
				uuid: previous.uuid,
				pendingForMs: now - previous.startedAt,
				note: 'A previous pcb_save has not been answered by EasyEDA yet; not issuing another (pass force:true to override). Check the tab title for the unsaved marker, or save from the GUI (Cmd/Ctrl+S).',
			};
		}
		// EasyEDA Pro 3.x's pcb_Document.save() ignores its uuid and saves the
		// ACTIVE PCB, so a requested uuid must be the active one — otherwise the
		// wrong board would be saved silently.
		const requestedUuid = typeof params.uuid === 'string' && params.uuid ? params.uuid : undefined;
		const info = await callWithTimeout(() => eda.dmt_SelectControl.getCurrentDocumentInfo(), 3_000);
		if (didTimeOut(info)) throw new Error('EasyEDA did not report the active document within 3 s; nothing was saved. Retry.');
		if ((info as any)?.documentType !== undefined && (info as any).documentType !== 3) {
			throw new Error('The active tab is not a PCB; open the PCB (pass document) before pcb_save.');
		}
		const activeUuid = (info as any)?.uuid ? String((info as any).uuid) : undefined;
		if (requestedUuid && activeUuid && requestedUuid.split('@')[0] !== activeUuid.split('@')[0]) {
			throw new Error(`pcb_save was asked to save ${requestedUuid} but the active PCB is ${activeUuid}; EasyEDA saves only the active PCB. Pass document:"${requestedUuid}" so it is activated first; nothing was saved.`);
		}
		const uuid = requestedUuid ?? activeUuid;
		if (!uuid) throw new Error('Could not resolve the PCB document uuid to save; pass uuid.');

		const gateDeadlineAt = Number(params._gateDeadlineAt);
		const gateBudget = Number.isFinite(gateDeadlineAt) ? gateDeadlineAt - now - 5_000 : Infinity;
		const requested = Number(params.timeoutMs);
		const budgetMs = Math.max(1_000, Math.min(Number.isFinite(requested) && requested > 0 ? requested : 30_000, gateBudget));

		const record = { uuid, startedAt: now, settled: false as boolean, result: undefined as unknown, error: undefined as string | undefined };
		pendingSave = record;
		const call = Promise.resolve().then(() => eda.pcb_Document.save(uuid!));
		void call.then(
			(value) => { record.settled = true; record.result = value; },
			(err: any) => { record.settled = true; record.error = err?.message ?? String(err); },
		);
		const out = await callWithTimeout(() => call, budgetMs).catch((err: any) => { throw new Error(`pcb_Document.save rejected: ${err?.message ?? err}`); });
		if (didTimeOut(out)) {
			return {
				saved: 'unknown',
				status: 'pending',
				uuid,
				waitedMs: Date.now() - now,
				note: `EasyEDA did not answer save() within ${budgetMs} ms. The save may still complete; the bridge queue is released. Call pcb_save again later (it reports previous-save-pending until EasyEDA answers) or save from the GUI.`,
			};
		}
		return { saved: out === true, status: out === true ? 'saved' : 'failed', uuid, result: out, waitedMs: Date.now() - now };
	},

	// Force a canvas refresh: cycle the ratline calculator and re-zoom.
	// Use this when newly created tracks/vias don't visually appear even
	// though the API reports them as present.
	'pcb.document.refresh': async (params) => {
		const ratlineStatus = await eda.pcb_Document.getCalculatingRatlineStatus().catch(() => null);
		await eda.pcb_Document.stopCalculatingRatline().catch(() => {});
		await eda.pcb_Document.startCalculatingRatline().catch(() => {});
		let zoomResult;
		if (params?.zoom !== false) {
			zoomResult = await awaitBoardZoomCommand(params, () => eda.pcb_Document.zoomToBoardOutline());
		}
		return { ratlineStatus, zoomResult };
	},

	// Inspect canvas filter — reveals when Track/Via/etc display has been
	// turned off in the UI ("why don't I see my tracks?").
	//
	// EasyEDA's getCurrentFilterConfiguration() can hang forever on some
	// builds (web app especially). Race it against a 5 s internal deadline
	// so the call fails fast with a clear message instead of waiting out
	// the bridge's 120 s timeout.
	'pcb.document.getCanvasFilter': async () => {
		const result = await Promise.race([
			eda.pcb_Document.getCurrentFilterConfiguration(),
			new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
		]);
		if (result === undefined) {
			throw new Error(
				'getCurrentFilterConfiguration() did not respond within 5s. ' +
				'This API is known to hang on the EasyEDA Pro web app; try the desktop Electron build, ' +
				'or use pcb_get_layer_status for layer visibility info instead.',
			);
		}
		return result;
	},

	// Get layer visibility + lock status in a flat shape.
	'pcb.layer.getStatus': async () => {
		const layers = await eda.pcb_Layer.getAllLayers();
		return (layers || []).map((l: any) => ({
			id: l.id,
			name: l.name,
			type: l.type,
			layerStatus: l.layerStatus,    // 0=NOTUSED, 1=SHOW, 2=HIDDEN
			locked: l.locked,
			transparency: l.transparency,
		}));
	},

	'pcb.document.navigateTo': async (params) => {
		return awaitDocumentQueryCommand('pcb.document.navigateToCoordinates', () => eda.pcb_Document.navigateToCoordinates(params.x, params.y), params);
	},

	'pcb.document.navigateToRegion': async (params) => {
		const region = normalizeRegionParams(params);
		return centerViewOnRegion('pcb.document.navigateToRegion', region);
	},

	'pcb.document.getPrimitiveAtPoint': async (params) => {
		const primitive = await awaitDocumentQueryCommand(
			'pcb.document.getPrimitiveAtPoint',
			() => eda.pcb_Document.getPrimitiveAtPoint(params.x, params.y),
			params,
		);
		return flattenState(primitive);
	},

	// EasyEDA's getPrimitivesInRegion never settles its promise, so this is
	// served from the working getAll* APIs and bbox-filtered here.
	'pcb.document.getPrimitivesInRegion': async (params) => {
		const region = normalizeRegionParams(params);
		const bounds = regionBounds(region);
		const fullyInside = params.leftToRight === true;
		const maxItems = Math.max(1, Math.floor(Number(params.maxItems ?? DEFAULT_REGION_MAX_ITEMS)));
		const requestedTypes: string[] | undefined = Array.isArray(params.types) && params.types.length > 0
			? params.types.map((t: any) => String(t).toLowerCase())
			: undefined;
		const sourceTimeoutMs = Math.max(
			250,
			Math.min(15_000, Number(params.sourceTimeoutMs ?? REGION_SOURCE_TIMEOUT_MS)),
		);
		const transform = await resolveCanvasTransform();

		const matches: any[] = [];
		const countsByType: Record<string, number> = {};
		const scannedTypes: string[] = [];
		const skippedTypes: Array<{ type: string; reason: string }> = [];
		let scanned = 0;

		// Fetch every source concurrently, each under its own deadline, so one
		// wedged getAll* costs `sourceTimeoutMs` instead of the whole call.
		const selected = REGION_SOURCES.filter(
			(source) => !requestedTypes || requestedTypes.includes(source.type.toLowerCase()),
		);
		const loaded = await Promise.all(selected.map((source) => loadRegionSource(source, sourceTimeoutMs)));

		for (let i = 0; i < selected.length; i += 1) {
			const source = selected[i];
			const { instances, reason } = loaded[i];
			if (reason) {
				skippedTypes.push({ type: source.type, reason });
				continue;
			}
			scannedTypes.push(source.type);
			for (const instance of instances) {
				scanned += 1;
				const flat = flattenState(instance);
				const box = boundsOfPrimitive(flat, instance, transform);
				if (!box) continue;
				if (fullyInside ? !boundsInside(box, bounds) : !boundsOverlap(box, bounds)) continue;
				countsByType[source.type] = (countsByType[source.type] ?? 0) + 1;
				if (matches.length < maxItems) {
					matches.push({ primitiveType: source.type, ...flat, bbox: box });
				}
			}
		}

		const matched = Object.values(countsByType).reduce((sum, n) => sum + n, 0);
		return {
			total: scanned,
			matched,
			returned: matches.length,
			truncated: matches.length < matched,
			items: matches,
			region,
			units: 'mil',
			coordinateSpace: transform.coordinateSpace,
			selectionMode: fullyInside ? 'fullyInside' : 'intersecting',
			countsByType,
			scannedTypes,
			skippedTypes,
			maxItems,
			sourceTimeoutMs,
			note: [
				transform.resolved
					? undefined
					: 'Canvas origin could not be read, so polygon-source primitives (Pour/Region/Fill/Polyline) were excluded rather than reported in the wrong coordinate space.',
				skippedTypes.length > 0
					? `Skipped ${skippedTypes.length} primitive source(s) that did not answer within ${sourceTimeoutMs}ms; see skippedTypes. Raise sourceTimeoutMs to retry them.`
					: undefined,
			].filter(Boolean).join(' ') || undefined,
		};
	},

	'pcb.document.zoomToBoardOutline': async (params) => {
		return awaitBoardZoomCommand(params, () => eda.pcb_Document.zoomToBoardOutline());
	},

	'pcb.document.getCanvasOrigin': async () => {
		return eda.pcb_Document.getCanvasOrigin();
	},

	'pcb.document.setCanvasOrigin': async (params) => {
		return eda.pcb_Document.setCanvasOrigin(params.offsetX, params.offsetY);
	},

	'pcb.document.convertCanvasToData': async (params) => {
		return eda.pcb_Document.convertCanvasOriginToDataOrigin(params.x, params.y);
	},

	'pcb.document.convertDataToCanvas': async (params) => {
		return eda.pcb_Document.convertDataOriginToCanvasOrigin(params.x, params.y);
	},

	// importChanges(uuid?) has no options in the Pro API (typings 0.2.34): it
	// opens EasyEDA's "Confirm importing changes" dialog — with "Also update
	// track's net" ticked by default — and its promise settles only after a
	// human confirms. Awaiting it held the bridge queue. Dispatch, wait
	// briefly, and report the pending GUI confirmation instead.
	'pcb.document.importChanges': async (params) => {
		const now = Date.now();
		if (pendingImport && !pendingImport.settled && params.force !== true) {
			return {
				status: 'awaiting-gui-confirmation',
				imported: 'unknown',
				pendingForMs: now - pendingImport.startedAt,
				note: 'A previous import is still waiting for its GUI confirmation; not opening another (force:true overrides).',
			};
		}
		const requested = Number(params.waitMs);
		const gateDeadlineAt = Number(params._gateDeadlineAt);
		const gateBudget = Number.isFinite(gateDeadlineAt) ? gateDeadlineAt - now - 5_000 : Infinity;
		const waitMs = Math.max(500, Math.min(Number.isFinite(requested) && requested > 0 ? requested : 5_000, gateBudget));
		const record = { startedAt: now, settled: false as boolean };
		pendingImport = record;
		const call = Promise.resolve().then(() => eda.pcb_Document.importChanges(params.uuid));
		void call.then(() => { record.settled = true; }, () => { record.settled = true; });
		const out = await callWithTimeout(() => call, waitMs).catch((err: any) => { throw new Error(`pcb_Document.importChanges rejected: ${err?.message ?? err}`); });
		if (didTimeOut(out)) {
			return {
				status: 'awaiting-gui-confirmation',
				imported: 'unknown',
				waitedMs: Date.now() - now,
				changeList: null,
				note: 'EasyEDA opened its "Confirm importing changes" dialog. The Pro API exposes no options for it (no auto-apply, no "Also update track\'s net" control, no change list). ' +
					'A human must review it: UNTICK "Also update track\'s net" when components were added (it renames whole copper islands), then Apply. ' +
					'The bridge queue is released; call pcb_import_changes again after confirming to read the result, or verify with pcb_connectivity_status.',
			};
		}
		return { status: out === true ? 'imported' : 'failed', imported: out === true, result: out, waitedMs: Date.now() - now };
	},

	// === Selection ===

	'pcb.select.getAll': async () => {
		return flattenStateArray(await eda.pcb_SelectControl.getAllSelectedPrimitives());
	},

	'pcb.select.clear': async () => {
		return eda.pcb_SelectControl.clearSelected();
	},

	// === Pad ===

	'pcb.getAll.pad': async (params) => {
		const all = await eda.pcb_PrimitivePad.getAll(normalizeLayer(params.layer), params.net, params.primitiveLock);
		const env = envelopeStateArray(all, params);
		for (const item of env.items) normalizePadShapeUnits(item);
		return env;
	},

	'pcb.get.pad': async (params) => {
		const result = await eda.pcb_PrimitivePad.get(params.primitiveIds);
		if (Array.isArray(result)) return flattenStateArray(result).map((item) => normalizePadShapeUnits(item));
		return normalizePadShapeUnits(flattenState(result));
	},

	'pcb.create.pad': async (params) => {
		return eda.pcb_PrimitivePad.create(
			params.layer,
			params.padNumber,
			params.x,
			params.y,
			params.rotation,
			params.pad,
			params.net,
			params.hole,
			params.holeOffsetX,
			params.holeOffsetY,
			params.holeRotation,
			params.metallization,
			params.padType,
			params.specialPad,
			params.solderMaskAndPasteMaskExpansion,
			params.heatWelding,
			params.primitiveLock,
		);
	},

	'pcb.modify.pad': async (params) => {
		return eda.pcb_PrimitivePad.modify(params.primitiveId, params.property);
	},

	'pcb.delete.pad': async (params) => {
		return eda.pcb_PrimitivePad.delete(params.ids);
	},
};
