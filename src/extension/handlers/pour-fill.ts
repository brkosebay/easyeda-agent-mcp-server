import { canonicalDocumentId } from '../../shared/method-classes';
import { nativeHostStatus, readCopperSource, resolveNativePcbTab } from './native-copper';
import { readWithTimeout as callWithTimeout, readWithTimeout, didTimeOut, envelopeStateArray, flattenState, flattenStateArray, normalizeLayer, normalizePolygon, normalizeViaType, withTimeout } from './_utils';

// Repour timing constants live next to the repour implementation (REPOUR_*).
const DEFAULT_CREATE_POUR_MS = 60_000;
const ORIGIN_PROBE_TIMEOUT_MS = 2_000;
const ORIGIN_PROBE_SPAN = 1_000;

// Every geometry-bearing envelope is stamped with this so agents never have to
// guess which Y convention a payload uses. Tracks/pads/vias come out of the
// canvas getters with Y growing upward (negative below the origin); pour and
// region polygon SOURCE arrays store Y growing downward AND are expressed
// relative to the data origin, which the board may have offset from the canvas
// origin. Summaries are mapped through the runtime's own data→canvas affine so
// both agree; when that affine cannot be read we emit the untouched source
// values under a different stamp instead of half-transformed numbers.
export const COORDINATE_SPACE = 'canvas-mil-negY';
export const UNTRANSFORMED_COORDINATE_SPACE = 'data-space-untransformed';

export interface PolygonTransform {
	coordinateSpace: string;
	resolved: boolean;
	x(value: number): number;
	y(value: number): number;
}

/**
 * Y-flip-only transform, correct whenever the canvas origin equals the data
 * origin. Used as the default so callers that predate the affine keep their
 * existing output; handlers in this module resolve the real affine first.
 */
export const ASSUMED_ZERO_ORIGIN_TRANSFORM: PolygonTransform = {
	coordinateSpace: COORDINATE_SPACE,
	resolved: false,
	x: (value) => value,
	y: (value) => -value,
};

const UNTRANSFORMED: PolygonTransform = {
	coordinateSpace: UNTRANSFORMED_COORDINATE_SPACE,
	resolved: false,
	x: (value) => value,
	y: (value) => value,
};

function finitePoint(value: any): { x: number; y: number } | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const x = Number((value as any).x);
	const y = Number((value as any).y);
	return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

/**
 * Build the data→canvas affine for polygon SOURCE coordinates: undo the
 * source's positive-down Y convention, then apply the runtime's own
 * data-origin → canvas-origin mapping (probed at two points so both the
 * offset and the axis direction come from EasyEDA rather than a guess).
 */
export async function resolveCanvasTransform(): Promise<PolygonTransform> {
	const probe = await callWithTimeout(async () => {
		const [zero, span] = await Promise.all([
			eda.pcb_Document.convertDataOriginToCanvasOrigin(0, 0),
			eda.pcb_Document.convertDataOriginToCanvasOrigin(ORIGIN_PROBE_SPAN, ORIGIN_PROBE_SPAN),
		]);
		return { zero: finitePoint(zero), span: finitePoint(span) };
	}, ORIGIN_PROBE_TIMEOUT_MS).catch(() => undefined);

	if (probe && !didTimeOut(probe) && probe.zero && probe.span) {
		const scaleX = (probe.span.x - probe.zero.x) / ORIGIN_PROBE_SPAN;
		const scaleY = (probe.span.y - probe.zero.y) / ORIGIN_PROBE_SPAN;
		if (Number.isFinite(scaleX) && Number.isFinite(scaleY) && scaleX !== 0 && scaleY !== 0) {
			const originX = probe.zero.x;
			const originY = probe.zero.y;
			return {
				coordinateSpace: COORDINATE_SPACE,
				resolved: true,
				x: (value) => originX + scaleX * value,
				y: (value) => originY + scaleY * -value,
			};
		}
	}

	const origin = await callWithTimeout(() => eda.pcb_Document.getCanvasOrigin(), ORIGIN_PROBE_TIMEOUT_MS).catch(() => undefined);
	if (origin && !didTimeOut(origin)) {
		const offsetX = Number((origin as any).offsetX);
		const offsetY = Number((origin as any).offsetY);
		if (Number.isFinite(offsetX) && Number.isFinite(offsetY)) {
			return {
				coordinateSpace: COORDINATE_SPACE,
				resolved: true,
				x: (value) => value - offsetX,
				y: (value) => -value - offsetY,
			};
		}
	}

	return UNTRANSFORMED;
}

// Walk a TPCB_PolygonSourceArray and return a compact summary the agent can
// act on without us shipping every vertex. Handles both the MCP-friendly
// line form ["L", x1, y1, ...] and EasyEDA's native [x1, y1, "L", x2, y2].
// All Y values in the returned summary are canvas-convention (see
// COORDINATE_SPACE).
export function summarizePolygonSource(src: any, transform: PolygonTransform = ASSUMED_ZERO_ORIGIN_TRANSFORM): any {
	if (!src) return undefined;
	// Complex polygons are an array of source arrays — recurse.
	if (Array.isArray(src) && src.length > 0 && Array.isArray(src[0])) {
		const subs = (src as any[]).map((s) => summarizePolygonSource(s, transform)).filter(Boolean);
		const allX: number[] = [];
		const allY: number[] = [];
		for (const s of subs) {
			if (s?.bbox) {
				allX.push(s.bbox.minX, s.bbox.maxX);
				allY.push(s.bbox.minY, s.bbox.maxY);
			}
		}
		return {
			mode: 'complex',
			subPolygons: subs.length,
			bbox: allX.length
				? { minX: Math.min(...allX), maxX: Math.max(...allX), minY: Math.min(...allY), maxY: Math.max(...allY) }
				: undefined,
			coordinateSpace: transform.coordinateSpace,
			children: subs,
		};
	}
	if (!Array.isArray(src)) return undefined;

	if (typeof src[0] === 'number') {
		const xs: number[] = [];
		const ys: number[] = [];
		if (typeof src[0] === 'number' && typeof src[1] === 'number') {
			xs.push(src[0]);
			ys.push(src[1]);
		}
		for (let i = 2; i + 1 < src.length; i++) {
			if (src[i] === 'L') continue;
			const x = src[i], y = src[i + 1];
			if (typeof x === 'number' && typeof y === 'number') {
				xs.push(x);
				ys.push(y);
				i += 1;
			}
		}
		return summarizeLinePoints(xs, ys, transform);
	}

	if (typeof src[0] !== 'string') return undefined;

	const mode = src[0] as string;
	if (mode === 'R') {
		// EasyEDA source is ["R", left, top, w, h, rotation, cornerRadius].
		const [, x, y, w, h, rot, radius] = src as [string, number, number, number, number, number, number];
		const nearX = transform.x(x);
		const farX = transform.x(x + w);
		const nearY = transform.y(y);
		const farY = transform.y(y + h);
		return {
			mode: 'R',
			rectangle: {
				x: nearX,
				y: nearY,
				w,
				h,
				centerX: transform.x(x + w / 2),
				centerY: transform.y(y + h / 2),
				rotation: rot,
				cornerRadius: radius,
			},
			bbox: {
				minX: Math.min(nearX, farX),
				maxX: Math.max(nearX, farX),
				minY: Math.min(nearY, farY),
				maxY: Math.max(nearY, farY),
			},
			coordinateSpace: transform.coordinateSpace,
		};
	}
	if (mode === 'L') {
		// ["L", x1, y1, x2, y2, ...] — possibly closed by repeating first.
		const xs: number[] = [];
		const ys: number[] = [];
		for (let i = 1; i + 1 < src.length; i += 2) {
			const x = src[i], y = src[i + 1];
			if (typeof x === 'number') xs.push(x);
			if (typeof y === 'number') ys.push(y);
		}
		return summarizeLinePoints(xs, ys, transform);
	}
	return { mode, raw: src, coordinateSpace: 'data-mil-posY' };
}

// Number of leading vertices echoed back verbatim so an agent can sanity-check
// orientation/placement without pulling the whole ring.
const SUMMARY_POINT_SAMPLE = 8;

function summarizeLinePoints(xs: number[], ys: number[], transform: PolygonTransform = ASSUMED_ZERO_ORIGIN_TRANSFORM): any {
	const vertexCount = xs.length;
	const closed = vertexCount >= 2 && xs[0] === xs[vertexCount - 1] && ys[0] === ys[vertexCount - 1];
	const canvasXs = xs.map((x) => transform.x(x));
	const canvasYs = ys.map((y) => transform.y(y));
	const points: Array<{ x: number; y: number }> = [];
	for (let i = 0; i < Math.min(vertexCount, SUMMARY_POINT_SAMPLE); i++) {
		points.push({ x: canvasXs[i], y: canvasYs[i] });
	}
	return {
		mode: 'L',
		vertexCount,
		pointCount: vertexCount,
		closed,
		firstPoint: vertexCount > 0 ? { x: canvasXs[0], y: canvasYs[0] } : undefined,
		lastPoint: vertexCount > 0 ? { x: canvasXs[vertexCount - 1], y: canvasYs[vertexCount - 1] } : undefined,
		points,
		pointsTruncated: vertexCount > points.length,
		bbox: vertexCount
			? { minX: Math.min(...canvasXs), maxX: Math.max(...canvasXs), minY: Math.min(...canvasYs), maxY: Math.max(...canvasYs) }
			: undefined,
		coordinateSpace: transform.coordinateSpace,
	};
}

// Pull the source polygon array off a pour primitive instance — handles both
// class-instance form (with getState_*) and plain-object form (with the
// already-flattened complexPolygon/source field). Returns the raw array.
export function readPourSource(pour: any): any {
	if (!pour) return undefined;
	for (const fn of ['getState_ComplexPolygon', 'getState_Polygon', 'getState_Source']) {
		try {
			if (typeof pour[fn] === 'function') {
				const v = pour[fn]();
				if (v != null) return sourceOfPolygon(v);
			}
		} catch {/* */}
	}
	return sourceOfPolygon(pour.complexPolygon ?? pour.polygon ?? pour.source ?? pour.sourcePolygon);
}

function primitiveIdOf(instance: any): string | undefined {
	try {
		if (typeof instance?.getState_PrimitiveId === 'function') return instance.getState_PrimitiveId();
	} catch {/* */}
	return instance?.primitiveId;
}

/**
 * Attach a geometry summary to each envelope item, keyed by primitiveId.
 * Index-based pairing is unsafe here: the envelope may have been filtered or
 * limited, so item[i] is not necessarily instance[i].
 */
export function attachPolygonSummaries<T extends { items: any[] }>(
	envelope: T,
	instances: any[] | null | undefined,
	transform: PolygonTransform = ASSUMED_ZERO_ORIGIN_TRANSFORM,
): T {
	const byId = new Map<string, any>();
	for (const inst of instances || []) {
		const id = primitiveIdOf(inst);
		if (!id) continue;
		const summary = summarizePolygonSource(readPourSource(inst), transform);
		if (summary) byId.set(id, summary);
	}
	envelope.items = envelope.items.map((entry: any) => {
		const summary = entry?.primitiveId != null ? byId.get(String(entry.primitiveId)) : undefined;
		return summary ? { ...entry, summary } : entry;
	});
	return envelope;
}

function sourceOfPolygon(value: any): any {
	if (!value) return value;
	if (typeof value.getSource === 'function') {
		try { return value.getSource(); } catch {/* */}
	}
	return value;
}

export const pourFillHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// === Pour ===

	'pcb.getAll.pour': async (params) => {
		const transform = await resolveCanvasTransform();
		const all = await eda.pcb_PrimitivePour.getAll(params.net, normalizeLayer(params.layer), params.primitiveLock);
		const envelope = envelopeStateArray(all, params, { verbose: !!params.verbose });
		// Always include a compact `summary` per pour even when verbose=false
		// — this is the lowest-cost way for an agent to tell rectangle-mode
		// pours from L-mode pours and to bbox-check before reshaping.
		attachPolygonSummaries(envelope, all, transform);
		return { ...envelope, coordinateSpace: transform.coordinateSpace };
	},

	'pcb.get.pour': async (params) => {
		const transform = await resolveCanvasTransform();
		const result = await eda.pcb_PrimitivePour.get(params.primitiveIds);
		const verbose = !!params.verbose;
		if (Array.isArray(result)) {
			const flat = flattenStateArray(result, { verbose });
			return flat.map((entry, i) => {
				const s = summarizePolygonSource(readPourSource(result[i]), transform);
				return s ? { ...entry, summary: s } : entry;
			});
		}
		const flat = flattenState(result, { verbose });
		const s = summarizePolygonSource(readPourSource(result), transform);
		return s ? { ...flat, summary: s } : flat;
	},

	// Inspect one pour's geometry without dumping every vertex. Returns mode
	// (L/R/complex), bbox, vertex count, plus identity & current routing
	// settings — the minimum an agent needs to decide whether to reshape,
	// re-pour, or delete.
	'pcb.pour.inspect': async (params) => {
		const transform = await resolveCanvasTransform();
		const result = await eda.pcb_PrimitivePour.get(params.primitiveId);
		if (!result) {
			throw new Error(`Pour ${params.primitiveId} not found.`);
		}
		const flat = flattenState(result);
		const source = readPourSource(result);
		const summary = summarizePolygonSource(source, transform);
		return {
			primitiveId: flat.primitiveId,
			net: flat.net,
			layer: flat.layer,
			pourName: flat.pourName,
			pourPriority: flat.pourPriority,
			pourFillMethod: flat.pourFillMethod,
			preserveSilos: flat.preserveSilos,
			lineWidth: flat.lineWidth,
			primitiveLock: flat.primitiveLock,
			coordinateSpace: transform.coordinateSpace,
			summary,
			// Only include the raw source when explicitly asked — for an
			// L-mode pour with 200 vertices this can balloon by 8 KB.
			source: params.includeSource ? source : undefined,
		};
	},

	'pcb.create.pour': async (params) => {
		const polygonSource = normalizePolygon(params.polygon);
		let polygon: any = eda.pcb_MathPolygon.createPolygon(polygonSource as any);
		if (!polygon) {
			// Fallback: try complex polygon if the simple form was rejected.
			polygon = eda.pcb_MathPolygon.createComplexPolygon?.(polygonSource as any);
		}
		if (!polygon) throw new Error(buildPolygonError('pour', params.polygon, polygonSource));

		// Deadline so a malformed polygon (e.g. self-intersecting outline,
		// off-board bbox) can't lock EasyEDA's fill engine indefinitely. The
		// underlying create still keeps running in EasyEDA's worker if it
		// hangs — but our handler returns and the bridge stays alive instead
		// of forcing a full editor restart.
		const timeoutMs = Number(params.timeoutMs ?? DEFAULT_CREATE_POUR_MS);
		const created = await withTimeout(
			eda.pcb_PrimitivePour.create(
				params.net,
				normalizeLayer(params.layer),
				polygon,
				params.pourFillMethod,
				params.preserveSilos,
				params.pourName,
				params.pourPriority,
				params.lineWidth,
				params.primitiveLock,
			),
			timeoutMs,
		);
		if ((created as any)?.__timedOut) {
			throw new Error(
				`pcb.create.pour timed out after ${timeoutMs}ms — EasyEDA's fill engine is still running in the background but is unlikely to recover. Common causes: polygon extends off-board, self-intersects, or the layer has many overlapping pours fighting for priority. Inspect with pcb_zoom_to_board, fix the polygon, and retry. Pass a higher timeoutMs only if you've confirmed the fill is genuinely making progress.`,
			);
		}
		return flattenState(created);
	},

	'pcb.modify.pour': async (params) => {
		const property: Record<string, any> = { ...params.property };
		if (property.layer != null) property.layer = normalizeLayer(property.layer);

		// Accept a friendly `polygon` param (R-mode rectangle, L-mode point
		// list, or {points:[]}) and translate it into the IPCB_Polygon
		// EasyEDA wants on `complexPolygon`. Pours' shape lives in the
		// complexPolygon source array and `modify({complexPolygon})` is the
		// supported reshape path.
		if (property.polygon != null && property.complexPolygon == null) {
			const polygonSource = normalizePolygon(property.polygon);
			let poly: any = eda.pcb_MathPolygon.createPolygon(polygonSource as any);
			if (!poly) poly = eda.pcb_MathPolygon.createComplexPolygon?.(polygonSource as any);
			if (!poly) {
				throw new Error(
					`Failed to build pour polygon from input. Forms accepted: ` +
					`["L",x1,y1,x2,y2,...,x1,y1] (closed ring), ["R",cx,cy,w,h,rotation,radius], ` +
					`[{x,y},...], or {points:[{x,y},...]}.`,
				);
			}
			property.complexPolygon = poly;
			delete property.polygon;
		}

		const result = await eda.pcb_PrimitivePour.modify(params.primitiveId, property);
		const after = await eda.pcb_PrimitivePour.get(params.primitiveId).catch(() => undefined);
		const flat = after ? flattenState(after) : undefined;
		const transform = await resolveCanvasTransform();
		return {
			modified: !!result,
			after: flat,
			coordinateSpace: transform.coordinateSpace,
			summary: after ? summarizePolygonSource(readPourSource(after), transform) : undefined,
		};
	},

	// Convenience: reshape an existing pour to a rectangle (R-mode source).
	// Skips agent's need to remember the R-mode tuple format and passes
	// through pcb_MathPolygon to validate.
	'pcb.pour.setRectangle': async (params) => {
		const cx = Number(params.cx);
		const cy = Number(params.cy);
		const w = Number(params.w);
		const h = Number(params.h);
		const rotation = Number(params.rotation ?? 0);
		const cornerRadius = Number(params.cornerRadius ?? 0);
		if (![cx, cy, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
			throw new Error('cx, cy, w, h must be finite numbers and w/h must be > 0.');
		}

		const source: any[] = ['R', cx, cy, w, h, rotation, cornerRadius];
		const polygonSource = normalizePolygon(source as any);
		let poly: any = eda.pcb_MathPolygon.createPolygon(polygonSource as any);
		if (!poly) poly = eda.pcb_MathPolygon.createComplexPolygon?.(polygonSource as any);
		if (!poly) throw new Error('Failed to build R-mode polygon — pcb_MathPolygon.createPolygon returned undefined.');

		const property: Record<string, any> = { complexPolygon: poly };
		if (params.net != null) property.net = params.net;
		if (params.layer != null) property.layer = normalizeLayer(params.layer);
		if (params.pourFillMethod != null) property.pourFillMethod = params.pourFillMethod;
		if (params.preserveSilos != null) property.preserveSilos = params.preserveSilos;
		if (params.pourName != null) property.pourName = params.pourName;
		if (params.pourPriority != null) property.pourPriority = params.pourPriority;
		if (params.lineWidth != null) property.lineWidth = params.lineWidth;
		if (params.primitiveLock != null) property.primitiveLock = params.primitiveLock;

		const ok = await eda.pcb_PrimitivePour.modify(params.primitiveId, property);
		const after = await eda.pcb_PrimitivePour.get(params.primitiveId).catch(() => undefined);
		const transform = await resolveCanvasTransform();
		return {
			modified: !!ok,
			after: after ? flattenState(after) : undefined,
			coordinateSpace: transform.coordinateSpace,
			summary: after ? summarizePolygonSource(readPourSource(after), transform) : undefined,
			rectangleApplied: { cx, cy, w, h, rotation, cornerRadius },
		};
	},

	'pcb.delete.pour': async (params) => {
		// Accept either a single id or an array. Walk one at a time so we
		// can report exactly which deletions succeeded vs. were locked or
		// missing — EasyEDA's bulk delete returns a single boolean and
		// silently no-ops on locked pours, which makes diagnosing failures
		// from the agent side basically impossible.
		const ids: string[] = Array.isArray(params.ids)
			? params.ids
			: typeof params.ids === 'string'
				? [params.ids]
				: typeof params.id === 'string'
					? [params.id]
					: [];
		if (ids.length === 0) {
			throw new Error('pcb.delete.pour requires `ids` (string[]) or `id` (string).');
		}

		const force: boolean = !!params.force;
		const results: Array<{ primitiveId: string; deleted: boolean; reason?: string; wasLocked?: boolean }> = [];

		for (const id of ids) {
			let pour: any = await eda.pcb_PrimitivePour.get(id).catch(() => undefined);
			if (!pour) {
				results.push({ primitiveId: id, deleted: false, reason: 'not found' });
				continue;
			}
			let wasLocked = false;
			try {
				const lock = typeof pour.getState_PrimitiveLock === 'function'
					? !!pour.getState_PrimitiveLock()
					: !!pour.primitiveLock;
				if (lock) {
					wasLocked = true;
					if (!force) {
						results.push({ primitiveId: id, deleted: false, reason: 'locked (pass force:true to override)', wasLocked });
						continue;
					}
					// Unlock first; refetch the live instance afterward.
					await eda.pcb_PrimitivePour.modify(id, { primitiveLock: false }).catch(() => false);
				}
			} catch {/* ignore lock-read errors and just attempt the delete */}

			const ok = await eda.pcb_PrimitivePour.delete(id).catch((err: any) => {
				results.push({ primitiveId: id, deleted: false, reason: err?.message ?? String(err), wasLocked });
				return null;
			});
			if (ok === null) continue;
			results.push({ primitiveId: id, deleted: !!ok, wasLocked, reason: ok ? undefined : 'EasyEDA returned false' });
		}

		const deletedCount = results.filter((r) => r.deleted).length;
		return {
			deletedCount,
			requested: ids.length,
			results,
		};
	},

	// === Fill ===

	'pcb.getAll.fill': async (params) => {
		const all = await eda.pcb_PrimitiveFill.getAll(normalizeLayer(params.layer), params.net, params.primitiveLock);
		return envelopeStateArray(all, params);
	},

	'pcb.get.fill': async (params) => {
		const result = await eda.pcb_PrimitiveFill.get(params.primitiveIds);
		return Array.isArray(result) ? flattenStateArray(result) : flattenState(result);
	},

	'pcb.create.fill': async (params) => {
		const polygonSource = normalizePolygon(params.polygon);
		let polygon: any = eda.pcb_MathPolygon.createPolygon(polygonSource as any);
		if (!polygon) polygon = eda.pcb_MathPolygon.createComplexPolygon?.(polygonSource as any);
		if (!polygon) throw new Error(buildPolygonError('fill', params.polygon, polygonSource));

		const result = await eda.pcb_PrimitiveFill.create(
			normalizeLayer(params.layer),
			polygon,
			params.net,
			params.fillMode,
			params.lineWidth,
			params.primitiveLock,
		);
		return flattenState(result);
	},

	'pcb.modify.fill': async (params) => {
		const property = { ...params.property };
		if (property.layer != null) property.layer = normalizeLayer(property.layer);
		const result = await eda.pcb_PrimitiveFill.modify(params.primitiveId, property);
		return flattenState(result);
	},

	'pcb.delete.fill': async (params) => {
		return eda.pcb_PrimitiveFill.delete(params.ids);
	},

	// Create a copper pour bounded by the board outline (with optional inset).
	// Computes the bounding box of layer 11 (BoardOutline) Line+Arc primitives
	// and uses it as a rectangle source. Works for rectangular boards; for
	// complex shapes pass an explicit polygon to pcb_create_pour instead.
	'pcb.create.boardPour': async (params) => {
		const insetMil = Number(params?.inset_mil ?? 20);
		const layer = normalizeLayer(params.layer);
		const net: string = params.net;
		const timeoutMs = Number(params.timeoutMs ?? DEFAULT_CREATE_POUR_MS);

		// Allow callers to bypass auto-bbox detection. Helpful when EasyEDA
		// reports the BoardOutline in unexpected units, when arcs bow outward
		// of their endpoints, or when a custom keep-out shape produces a
		// misleading bbox. Pass {minX,minY,maxX,maxY} (mil) verbatim — inset
		// is still applied unless explicitInset is false.
		const explicitBBox = params?.bbox as { minX: number; minY: number; maxX: number; maxY: number } | undefined;
		if (explicitBBox && [explicitBBox.minX, explicitBBox.minY, explicitBBox.maxX, explicitBBox.maxY].every(Number.isFinite)) {
			return createBoardPourFromBBox({
				net, layer, insetMil,
				bbox: explicitBBox,
				timeoutMs,
				bboxSource: 'explicit',
				params,
			});
		}

		const lines = await eda.pcb_PrimitiveLine.getAll(undefined, 11 as any, undefined);
		const arcs = await eda.pcb_PrimitiveArc.getAll(undefined, 11 as any, undefined);

		// EasyEDA's runtime sometimes returns class instances (with getState_*
		// methods) and sometimes plain objects (with the values flattened to
		// startX/endX/start.x/end.x). Try every shape we've seen.
		const readCoord = (p: any, axis: 'X' | 'Y', end: 'Start' | 'End'): number => {
			const m = p?.[`getState_${end}${axis}`];
			if (typeof m === 'function') {
				try { const v = m.call(p); if (Number.isFinite(v)) return v; } catch {/* */}
			}
			const flat = p?.[`${end.toLowerCase()}${axis}`];
			if (Number.isFinite(flat)) return flat;
			const nested = p?.[end.toLowerCase()]?.[axis.toLowerCase()];
			if (Number.isFinite(nested)) return nested;
			return 0;
		};

		const xs: number[] = [];
		const ys: number[] = [];
		for (const l of lines || []) {
			xs.push(readCoord(l, 'X', 'Start'), readCoord(l, 'X', 'End'));
			ys.push(readCoord(l, 'Y', 'Start'), readCoord(l, 'Y', 'End'));
		}
		for (const a of arcs || []) {
			xs.push(readCoord(a, 'X', 'Start'), readCoord(a, 'X', 'End'));
			ys.push(readCoord(a, 'Y', 'Start'), readCoord(a, 'Y', 'End'));
		}

		if (xs.length === 0) {
			throw new Error('No primitives on the BoardOutline layer (id 11). Draw the outline first or pass an explicit polygon to pcb_create_pour.');
		}

		const minX = Math.min(...xs) + insetMil;
		const maxX = Math.max(...xs) - insetMil;
		const minY = Math.min(...ys) + insetMil;
		const maxY = Math.max(...ys) - insetMil;

		if (maxX <= minX || maxY <= minY) {
			throw new Error(`Inset ${insetMil} mil is larger than the board — pick a smaller value.`);
		}

		return createBoardPourFromBBox({
			net, layer, insetMil,
			bbox: { minX: minX - insetMil, minY: minY - insetMil, maxX: maxX + insetMil, maxY: maxY + insetMil },
			timeoutMs,
			bboxSource: 'autoDetected',
			params,
		});
	},

	// Create one or more pours from the actual BoardOutline geometry, similar
	// to EasyEDA's manual "Use Board Outline" flow. Unlike boardPour above,
	// this follows the closed outline loop instead of using a rectangular bbox.
	'pcb.create.boardOutlinePours': async (params) => {
		const timeoutMs = Number(params.timeoutMs ?? DEFAULT_CREATE_POUR_MS);
		const toleranceMil = Number(params.toleranceMil ?? 0.5);
		const arcStepDegrees = Number(params.arcStepDegrees ?? 10);
		const pours: Array<Record<string, any>> = Array.isArray(params.pours) && params.pours.length > 0
			? params.pours
			: [
				{ layer: 'Inner1', net: 'GND' },
				{ layer: 'Inner2', net: '+3.3V' },
				{ layer: 'TopLayer', net: 'GND' },
				{ layer: 'BottomLayer', net: 'GND' },
			];

		const outline = await buildBoardOutlinePolygon(toleranceMil, arcStepDegrees);
		const created: Array<Record<string, any>> = [];
		const failures: Array<Record<string, any>> = [];
		const deletedExisting: Array<Record<string, any>> = [];

		for (const spec of pours) {
			const layer = normalizeLayer(spec.layer);
			const net = String(spec.net);
			try {
				if (params.replaceExisting) {
					const existing = await eda.pcb_PrimitivePour.getAll(net, layer, undefined).catch(() => []);
					const ids = (existing || []).map((p: any) => {
						try { if (typeof p?.getState_PrimitiveId === 'function') return p.getState_PrimitiveId(); } catch {/* */}
						return p?.primitiveId;
					}).filter(Boolean);
					if (ids.length > 0) {
						const ok = await eda.pcb_PrimitivePour.delete(ids).catch(() => false);
						deletedExisting.push({ layer, net, ids, deleted: !!ok });
					}
				}

				const polygon = eda.pcb_MathPolygon.createPolygon(outline.polygonSource as any);
				if (!polygon) throw new Error('Failed to build polygon from BoardOutline source.');

				const createdPour = await withTimeout(
					eda.pcb_PrimitivePour.create(
						net,
						layer,
						polygon,
						spec.pourFillMethod ?? params.pourFillMethod,
						spec.preserveSilos ?? params.preserveSilos,
						spec.pourName ?? `${net}_${String(spec.layer ?? layer)}_board_outline`,
						spec.pourPriority ?? params.pourPriority,
						spec.lineWidth ?? params.lineWidth,
						spec.primitiveLock ?? params.primitiveLock,
					),
					timeoutMs,
				);
				if ((createdPour as any)?.__timedOut) {
					failures.push({ layer, net, reason: `create timed out after ${timeoutMs}ms`, timedOut: true });
					continue;
				}
				const flat = flattenState(createdPour);
				created.push({
					...flat,
					layer,
					net,
					outlineSummary: outline.summary,
				});
			} catch (err: any) {
				failures.push({ layer, net, reason: err?.message ?? String(err) });
			}
		}

		return {
			requested: pours.length,
			createdCount: created.length,
			created,
			failures,
			deletedExisting,
			outline: outline.summary,
			usedDefaultFourLayerPlan: !(Array.isArray(params.pours) && params.pours.length > 0),
			note: 'Run pcb_rebuild_all_pours after this if you want the equivalent of Shift+B.',
		};
	},

	'pcb.via.stitchPerimeter': async (params) => {
		const net = String(params.net ?? 'GND');
		const pitchMil = Number(params.pitch_mil ?? params.pitchMil ?? 200);
		const insetMil = Number(params.inset_mil ?? params.insetMil ?? 20);
		const holeDiameter = Number(params.holeDiameter ?? 12);
		const diameter = Number(params.diameter ?? 24);
		const toleranceMil = Number(params.toleranceMil ?? 0.5);
		const arcStepDegrees = Number(params.arcStepDegrees ?? 10);
		const avoidExistingWithinMil = Number(params.avoidExistingWithinMil ?? Math.max(10, pitchMil / 3));
		const maxVias = Number(params.maxVias ?? 500);
		const dryRun = !!params.dryRun;
		if (![pitchMil, insetMil, holeDiameter, diameter].every(Number.isFinite) || pitchMil <= 0 || diameter <= 0 || holeDiameter <= 0) {
			throw new Error('pitch_mil, inset_mil, holeDiameter, and diameter must be positive finite numbers.');
		}

		const outline = await buildBoardOutlinePolygon(toleranceMil, arcStepDegrees);
		const centroid = polygonCentroid(outline.points);
		const candidates = samplePolygonPerimeter(outline.points, pitchMil)
			.map((p) => moveToward(p, centroid, insetMil))
			.filter((p) => !insideAnyKeepout(p, params.keepout_regions || []));

		const existing = await eda.pcb_PrimitiveVia.getAll(net, undefined).catch(() => []);
		const existingPoints = (existing || []).map((v: any) => ({ x: readNumber(v, 'X', 'x'), y: readNumber(v, 'Y', 'y') }))
			.filter(isFinitePoint);
		const points = candidates
			.filter((p) => !existingPoints.some((e) => pointsClose(e, p, avoidExistingWithinMil)))
			.slice(0, maxVias);

		const created: any[] = [];
		const failures: Array<{ x: number; y: number; reason: string }> = [];
		if (!dryRun) {
			for (const p of points) {
				try {
					const via = await eda.pcb_PrimitiveVia.create(
						net,
						p.x,
						p.y,
						holeDiameter,
						diameter,
						normalizeViaType(params.viaType ?? 'Through'),
					);
					created.push(flattenState(via));
				} catch (err: any) {
					failures.push({ x: p.x, y: p.y, reason: err?.message ?? String(err) });
				}
			}
		}

		return {
			dryRun,
			net,
			pitch_mil: pitchMil,
			inset_mil: insetMil,
			holeDiameter,
			diameter,
			candidateCount: candidates.length,
			skippedExisting: candidates.length - points.length,
			createdCount: created.length,
			failures,
			points,
			created,
			outline: outline.summary,
			units: 'mil',
		};
	},

	'pcb.pour.repourAll': async (params) => startRepour(params),

	// Status of the current / last repour job. Served from the in-memory job
	// record (no SDK call) so it answers even while EasyEDA is wedged; pass
	// probe:true for an additional, time-bounded SDK liveness probe.
	'pcb.pour.jobStatus': async (params) => repourJobStatus(params),

	// What copper every pour ACTUALLY has, from the editor's own copper store
	// (the data a save persists). The SDK cannot see poured copper on this
	// EasyEDA build, so this is the only truthful source.
	'pcb.copper.status': async (params) => copperStatus(params),
};

async function copperStatus(params: Record<string, any>): Promise<any> {
	const documentUuid = await activeDocumentUuid();
	const resolved = await resolveNativePcbTab(documentUuid);
	if (!resolved.tab) {
		return { available: false, error: resolved.error, nativeHost: resolved.status, note: 'Copper status comes from the editor itself; nothing else on this EasyEDA build reports poured copper.' };
	}
	const copper = await readCopperSource(resolved.tab);
	if ('error' in copper) return { available: false, error: copper.error, nativeHost: resolved.status };

	const layer = params?.layer != null ? normalizeLayer(params.layer) : undefined;
	const listed = await readWithTimeout(() => eda.pcb_PrimitivePour.getAll(params?.net, layer, undefined), REPOUR_LIST_MS);
	if (didTimeOut(listed)) return { available: false, error: `pcb_PrimitivePour.getAll did not answer within ${REPOUR_LIST_MS} ms.`, nativeHost: resolved.status };
	const maxIds = Math.max(0, Number(params?.maxFillIds ?? 0));
	const pours = ((listed as any[]) || []).map((p) => {
		const pourId = repourIdOf(p);
		const c = copper.byPour.get(pourId);
		return {
			pourId,
			pourName: repourStateOf(p, 'PourName', 'pourName'),
			net: repourStateOf(p, 'Net', 'net'),
			layer: repourStateOf(p, 'Layer', 'layer'),
			priority: repourStateOf(p, 'PourPriority', 'pourPriority'),
			locked: repourStateOf(p, 'PrimitiveLock', 'primitiveLock') === true,
			hasCopper: !!c && c.islands > 0,
			islands: c?.islands ?? 0,
			style: c ? (c.solid ? 'solid' : 'grid') : undefined,
			bboxApprox: c?.bboxApprox,
			fillIds: maxIds > 0 && c ? c.fillIds.slice(0, maxIds) : undefined,
		};
	});
	const filtered = params?.net != null || layer != null;
	const known = new Set(pours.map((p) => p.pourId));
	const orphans = filtered ? [] : [...copper.byPour.keys()].filter((id) => !known.has(id));
	const empty = pours.filter((p) => !p.hasCopper).map((p) => p.pourId);
	return {
		available: true,
		source: 'editor-copper-store',
		documentUuid,
		summary: { pours: pours.length, withCopper: pours.length - empty.length, empty: empty.length, islands: pours.reduce((n, p) => n + p.islands, 0) },
		emptyPours: empty,
		pours,
		orphanCopperPours: orphans.length ? orphans : undefined,
		note: 'Copper reflects the last rebuild. Edits made since (tracks, vias, outline, rules) are only reflected after pcb_repour_all.',
	};
}

// ===========================================================================
// Repour (pcb_repour_all / pcb_rebuild_all_pours / pcb_repour_status)
// ===========================================================================
//
// Why the pre-2.1.10 loop wedged (EasyEDA Pro 2.2.47, live 2026-09-24): the
// POURED rows were byte-identical after the hung call, i.e. no rebuild was
// ever dispatched. The first thing the old per-pour routine did was
// `await pcb_PrimitivePoured.getAll()` — the full fill geometry of all ~340
// islands — with NO deadline (the 200 ms poll repeated the same untimed call
// and also registered an 'all' primitive-event listener). That await never
// returned, so the handler never settled, and ws-client's per-document lock
// (released only when the handler settled) kept every later write — native
// getSource included — queued behind it even after native_operation_reset.
//
// This implementation never awaits an EasyEDA promise without a deadline:
//   - liveness probe before any dispatch (id-only API, 3 s);
//   - pours rebuilt one at a time from a FRESH instance (`get(id)`, sync mode);
//   - the rebuild promise is observed, never awaited;
//   - completion = the id-only poured-fill list changed and then stayed stable
//     (a rebuild deletes and recreates the pour's fill islands — confirmed on
//     this board's GUI rebuilds, e1423… → e2471…), or the promise settled;
//   - at most ONE poll call in flight: a poll EasyEDA has not answered is never
//     stacked with another;
//   - if EasyEDA stops answering after a dispatch, no further pour is
//     dispatched and the call returns `status:"sdk-unresponsive"`;
//   - the synchronous call always returns before the caller's gate deadline
//     (no quarantine); `background:true` returns immediately with a job id.

const REPOUR_DEFAULT_PER_POUR_MS = 45_000;
// Below the 120 s daemon/bridge default so a plain call never trips the gate.
const REPOUR_DEFAULT_TOTAL_MS = 100_000;
const REPOUR_BACKGROUND_TOTAL_MS = 300_000;
const REPOUR_DEADLINE_MARGIN_MS = 8_000;
const REPOUR_POLL_MS = 750;
const REPOUR_SDK_CALL_MS = 4_000;
const REPOUR_PROBE_MS = 3_000;
const REPOUR_LIST_MS = 10_000;
// Consecutive identical poll results required after the first change before
// a rebuild counts as finished (fills are replaced in bulk, not atomically).
const REPOUR_SETTLE_POLLS = 2;
// Once the rebuild promise resolved, wait this long for the id change before
// accepting the promise alone as confirmation.
const REPOUR_PROMISE_GRACE_MS = 3_000;
// EasyEDA silent this long after a dispatch ⇒ stop dispatching further pours.
const REPOUR_UNRESPONSIVE_STOP_MS = 20_000;
const REPOUR_MAX_JOBS = 10;

type RepourStrategy = 'native' | 'rebuild' | 'modify';
type RepourPourStatus = 'rebuilt' | 'up-to-date' | 'empty' | 'unconfirmed' | 'unverified' | 'failed' | 'skipped-locked' | 'not-started' | 'sdk-unresponsive' | 'running';
type RepourJobStatus = 'running' | 'completed' | 'partial' | 'sdk-unresponsive' | 'deadline' | 'document-changed' | 'failed';

interface RepourPourResult {
	primitiveId: string;
	net?: string;
	layer?: unknown;
	pourName?: string;
	status: RepourPourStatus;
	confirmedBy?: 'pouredIdChange' | 'promise' | 'copperSource';
	/** Copper this pour has after the rebuild (native strategy, from the editor). */
	copper?: { islands: number; bboxApprox?: { minX: number; minY: number; maxX: number; maxY: number } };
	waitedMs?: number;
	/** State of the EasyEDA rebuild promise when this pour finished. */
	promise?: 'pending' | 'resolved' | 'rejected' | 'not-a-promise';
	promiseResult?: 'poured' | 'undefined' | 'other';
	fillIdsRemoved?: number;
	fillIdsAdded?: number;
	error?: string;
}

interface RepourJob {
	jobId: string;
	startedAt: number;
	finishedAt?: number;
	status: RepourJobStatus;
	background: boolean;
	strategy: RepourStrategy;
	/** Limited by pourIds/net/layer (native strategy rebuilds by id instead of all). */
	scoped?: boolean;
	documentUuid?: string;
	hardDeadlineAt: number;
	perPourTimeoutMs: number;
	onTimeout: 'continue' | 'abort';
	pours: RepourPourResult[];
	current?: string;
	notes: string[];
	diagnostics: Record<string, unknown>;
}

interface RepourGlobalState {
	seq: number;
	jobs: Map<string, RepourJob>;
	lastJobId?: string;
	/** Rebuild promises EasyEDA has not settled yet (diagnostic only). */
	unsettled: Map<string, { pourId: string; jobId: string; dispatchedAt: number }>;
}

// Survives a menu re-evaluation of the bundle, like the operation gate state.
const repourHost = globalThis as unknown as { __easyedaRepourStateV1?: RepourGlobalState };
const repourState: RepourGlobalState = repourHost.__easyedaRepourStateV1 ??= { seq: 0, jobs: new Map(), unsettled: new Map() };

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function positiveNumber(v: unknown): number | undefined {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function repourIdOf(p: any): string {
	try {
		const v = typeof p?.getState_PrimitiveId === 'function' ? p.getState_PrimitiveId() : undefined;
		if (v) return String(v);
	} catch {/* */}
	return String(p?.primitiveId ?? p?.id ?? 'unknown');
}

function repourStateOf(p: any, state: string, flat: string): any {
	try {
		const getter = p?.[`getState_${state}`];
		if (typeof getter === 'function') return getter.call(p);
	} catch {/* */}
	return p?.[flat];
}

/** Time-bounded liveness probe using the cheapest pour API (ids only). */
async function probeEasyEdaSdk(ms = REPOUR_PROBE_MS): Promise<{ responsive: boolean; ms: number; error?: string }> {
	const t0 = Date.now();
	try {
		const out = await readWithTimeout(() => eda.pcb_PrimitivePour.getAllPrimitiveId(), ms);
		if (didTimeOut(out)) return { responsive: false, ms: Date.now() - t0 };
		return { responsive: true, ms: Date.now() - t0 };
	} catch (err: any) {
		// A rejection is still an answer: the SDK is alive.
		return { responsive: true, ms: Date.now() - t0, error: err?.message ?? String(err) };
	}
}

/**
 * Polls the id-only poured-fill list. Never has more than one call in flight:
 * while EasyEDA has not answered the previous call, poll() reports a miss
 * instead of stacking another request onto a busy host.
 */
function createPouredIdPoller() {
	const api = (eda as any)?.pcb_PrimitivePoured;
	let available = !!api && typeof api.getAllPrimitiveId === 'function';
	let inflight: Promise<unknown> | undefined;
	const state = {
		get available() { return available; },
		disabledReason: available ? undefined as string | undefined : 'pcb_PrimitivePoured.getAllPrimitiveId not available',
		lastOkAt: Date.now(),
		misses: 0,
		ids: undefined as Set<string> | undefined,
		lastError: undefined as string | undefined,
	};
	async function poll(): Promise<Set<string> | undefined> {
		if (!available) return undefined;
		if (inflight) { state.misses += 1; return undefined; }
		const call = Promise.resolve().then(() => api.getAllPrimitiveId());
		inflight = call;
		void call.then(() => undefined, () => undefined).then(() => { if (inflight === call) inflight = undefined; });
		let out: any;
		try {
			out = await readWithTimeout(() => call, REPOUR_SDK_CALL_MS);
		} catch (err: any) {
			state.lastError = err?.message ?? String(err);
			state.lastOkAt = Date.now();
			state.misses = 0;
			return undefined;
		}
		if (didTimeOut(out)) { state.misses += 1; return undefined; }
		state.lastOkAt = Date.now();
		state.misses = 0;
		const ids = new Set<string>(Array.isArray(out) ? out.map((v: any) => String(v)) : []);
		state.ids = ids;
		return ids;
	}
	/** Stop using the poured-fill API (e.g. it hangs on this build while the rest of the SDK answers). */
	function disable(reason: string): void {
		available = false;
		state.disabledReason = reason;
	}
	return { state, poll, disable, inflight: () => !!inflight };
}

function setDiff(a: Set<string>, b: Set<string>): { removed: number; added: number } {
	let removed = 0;
	let added = 0;
	for (const id of a) if (!b.has(id)) removed += 1;
	for (const id of b) if (!a.has(id)) added += 1;
	return { removed, added };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const id of a) if (!b.has(id)) return false;
	return true;
}

async function activeDocumentUuid(): Promise<string | undefined> {
	try {
		const doc = await readWithTimeout(() => eda.dmt_SelectControl.getCurrentDocumentInfo(), REPOUR_PROBE_MS);
		if (didTimeOut(doc)) return undefined;
		return (doc as any)?.uuid ? String((doc as any).uuid) : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Native strategy — the editor's own copper engine (exactly what Shift+B runs)
// ---------------------------------------------------------------------------
// The public SDK cannot rebuild copper on EasyEDA Pro 2.2.47: rebuildCopperRegion()
// never settles and fills nothing, and modify() edits the pour without refilling
// (live check 2026-10-05: board left with zero poured copper). EasyEDA's own UI
// rebuilds by publishing into the active PCB tab's frame through the top-window
// message bridge (ui.js, suture-via dialog):
//   UI.gVars.windowBridge.publish('rebuildCopper', '', tabFrame.contentWindow)
//   UI.gVars.windowBridge.publish('rebuildPlane',  '', tabFrame.contentWindow)
// — the same two events as Shift+B ("Rebuild All Copper Area"), or
// 'rebuildSingleCopper' {ids, isLast:false} for specific pours. The editor
// announces the start with 'pcbUpdateProgress' {descripte:'copper'} and, once
// buildCopper() has written the fills, publishes 'setPcbTabUnSaved' [tabId, true];
// both reach UI.gVars.messageBus. Nothing is awaited on the editor, and the
// result is one normal, undoable "rebuild copper" history step.

const REPOUR_NATIVE_START_MS = 8_000;
const REPOUR_NATIVE_POLL_MS = 250;

async function runNativeRepour(job: RepourJob, pours: any[]): Promise<void> {
	const shiftB = 'GUI fallback: Shift+B (Rebuild All Copper Area) in EasyEDA.';
	const fail = (why: string, status: RepourJobStatus = 'failed') => {
		for (const e of job.pours) if (e.status === 'not-started' || e.status === 'running') { e.status = 'failed'; e.error = why; }
		job.notes.push(`${why} ${shiftB}`);
		finishJob(job, status);
	};

	// Locked pours keep their copper: rebuild only the unlocked ones by id.
	job.pours.forEach((entry, i) => {
		if (repourStateOf(pours[i], 'PrimitiveLock', 'primitiveLock') === true) entry.status = 'skipped-locked';
	});
	const todo = job.pours.filter((e) => e.status === 'not-started');
	if (todo.length === 0) {
		job.notes.push(job.pours.length ? 'Every matching pour is locked; nothing to rebuild.' : 'No pours on this document; nothing to rebuild.');
		finishJob(job, 'completed');
		return;
	}
	const scoped = job.scoped || todo.length < job.pours.length;

	const resolved = await resolveNativePcbTab(job.documentUuid);
	job.diagnostics.nativeHost = resolved.status;
	if (!resolved.tab) {
		fail(`${resolved.error} Nothing was dispatched.`, /not the requested document/.test(resolved.error ?? '') ? 'document-changed' : 'failed');
		return;
	}
	const tab = resolved.tab;
	const before = await readCopperSource(tab);
	if ('error' in before) job.notes.push(`Copper before the rebuild could not be read (${before.error}); per-pour results compare against nothing.`);
	job.diagnostics.copperBefore = 'error' in before ? { error: before.error } : { islands: before.records, poursWithCopper: before.byPour.size };

	let started: number | undefined;
	let finished: number | undefined;
	const subs: Array<{ cancel?: () => void } | undefined> = [];
	const dispatchedAt = Date.now();
	try {
		// Listen BEFORE publishing so a fast rebuild cannot be missed.
		subs.push(tab.host.messageBus.subscribe('pcbUpdateProgress', (m: any) => {
			if (!started && m?.descripte === 'copper') started = Date.now();
		}));
		subs.push(tab.host.messageBus.subscribe('setPcbTabUnSaved', (m: any) => {
			const id = Array.isArray(m) ? m[0] : undefined;
			// Fires on every edit: only count it for our tab, after our rebuild started.
			if (started && !finished && (id == null || canonicalDocumentId(String(id)) === canonicalDocumentId(tab.tabId))) finished = Date.now();
		}));

		for (const e of todo) e.status = 'running';
		if (scoped) {
			tab.host.windowBridge.publish('rebuildSingleCopper', { ids: todo.map((e) => e.primitiveId), isLast: false }, tab.target);
		} else {
			tab.host.windowBridge.publish('rebuildCopper', '', tab.target);
			tab.host.windowBridge.publish('rebuildPlane', '', tab.target);
		}
		job.diagnostics.nativeDispatch = { mode: scoped ? 'rebuildSingleCopper' : 'rebuildCopper+rebuildPlane', tabId: tab.tabId, pourIds: scoped ? todo.map((e) => e.primitiveId) : 'all' };

		for (;;) {
			await sleep(REPOUR_NATIVE_POLL_MS);
			const now = Date.now();
			if (finished) break;
			if (!started && now - dispatchedAt >= REPOUR_NATIVE_START_MS) break;
			if (now >= job.hardDeadlineAt - 1_000) break;
		}
	} finally {
		for (const sub of subs) { try { sub?.cancel?.(); } catch {/* */} }
	}

	const waitedMs = Date.now() - dispatchedAt;
	job.diagnostics.nativeEvents = { startedAfterMs: started ? started - dispatchedAt : undefined, finishedAfterMs: finished ? finished - dispatchedAt : undefined };
	for (const e of todo) e.waitedMs = waitedMs;
	if (!finished) {
		for (const e of todo) {
			if (started) {
				e.status = 'unconfirmed';
				e.error = `the editor started the copper rebuild but had not finished after ${Math.round(waitedMs / 1000)} s`;
			} else {
				e.status = 'failed';
				e.error = 'the editor did not acknowledge the rebuild request (PCB editor not active, or a rebuild was already running)';
			}
		}
		if (started) {
			job.notes.push('The copper worker is still running. Large boards: re-run with background:true and poll pcb_repour_status, then check pcb_copper_status before saving.');
			finishJob(job, 'deadline');
		} else {
			job.notes.push(`No rebuild started: make sure the PCB tab is active and no copper rebuild is already running, then retry. ${shiftB}`);
			finishJob(job, 'failed');
		}
		return;
	}

	// The editor says it is done — now read what is actually on the board.
	const after = await readCopperSource(tab);
	if ('error' in after) {
		for (const e of todo) {
			e.status = 'unverified';
			e.error = `the editor finished the rebuild but its copper could not be read back (${after.error})`;
		}
		job.notes.push('Do not assume copper exists: re-check with pcb_copper_status.');
		finishJob(job, 'partial');
		return;
	}
	const empty: string[] = [];
	for (const e of todo) {
		const now = after.byPour.get(e.primitiveId);
		const prior = 'error' in before ? undefined : before.byPour.get(e.primitiveId);
		e.copper = { islands: now?.islands ?? 0, bboxApprox: now?.bboxApprox };
		if (!now || now.islands === 0) {
			e.status = 'empty';
			e.error = 'the editor rebuilt this pour but it has NO copper (outline off the board, fully blocked by clearances/keepouts, or every island removed as unconnected)';
			empty.push(e.primitiveId);
			continue;
		}
		e.confirmedBy = 'copperSource';
		if (prior) {
			const diff = setDiff(new Set(prior.fillIds), new Set(now.fillIds));
			e.fillIdsRemoved = diff.removed;
			e.fillIdsAdded = diff.added;
			e.status = diff.added > 0 || diff.removed > 0 ? 'rebuilt' : 'up-to-date';
		} else {
			e.status = 'rebuilt';
		}
	}
	job.diagnostics.copperAfter = { islands: after.records, poursWithCopper: after.byPour.size };
	if (empty.length) {
		job.notes.push(`${empty.length} pour(s) have no copper after the rebuild: ${empty.join(', ')}. Inspect their outline, net and clearance (pcb_pour_inspect).`);
	}
	if (todo.some((e) => e.status === 'up-to-date')) {
		job.notes.push('"up-to-date" = the copper engine kept identical islands (nothing it depends on changed).');
	}
	job.notes.push(
		'Rebuilt by EasyEDA\'s own copper engine (same as Shift+B): one undoable "rebuild copper" history step; the tab is marked unsaved. ' +
		'Copper is confirmed from the editor\'s copper store. If it is not visible, enable "Copper Region(Filled)" in Right Panel → Filter → Display.',
	);
	finishJob(job, job.pours.every((p) => p.status === 'rebuilt' || p.status === 'up-to-date' || p.status === 'skipped-locked') ? 'completed' : 'partial');
}

function summarizeRepourJob(job: RepourJob): Record<string, unknown> {
	const count = (s: RepourPourStatus) => job.pours.filter((p) => p.status === s).length;
	const confirmedBy = { pouredIdChange: 0, promise: 0, copperSource: 0 };
	for (const p of job.pours) if ((p.status === 'rebuilt' || p.status === 'up-to-date') && p.confirmedBy) confirmedBy[p.confirmedBy] += 1;
	const failures = job.pours
		.filter((p) => p.status === 'failed' || p.status === 'empty' || p.status === 'unconfirmed' || p.status === 'unverified' || p.status === 'sdk-unresponsive')
		.map((p) => ({ primitiveId: p.primitiveId, reason: p.error ?? p.status, timedOut: p.status !== 'failed' }));
	const now = Date.now();
	return {
		jobId: job.jobId,
		status: job.status,
		background: job.background,
		strategy: job.strategy,
		documentUuid: job.documentUuid,
		pourCount: job.pours.length,
		rebuilt: count('rebuilt'),
		upToDate: count('up-to-date'),
		empty: count('empty'),
		unconfirmed: count('unconfirmed'),
		unverified: count('unverified'),
		failed: count('failed'),
		skippedLocked: count('skipped-locked'),
		notStarted: count('not-started'),
		sdkUnresponsive: job.status === 'sdk-unresponsive',
		// Backward-compatible aliases of the pre-2.1.10 response.
		timedOut: count('unconfirmed') + count('sdk-unresponsive'),
		aborted: job.status !== 'completed' && job.status !== 'running',
		failures,
		confirmedBy,
		current: job.current,
		elapsedMs: (job.finishedAt ?? now) - job.startedAt,
		perPourTimeoutMs: job.perPourTimeoutMs,
		deadlineInMs: Math.max(0, job.hardDeadlineAt - now),
		onTimeout: job.onTimeout,
		unsettledRebuildPromises: [...repourState.unsettled.values()].map((u) => ({ ...u, ageMs: now - u.dispatchedAt })),
		results: job.pours,
		notes: job.notes,
		diagnostics: job.diagnostics,
		mode: 'dispatch-and-verify-v2',
	};
}

function finishJob(job: RepourJob, status: RepourJobStatus): void {
	job.status = status;
	job.finishedAt = Date.now();
	job.current = undefined;
	for (const p of job.pours) if (p.status === 'running') p.status = 'unconfirmed';
}

function registerJob(job: RepourJob): void {
	repourState.jobs.set(job.jobId, job);
	repourState.lastJobId = job.jobId;
	while (repourState.jobs.size > REPOUR_MAX_JOBS) {
		const oldest = repourState.jobs.keys().next().value;
		if (oldest === undefined || oldest === job.jobId) break;
		repourState.jobs.delete(oldest);
	}
}

async function startRepour(params: Record<string, any>): Promise<any> {
	const background = params?.background === true;
	// native (default) drives the editor's own copper engine; rebuild/modify are
	// the SDK paths that do not fill copper on EasyEDA Pro 2.2.47 (kept for
	// other builds and diagnosis).
	const strategy: RepourStrategy = params?.strategy === 'modify' ? 'modify' : params?.strategy === 'rebuild' ? 'rebuild' : 'native';
	const onTimeout: 'continue' | 'abort' = params?.onTimeout === 'abort' ? 'abort' : 'continue';

	const running = repourState.lastJobId ? repourState.jobs.get(repourState.lastJobId) : undefined;
	if (running && running.status === 'running' && Date.now() > running.hardDeadlineAt + 30_000) {
		// A job past its own deadline is dead (crash, bundle re-evaluation) —
		// never let a stale record lock repour out for the rest of the session.
		running.notes.push('Marked failed: still "running" 30 s past its deadline (stale job record).');
		finishJob(running, 'failed');
	}
	if (running && running.status === 'running') {
		throw new Error(
			`Repour job ${running.jobId} is still running (${Math.round((Date.now() - running.startedAt) / 1000)} s). ` +
			'Poll pcb_repour_status instead of starting another; a second rebuild stacked on a busy EasyEDA is what wedges it.',
		);
	}

	const startedAt = Date.now();
	const callBudgetMs = positiveNumber(params?._timeoutMs);
	const gateDeadlineAt = positiveNumber(params?._gateDeadlineAt);
	const totalMs = positiveNumber(params?.totalTimeoutMs)
		?? (background ? REPOUR_BACKGROUND_TOTAL_MS : (callBudgetMs ? callBudgetMs - REPOUR_DEADLINE_MARGIN_MS : REPOUR_DEFAULT_TOTAL_MS));
	let hardDeadlineAt = startedAt + Math.max(5_000, totalMs);
	if (!background) {
		// The synchronous call must hand the gate back before its watchdog fires.
		const gateLimit = gateDeadlineAt
			? gateDeadlineAt - REPOUR_DEADLINE_MARGIN_MS
			: startedAt + (callBudgetMs ?? 120_000) - REPOUR_DEADLINE_MARGIN_MS;
		hardDeadlineAt = Math.min(hardDeadlineAt, gateLimit);
	}
	const perPourTimeoutMs = positiveNumber(params?.perPourTimeoutMs) ?? REPOUR_DEFAULT_PER_POUR_MS;

	const job: RepourJob = {
		jobId: `repour-${++repourState.seq}-${startedAt}`,
		startedAt,
		status: 'running',
		background,
		strategy,
		hardDeadlineAt,
		perPourTimeoutMs,
		onTimeout,
		pours: [],
		notes: [],
		diagnostics: {},
		scoped: (Array.isArray(params?.pourIds) && params.pourIds.length > 0) || params?.net != null || params?.layer != null,
	};

	// 1. Is EasyEDA answering at all? Never dispatch into a wedged host.
	const probe = await probeEasyEdaSdk();
	job.diagnostics.probe = probe;
	if (!probe.responsive) {
		finishJob(job, 'sdk-unresponsive');
		job.notes.push(
			`EasyEDA did not answer a ${REPOUR_PROBE_MS} ms liveness probe, so no rebuild was dispatched. ` +
			'Check for an open dialog/placement mode (press Esc), then retry; if every call keeps timing out, restart EasyEDA. ' +
			'GUI fallback: Shift+B (Rebuild All Copper) then save.',
		);
		registerJob(job);
		return summarizeRepourJob(job);
	}
	job.documentUuid = await activeDocumentUuid();

	// 2. Enumerate pours (bounded).
	const layer = params?.layer != null ? normalizeLayer(params.layer) : undefined;
	const listed = await readWithTimeout(() => eda.pcb_PrimitivePour.getAll(params?.net, layer, undefined), REPOUR_LIST_MS)
		.catch((err: any) => { throw new Error(`pcb_PrimitivePour.getAll failed: ${err?.message ?? err}`); });
	if (didTimeOut(listed)) {
		finishJob(job, 'sdk-unresponsive');
		job.notes.push(`pcb_PrimitivePour.getAll did not answer within ${REPOUR_LIST_MS} ms; nothing was dispatched.`);
		registerJob(job);
		return summarizeRepourJob(job);
	}
	const wanted = Array.isArray(params?.pourIds) && params.pourIds.length > 0
		? new Set<string>(params.pourIds.map((v: any) => String(v)))
		: undefined;
	const pours = ((listed as any[]) || []).filter((p) => !wanted || wanted.has(repourIdOf(p)));
	if (wanted) {
		const found = new Set(pours.map(repourIdOf));
		for (const id of wanted) if (!found.has(id)) job.notes.push(`pourIds: ${id} is not a pour on this document (net/layer filters also apply).`);
	}
	job.pours = pours.map((p) => ({
		primitiveId: repourIdOf(p),
		net: repourStateOf(p, 'Net', 'net'),
		layer: repourStateOf(p, 'Layer', 'layer'),
		pourName: repourStateOf(p, 'PourName', 'pourName'),
		status: 'not-started' as RepourPourStatus,
	}));
	registerJob(job);

	if (background) {
		void runRepourJob(job, pours).catch((err: any) => {
			job.notes.push(`Background job crashed: ${err?.message ?? String(err)}`);
			finishJob(job, 'failed');
		});
		return {
			...summarizeRepourJob(job),
			note: 'Running in the background; the bridge queue is already released. Poll pcb_repour_status {jobId} until status != "running". ' +
				'Other edits made while it runs interleave with the rebuild — avoid pour/track edits until it finishes.',
		};
	}

	try {
		await runRepourJob(job, pours);
	} catch (err: any) {
		job.notes.push(`Repour loop failed: ${err?.message ?? String(err)}`);
		finishJob(job, 'failed');
	}
	return summarizeRepourJob(job);
}

async function runRepourJob(job: RepourJob, pours: any[]): Promise<void> {
	if (job.strategy === 'native') return runNativeRepour(job, pours);
	const poller = createPouredIdPoller();
	let baseline = await poller.poll();
	if (!baseline && poller.state.available) {
		// The liveness probe just succeeded, so a poured-id call that does not
		// answer BEFORE any dispatch means that API itself hangs on this build.
		// Don't use it (it would make every pour look like a wedge); fall back
		// to the rebuild promise + liveness probes.
		poller.disable('pcb_PrimitivePoured.getAllPrimitiveId did not answer before any dispatch');
		job.notes.push('Poured-fill id API did not answer on this EasyEDA build; completion falls back to the rebuild promise, liveness to probes.');
	}
	job.diagnostics.pouredIdApi = poller.state.available ? 'ok' : poller.state.disabledReason;
	job.diagnostics.initialPouredFillCount = baseline?.size;

	for (let i = 0; i < pours.length; i += 1) {
		const entry = job.pours[i];
		const pour = pours[i];
		const remaining = job.hardDeadlineAt - Date.now();
		if (remaining < 3_000) {
			job.notes.push(`Deadline reached before ${entry.primitiveId}; remaining pours not started. Re-run with pourIds for the rest, or use background:true.`);
			finishJob(job, 'deadline');
			return;
		}
		if (job.documentUuid) {
			const active = await activeDocumentUuid();
			if (active && active !== job.documentUuid) {
				job.notes.push(`Active document changed to ${active}; stopped before ${entry.primitiveId}.`);
				finishJob(job, 'document-changed');
				return;
			}
		}
		if (repourStateOf(pour, 'PrimitiveLock', 'primitiveLock') === true) {
			entry.status = 'skipped-locked';
			continue;
		}

		job.current = entry.primitiveId;
		entry.status = 'running';
		const budget = Math.min(job.perPourTimeoutMs, remaining - 1_000);
		const outcome = await rebuildOnePour(job, entry, pour, poller, baseline, budget);
		if (poller.state.ids) baseline = poller.state.ids;

		if (outcome === 'sdk-unresponsive') {
			job.notes.push(
				`EasyEDA stopped answering after the rebuild of ${entry.primitiveId} was dispatched; no further pours were dispatched. ` +
				'Wait and poll pcb_repour_status {probe:true}; if EasyEDA never answers again, save from the GUI and restart it. ' +
				'The bridge queue and document lock are released either way.',
			);
			finishJob(job, 'sdk-unresponsive');
			return;
		}
		if ((entry.status as RepourPourStatus) === 'unconfirmed' && job.onTimeout === 'abort') {
			job.notes.push(`onTimeout=abort: stopped after unconfirmed rebuild of ${entry.primitiveId}.`);
			finishJob(job, 'partial');
			return;
		}
	}

	const allDone = job.pours.every((p) => p.status === 'rebuilt' || p.status === 'skipped-locked');
	finishJob(job, allDone ? 'completed' : 'partial');
	if (job.pours.some((p) => p.status === 'unverified')) {
		job.notes.push(
			'unverified = EasyEDA accepted the pour edit but the refill cannot be observed on this build. Do not assume copper exists: ' +
			'check pcb_drc_summarize (GND "disconnected" errors drop when pours really fill) or look at the board; Shift+B in EasyEDA rebuilds all copper.',
		);
	}
	if (job.pours.some((p) => p.status === 'unconfirmed')) {
		job.notes.push(
			'unconfirmed = EasyEDA kept answering but neither the poured-fill ids changed nor the rebuild promise settled within the budget. ' +
			'On this EasyEDA build the rebuild API may be a no-op; try strategy:"modify" on one pour, or use the GUI (Shift+B).',
		);
	}
}

/** Returns 'sdk-unresponsive' when EasyEDA went silent; otherwise fills `entry`. */
async function rebuildOnePour(
	job: RepourJob,
	entry: RepourPourResult,
	listedInstance: any,
	poller: ReturnType<typeof createPouredIdPoller>,
	baselineIn: Set<string> | undefined,
	budgetMs: number,
): Promise<'ok' | 'sdk-unresponsive'> {
	const startedAt = Date.now();
	const pourId = entry.primitiveId;

	// Fresh, synchronous instance — a getAll() snapshot may be stale or async.
	let target: any = listedInstance;
	try {
		const fresh = await readWithTimeout(() => eda.pcb_PrimitivePour.get(pourId), REPOUR_SDK_CALL_MS);
		if (didTimeOut(fresh)) {
			entry.status = 'sdk-unresponsive';
			entry.error = `pcb_PrimitivePour.get(${pourId}) did not answer within ${REPOUR_SDK_CALL_MS} ms; not dispatched.`;
			entry.waitedMs = Date.now() - startedAt;
			return 'sdk-unresponsive';
		}
		if (fresh) target = fresh;
	} catch {/* fall back to the listed instance */}
	try {
		if (typeof target?.isAsync === 'function' && target.isAsync() && typeof target.toSync === 'function') {
			target = target.toSync() ?? target;
		}
	} catch {/* */}

	let baseline = baselineIn ?? await poller.poll();

	// Dispatch — observed, never awaited.
	let settled: 'resolved' | 'rejected' | undefined;
	let settledValue: unknown;
	let settledError: string | undefined;
	let settledAt: number | undefined;
	try {
		let dispatched: any;
		if (job.strategy === 'modify') {
			// "Touch": re-apply the pour's own name through the edit path, which
			// the editor follows with its normal refill.
			const name = repourStateOf(target, 'PourName', 'pourName');
			dispatched = eda.pcb_PrimitivePour.modify(pourId, { pourName: typeof name === 'string' ? name : String(name ?? '') } as any);
		} else {
			if (typeof target?.rebuildCopperRegion !== 'function') {
				entry.status = 'failed';
				entry.error = 'rebuildCopperRegion is not available on this pour instance (EasyEDA build without the alpha API).';
				return 'ok';
			}
			dispatched = target.rebuildCopperRegion();
		}
		if (dispatched && typeof dispatched.then === 'function') {
			const key = `${job.jobId}:${pourId}`;
			repourState.unsettled.set(key, { pourId, jobId: job.jobId, dispatchedAt: Date.now() });
			(dispatched as Promise<unknown>).then(
				(value) => { settled = 'resolved'; settledValue = value; settledAt = Date.now(); repourState.unsettled.delete(key); },
				(err: any) => { settled = 'rejected'; settledError = err?.message ?? String(err); settledAt = Date.now(); repourState.unsettled.delete(key); },
			);
		} else {
			settled = 'resolved';
			settledValue = dispatched;
			settledAt = Date.now();
		}
	} catch (err: any) {
		entry.status = 'failed';
		entry.error = err?.message ?? String(err);
		entry.waitedMs = Date.now() - startedAt;
		return 'ok';
	}

	const promiseState = (): RepourPourResult['promise'] => settled ?? 'pending';
	const promiseResult = (): RepourPourResult['promiseResult'] => {
		if (settled !== 'resolved') return undefined;
		if (settledValue == null) return 'undefined';
		return typeof (settledValue as any)?.getState_PrimitiveId === 'function' ? 'poured' : 'other';
	};

	let changedAt: number | undefined;
	let lastIds: Set<string> | undefined;
	let stablePolls = 0;
	for (;;) {
		await sleep(REPOUR_POLL_MS);
		const now = Date.now();
		entry.waitedMs = now - startedAt;
		entry.promise = promiseState();
		entry.promiseResult = promiseResult();

		if (settled === 'rejected') {
			entry.status = 'failed';
			entry.error = `rebuild rejected: ${settledError ?? 'unknown error'}`;
			return 'ok';
		}

		const ids = await poller.poll();
		if (ids && !baseline) baseline = ids;
		if (ids && baseline && !sameSet(baseline, ids)) {
			if (!changedAt) {
				changedAt = now;
				stablePolls = 0;
			} else if (lastIds && sameSet(lastIds, ids)) {
				stablePolls += 1;
			} else {
				stablePolls = 0;
			}
			lastIds = ids;
			if (stablePolls >= REPOUR_SETTLE_POLLS || (settled === 'resolved' && stablePolls >= 1)) {
				const diff = setDiff(baseline, ids);
				entry.status = 'rebuilt';
				entry.confirmedBy = 'pouredIdChange';
				entry.fillIdsRemoved = diff.removed;
				entry.fillIdsAdded = diff.added;
				return 'ok';
			}
		}

		if (settled === 'resolved' && !changedAt && settledAt !== undefined && now - settledAt >= REPOUR_PROMISE_GRACE_MS) {
			if (job.strategy === 'rebuild') {
				// rebuildCopperRegion() settling is the SDK reporting the rebuild
				// itself; fill ids unchanged means rebuilt in place (or voided).
				entry.status = 'rebuilt';
				entry.confirmedBy = 'promise';
				return 'ok';
			}
			// modify() settling only proves the property edit was accepted, not
			// that copper was refilled. Live check 2026-10-05: every "completed"
			// modify run left the board with no poured copper at all. Only a
			// fill-id change counts; without the poured-id API, say so.
			if (!poller.state.available) {
				entry.status = 'unverified';
				entry.error = 'pour edit accepted, but this EasyEDA build gives no way to observe the refill (poured-fill id API not answering)';
				return 'ok';
			}
		}

		const silentMs = now - poller.state.lastOkAt;
		if (poller.state.available && poller.state.misses > 0 && silentMs >= REPOUR_UNRESPONSIVE_STOP_MS) {
			entry.status = 'sdk-unresponsive';
			entry.error = `EasyEDA answered no SDK call for ${silentMs} ms after the rebuild was dispatched.`;
			return 'sdk-unresponsive';
		}

		if (now - startedAt >= budgetMs) {
			if (changedAt && lastIds && baseline) {
				// Changed but still churning at the deadline — count it, flagged.
				const diff = setDiff(baseline, lastIds);
				entry.status = 'rebuilt';
				entry.confirmedBy = 'pouredIdChange';
				entry.fillIdsRemoved = diff.removed;
				entry.fillIdsAdded = diff.added;
				entry.error = 'fill ids were still changing at the per-pour deadline';
				return 'ok';
			}
			if (poller.state.available && poller.state.misses > 0) {
				entry.status = 'sdk-unresponsive';
				entry.error = `EasyEDA was not answering at the per-pour deadline (${budgetMs} ms).`;
				return 'sdk-unresponsive';
			}
			if (!poller.state.available) {
				// No poll-based liveness signal: ask directly before moving on.
				const probe = await probeEasyEdaSdk();
				if (!probe.responsive) {
					entry.status = 'sdk-unresponsive';
					entry.error = `EasyEDA did not answer a liveness probe at the per-pour deadline (${budgetMs} ms).`;
					return 'sdk-unresponsive';
				}
			}
			entry.status = 'unconfirmed';
			entry.error = `no poured-fill change and no settled promise within ${budgetMs} ms (EasyEDA kept answering)`;
			return 'ok';
		}
	}
}

async function repourJobStatus(params: Record<string, any>): Promise<any> {
	const jobId = params?.jobId ? String(params.jobId) : repourState.lastJobId;
	const job = jobId ? repourState.jobs.get(jobId) : undefined;
	const probe = params?.probe === true ? await probeEasyEdaSdk() : undefined;
	if (!job) {
		return {
			status: 'no-job',
			jobId: jobId ?? null,
			knownJobs: [...repourState.jobs.keys()],
			probe,
			nativeHost: nativeHostStatus(),
			unsettledRebuildPromises: [...repourState.unsettled.values()],
		};
	}
	return { ...summarizeRepourJob(job), probe, nativeHost: nativeHostStatus() };
}

// Shared body for boardPour creation — shapes a rectangle from a board-outline
// bbox, applies inset, races the EasyEDA create call against a deadline, and
// returns a uniform response (same fields whether the bbox came from auto-
// detection or the explicit override path).
async function createBoardPourFromBBox(args: {
	net: string;
	layer: any;
	insetMil: number;
	bbox: { minX: number; minY: number; maxX: number; maxY: number };
	timeoutMs: number;
	bboxSource: 'autoDetected' | 'explicit';
	params: Record<string, any>;
}): Promise<any> {
	const { net, layer, insetMil, bbox, timeoutMs, bboxSource, params } = args;
	const minX = bbox.minX + insetMil;
	const maxX = bbox.maxX - insetMil;
	const minY = bbox.minY + insetMil;
	const maxY = bbox.maxY - insetMil;
	if (maxX <= minX || maxY <= minY) {
		throw new Error(`Inset ${insetMil} mil leaves no area inside bbox ${JSON.stringify(bbox)} — pick a smaller inset or pass an explicit bbox.`);
	}

	const polygonSource: any = normalizePolygon({
		points: [
			{ x: minX, y: minY },
			{ x: maxX, y: minY },
			{ x: maxX, y: maxY },
			{ x: minX, y: maxY },
		],
	});
	const polygon = eda.pcb_MathPolygon.createPolygon(polygonSource);
	if (!polygon) throw new Error('Failed to build polygon from board outline bbox.');

	const created = await withTimeout(
		eda.pcb_PrimitivePour.create(
			net,
			layer,
			polygon,
			params.pourFillMethod,
			params.preserveSilos,
			params.pourName ?? `${net}_${typeof params.layer === 'string' ? params.layer : layer}`,
			params.pourPriority,
			params.lineWidth,
			params.primitiveLock,
		),
		timeoutMs,
	);
	if ((created as any)?.__timedOut) {
		throw new Error(
			`pcb.create.boardPour timed out after ${timeoutMs}ms creating a ${(maxX - minX).toFixed(0)}×${(maxY - minY).toFixed(0)} mil pour on ${typeof params.layer === 'string' ? params.layer : layer}. Common causes: bbox is wrong (try the explicit \`bbox\` override), inset too small relative to component count, or a colliding higher-priority pour. Run pcb_zoom_to_board_outline to verify the active board geometry.`,
		);
	}

	return {
		...flattenState(created),
		boardBBox: bbox,
		pourBBox: { minX, maxX, minY, maxY },
		inset_mil: insetMil,
		bboxSource,
	};
}

type Point = { x: number; y: number };
type OutlineSegment = { start: Point; end: Point; arcAngle?: number };

async function buildBoardOutlinePolygon(toleranceMil: number, arcStepDegrees: number): Promise<{
	polygonSource: Array<string | number>;
	points: Point[];
	summary: Record<string, any>;
}> {
	const lines = await eda.pcb_PrimitiveLine.getAll(undefined, 11 as any, undefined);
	const arcs = await eda.pcb_PrimitiveArc.getAll(undefined, 11 as any, undefined);
	const polylines = await eda.pcb_PrimitivePolyline.getAll(undefined, 11 as any, undefined).catch(() => []);
	const segments: OutlineSegment[] = [];
	const polylineLoops: Array<{ points: Point[]; area: number; segmentCount: number }> = [];

	for (const polyline of polylines || []) {
		const source = readPolylineSource(polyline);
		const points = sourceToPoints(source);
		const deduped = dedupeConsecutivePoints(points, toleranceMil);
		if (deduped.length >= 4 && pointsClose(deduped[0], deduped[deduped.length - 1], toleranceMil)) {
			deduped[deduped.length - 1] = { ...deduped[0] };
			polylineLoops.push({ points: deduped, area: polygonArea(deduped), segmentCount: Math.max(0, deduped.length - 1) });
		}
	}

	for (const line of lines || []) {
		const start = { x: readNumber(line, 'StartX', 'startX'), y: readNumber(line, 'StartY', 'startY') };
		const end = { x: readNumber(line, 'EndX', 'endX'), y: readNumber(line, 'EndY', 'endY') };
		if (isFinitePoint(start) && isFinitePoint(end) && !pointsClose(start, end, toleranceMil)) {
			segments.push({ start, end });
		}
	}
	for (const arc of arcs || []) {
		const start = { x: readNumber(arc, 'StartX', 'startX'), y: readNumber(arc, 'StartY', 'startY') };
		const end = { x: readNumber(arc, 'EndX', 'endX'), y: readNumber(arc, 'EndY', 'endY') };
		const arcAngle = readNumber(arc, 'ArcAngle', 'arcAngle');
		if (isFinitePoint(start) && isFinitePoint(end) && Number.isFinite(arcAngle) && !pointsClose(start, end, toleranceMil)) {
			segments.push({ start, end, arcAngle });
		}
	}

	if (segments.length === 0 && polylineLoops.length === 0) {
		throw new Error('No usable Line/Arc/Polyline primitives found on BoardOutline layer 11.');
	}

	const loops = buildClosedLoops(segments, toleranceMil, arcStepDegrees);
	loops.push(...polylineLoops);
	if (loops.length === 0) {
		throw new Error(
			`BoardOutline layer has ${segments.length} line/arc segment(s) and ${polylineLoops.length} polyline loop(s), but no closed loop within ${toleranceMil} mil. ` +
			'Fix the outline endpoints or raise toleranceMil slightly.',
		);
	}

	loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
	const outer = loops[0];
	const points = dedupeConsecutivePoints(outer.points, toleranceMil);
	if (!pointsClose(points[0], points[points.length - 1], toleranceMil)) points.push({ ...points[0] });
	const polygonSource = normalizePolygon({ points });
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	return {
		polygonSource,
		points,
		summary: {
			source: 'BoardOutline',
			outlineLayer: 11,
			segmentsFound: segments.length,
			polylinesFound: polylines?.length ?? 0,
			polylineLoopsFound: polylineLoops.length,
			loopsFound: loops.length,
			ignoredInnerLoops: Math.max(0, loops.length - 1),
			usedSegmentCount: outer.segmentCount,
			pointCount: points.length,
			arcStepDegrees,
			toleranceMil,
			area: outer.area,
			bbox: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) },
		},
	};
}

function readPolylineSource(polyline: any): any {
	try {
		const polygon = typeof polyline?.getState_Polygon === 'function' ? polyline.getState_Polygon() : polyline?.polygon;
		return sourceOfPolygon(polygon);
	} catch {
		return sourceOfPolygon(polyline?.polygon);
	}
}

function sourceToPoints(source: any): Point[] {
	if (!Array.isArray(source)) return [];
	if (source.length > 0 && Array.isArray(source[0])) {
		return sourceToPoints(source[0]);
	}
	if (source[0] === 'L') {
		const points: Point[] = [];
		for (let i = 1; i + 1 < source.length; i += 2) {
			if (Number.isFinite(source[i]) && Number.isFinite(source[i + 1])) {
				points.push({ x: source[i], y: source[i + 1] });
			}
		}
		return points;
	}
	if (typeof source[0] === 'number') {
		const points: Point[] = [];
		if (Number.isFinite(source[0]) && Number.isFinite(source[1])) points.push({ x: source[0], y: source[1] });
		for (let i = 2; i + 1 < source.length; i++) {
			if (source[i] === 'L') continue;
			if (Number.isFinite(source[i]) && Number.isFinite(source[i + 1])) {
				points.push({ x: source[i], y: source[i + 1] });
				i += 1;
			}
		}
		return points;
	}
	return [];
}

function readNumber(obj: any, stateName: string, flatName: string): number {
	try {
		const getter = obj?.[`getState_${stateName}`];
		if (typeof getter === 'function') {
			const value = getter.call(obj);
			if (Number.isFinite(value)) return value;
		}
	} catch {/* */}
	const flat = obj?.[flatName];
	if (Number.isFinite(flat)) return flat;
	const nestedName = flatName.startsWith('start') ? 'start' : flatName.startsWith('end') ? 'end' : undefined;
	const axis = flatName.endsWith('X') ? 'x' : flatName.endsWith('Y') ? 'y' : undefined;
	if (nestedName && axis && Number.isFinite(obj?.[nestedName]?.[axis])) return obj[nestedName][axis];
	return Number.NaN;
}

function isFinitePoint(p: Point): boolean {
	return Number.isFinite(p.x) && Number.isFinite(p.y);
}

function pointsClose(a: Point, b: Point, tolerance: number): boolean {
	return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
}

function buildClosedLoops(segments: OutlineSegment[], tolerance: number, arcStepDegrees: number): Array<{
	points: Point[];
	area: number;
	segmentCount: number;
}> {
	const unused = segments.slice();
	const loops: Array<{ points: Point[]; area: number; segmentCount: number }> = [];
	while (unused.length > 0) {
		const first = unused.shift()!;
		let points = segmentPoints(first, false, arcStepDegrees);
		const start = points[0];
		let current = points[points.length - 1];
		let segmentCount = 1;

		while (!pointsClose(current, start, tolerance) && unused.length > 0) {
			const nextIndex = unused.findIndex((s) =>
				pointsClose(s.start, current, tolerance) || pointsClose(s.end, current, tolerance),
			);
			if (nextIndex === -1) break;
			const next = unused.splice(nextIndex, 1)[0];
			const reverse = pointsClose(next.end, current, tolerance);
			const nextPoints = segmentPoints(next, reverse, arcStepDegrees);
			points.push(...nextPoints.slice(1));
			current = points[points.length - 1];
			segmentCount += 1;
		}

		if (pointsClose(current, start, tolerance) && points.length >= 4) {
			points[points.length - 1] = { ...start };
			loops.push({ points, area: polygonArea(points), segmentCount });
		}
	}
	return loops;
}

function segmentPoints(segment: OutlineSegment, reverse: boolean, arcStepDegrees: number): Point[] {
	const start = reverse ? segment.end : segment.start;
	const end = reverse ? segment.start : segment.end;
	const arcAngle = reverse && segment.arcAngle != null ? -segment.arcAngle : segment.arcAngle;
	if (!arcAngle || Math.abs(arcAngle) < 0.01) return [{ ...start }, { ...end }];
	return approximateArc(start, end, arcAngle, arcStepDegrees);
}

function approximateArc(start: Point, end: Point, arcAngleDeg: number, stepDegrees: number): Point[] {
	const theta = arcAngleDeg * Math.PI / 180;
	const chord = Math.hypot(end.x - start.x, end.y - start.y);
	if (!Number.isFinite(theta) || chord <= 0 || Math.abs(Math.sin(theta / 2)) < 1e-6) return [{ ...start }, { ...end }];

	const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
	const perp = { x: -(end.y - start.y) / chord, y: (end.x - start.x) / chord };
	const h = chord / (2 * Math.tan(Math.abs(theta) / 2));
	const candidates = [
		{ x: mid.x + perp.x * h, y: mid.y + perp.y * h },
		{ x: mid.x - perp.x * h, y: mid.y - perp.y * h },
	];
	let center = candidates[0];
	let best = Number.POSITIVE_INFINITY;
	for (const c of candidates) {
		const rotated = rotatePoint(start, c, theta);
		const err = Math.hypot(rotated.x - end.x, rotated.y - end.y);
		if (err < best) { best = err; center = c; }
	}

	const steps = Math.max(2, Math.ceil(Math.abs(arcAngleDeg) / Math.max(1, stepDegrees)));
	const points: Point[] = [];
	for (let i = 0; i <= steps; i++) {
		const a = theta * (i / steps);
		points.push(rotatePoint(start, center, a));
	}
	points[0] = { ...start };
	points[points.length - 1] = { ...end };
	return points;
}

function rotatePoint(p: Point, center: Point, angleRad: number): Point {
	const dx = p.x - center.x;
	const dy = p.y - center.y;
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	return {
		x: center.x + dx * cos - dy * sin,
		y: center.y + dx * sin + dy * cos,
	};
}

function polygonArea(points: Point[]): number {
	let sum = 0;
	for (let i = 0; i < points.length - 1; i++) {
		sum += points[i].x * points[i + 1].y - points[i + 1].x * points[i].y;
	}
	return sum / 2;
}

function dedupeConsecutivePoints(points: Point[], tolerance: number): Point[] {
	const out: Point[] = [];
	for (const p of points) {
		if (out.length === 0 || !pointsClose(out[out.length - 1], p, tolerance)) out.push({ ...p });
	}
	return out;
}

function samplePolygonPerimeter(points: Point[], pitch: number): Point[] {
	const out: Point[] = [];
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		const len = Math.hypot(b.x - a.x, b.y - a.y);
		if (!Number.isFinite(len) || len <= 0) continue;
		const steps = Math.max(1, Math.floor(len / pitch));
		for (let s = 0; s < steps; s++) {
			const t = (s * pitch) / len;
			out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
		}
	}
	return out;
}

function polygonCentroid(points: Point[]): Point {
	let x = 0, y = 0, n = 0;
	for (const p of points) {
		x += p.x; y += p.y; n += 1;
	}
	return n > 0 ? { x: x / n, y: y / n } : { x: 0, y: 0 };
}

function moveToward(from: Point, to: Point, distance: number): Point {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const len = Math.hypot(dx, dy);
	if (!Number.isFinite(len) || len <= 0 || distance === 0) return { ...from };
	return { x: from.x + dx / len * distance, y: from.y + dy / len * distance };
}

function insideAnyKeepout(p: Point, keepouts: any[]): boolean {
	if (!Array.isArray(keepouts)) return false;
	for (const k of keepouts) {
		if (!k || typeof k !== 'object') continue;
		if (Number.isFinite(k.minX) && Number.isFinite(k.maxX) && Number.isFinite(k.minY) && Number.isFinite(k.maxY)) {
			if (p.x >= Math.min(k.minX, k.maxX) && p.x <= Math.max(k.minX, k.maxX) &&
				p.y >= Math.min(k.minY, k.maxY) && p.y <= Math.max(k.minY, k.maxY)) return true;
		}
	}
	return false;
}

function buildPolygonError(label: string, original: any, normalized: any): string {
	const origKind = Array.isArray(original)
		? `array len=${original.length}, first=${JSON.stringify(original[0])}`
		: typeof original;
	const normKind = Array.isArray(normalized)
		? `[${JSON.stringify(normalized[0])}, ... len=${normalized.length}]`
		: typeof normalized;
	return (
		`Invalid ${label} polygon — eda.pcb_MathPolygon.createPolygon returned undefined.\n` +
		`Input: ${origKind}\nNormalized: ${normKind}\n` +
		`Accepted forms: {points: [{x,y},...]}, [{x,y},...], ["L",x1,y1,x2,y2,...], ["R",centerX,centerY,w,h,rot,radius]. ` +
		`Pour/fill/region need a CLOSED ring on a copper layer.`
	);
}
