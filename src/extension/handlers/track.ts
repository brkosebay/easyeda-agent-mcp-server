import { didTimeOut, envelopeStateArray, flattenState, flattenStateArray, normalizeLayer, normalizePolygon, withTimeout } from './_utils';
import { enforceTraceObstacles } from './trace-obstacles';
import { COORDINATE_SPACE, attachPolygonSummaries, readPourSource, summarizePolygonSource } from './pour-fill';

const DEFAULT_TRACK_EDIT_TIMEOUT_MS = 5_000;

function getTrackEditTimeoutMs(params: any): number {
	const explicit = Number(params?.timeoutMs);
	const underscore = Number(params?._timeoutMs);
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	if (Number.isFinite(underscore) && underscore > 0) return underscore;
	return DEFAULT_TRACK_EDIT_TIMEOUT_MS;
}

async function awaitTrackEdit<T>(label: string, p: Promise<T>, params: Record<string, any>): Promise<T> {
	const ms = getTrackEditTimeoutMs(params);
	const out = await withTimeout(p, ms);
	if (didTimeOut(out)) {
		throw new Error(`${label} did not complete within ${ms}ms. EasyEDA may still be processing a dense-board edit; retry with a higher timeoutMs or split the route into fewer edits.`);
	}
	return out as T;
}

export const trackHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// Line
	'pcb.getAll.line': async (params) => {
		const all = await eda.pcb_PrimitiveLine.getAll(params.net, normalizeLayer(params.layer), params.primitiveLock);
		return envelopeStateArray(all, params);
	},

	'pcb.get.line': async (params) => {
		const result = await eda.pcb_PrimitiveLine.get(params.primitiveIds);
		return Array.isArray(result) ? flattenStateArray(result) : flattenState(result);
	},

	'pcb.create.line': async (params) => {
		const obstacleCheck = await enforceTraceObstacles({
			...params,
			layer: normalizeLayer(params.layer),
			segments: [{
				net: params.net,
				layer: normalizeLayer(params.layer),
				startX: params.startX,
				startY: params.startY,
				endX: params.endX,
				endY: params.endY,
				lineWidth: params.lineWidth,
				role: 'create_track',
			}],
		});
		const line = await awaitTrackEdit(
			'pcb.create.line',
			eda.pcb_PrimitiveLine.create(
				params.net,
				normalizeLayer(params.layer),
				params.startX,
				params.startY,
				params.endX,
				params.endY,
				params.lineWidth,
			),
			params,
		);
		return { ...flattenState(line), obstacleCheck };
	},

	'pcb.modify.line': async (params) => {
		const property = { ...params.property };
		if (property.layer != null) property.layer = normalizeLayer(property.layer);

		await eda.pcb_PrimitiveLine.modify(params.primitiveId, property);

		// Always re-fetch and verify — EasyEDA's modify(line, {lineWidth, ...})
		// silently no-ops on lineWidth changes in some versions.
		let after = await eda.pcb_PrimitiveLine.get(params.primitiveId);
		let flat = flattenState(after);
		// Compare only real track properties, numbers within 1e-3 mil. Comparing
		// every submitted key (incl. _timeoutMs) with exact float equality made
		// 210 of 347 successful modifies report persisted:false.
		let persisted = !!flat && Object.entries(property).every(([k, v]) => {
			if (v == null || !TRACK_PROPERTY_KEYS.has(k)) return true;
			const got = (flat as any)[k];
			if (typeof v === 'number' && typeof got === 'number') return Math.abs(got - v) <= 1e-3;
			return String(got) === String(v);
		});

		// Workaround for the lineWidth-no-op bug: if the only un-persisted
		// property is lineWidth, recreate the line at the new width. The
		// primitive ID changes — we surface the new ID in `after`.
		let recreated = false;
		if (!persisted && property.lineWidth != null && flat) {
			const before: any = flat;
			const widthBefore = before.lineWidth;
			const widthRequested = property.lineWidth;
			if (widthBefore !== widthRequested) {
				const layer = property.layer ?? before.layer;
				const net = property.net ?? before.net;
				const startX = property.startX ?? before.startX;
				const startY = property.startY ?? before.startY;
				const endX = property.endX ?? before.endX;
				const endY = property.endY ?? before.endY;

				await eda.pcb_PrimitiveLine.delete(params.primitiveId);
				const fresh = await eda.pcb_PrimitiveLine.create(
					net, layer, startX, startY, endX, endY, widthRequested,
				);
				recreated = true;
				after = fresh as any;
				flat = flattenState(fresh);
				persisted = !!flat && (flat as any).lineWidth === widthRequested;
			}
		}

		return {
			modified: true,
			persisted,
			recreated,
			after: flat,
			attempted: property,
		};
	},

	'pcb.delete.line': async (params) => {
		return eda.pcb_PrimitiveLine.delete(params.ids);
	},

	// Polyline
	//
	// A polyline's only geometry lives in the polygon source that flattenState
	// strips as a heavy field. Emit the same summarized geometry (bbox, vertex
	// count, leading point sample) regions get, in the canvas Y convention.
	'pcb.getAll.polyline': async (params) => {
		const all = await eda.pcb_PrimitivePolyline.getAll(params.net, normalizeLayer(params.layer), params.primitiveLock);
		const envelope = envelopeStateArray(all, params, { verbose: !!params.verbose });
		attachPolygonSummaries(envelope, all);
		return { ...envelope, coordinateSpace: COORDINATE_SPACE };
	},

	'pcb.get.polyline': async (params) => {
		const result = await eda.pcb_PrimitivePolyline.get(params.primitiveIds);
		const verbose = !!params.verbose;
		if (Array.isArray(result)) {
			const flat = flattenStateArray(result, { verbose });
			return flat.map((entry, i) => {
				const summary = summarizePolygonSource(readPourSource(result[i]));
				return summary ? { ...entry, summary, coordinateSpace: COORDINATE_SPACE } : entry;
			});
		}
		const flat = flattenState(result, { verbose });
		const summary = summarizePolygonSource(readPourSource(result));
		return summary ? { ...flat, summary, coordinateSpace: COORDINATE_SPACE } : flat;
	},

	'pcb.create.polyline': async (params) => {
		const polygonSource = normalizePolygon(params.polygon);
		const polygon = eda.pcb_MathPolygon.createPolygon(polygonSource as any);
		if (!polygon) throw new Error(buildPolygonError('polyline', params.polygon, polygonSource));
		const result = await eda.pcb_PrimitivePolyline.create(params.net, normalizeLayer(params.layer), polygon, params.lineWidth);
		return flattenState(result);
	},

	'pcb.modify.polyline': async (params) => {
		const property = { ...params.property };
		if (property.layer != null) property.layer = normalizeLayer(property.layer);
		const result = await eda.pcb_PrimitivePolyline.modify(params.primitiveId, property);
		return flattenState(result);
	},

	'pcb.delete.polyline': async (params) => {
		return eda.pcb_PrimitivePolyline.delete(params.ids);
	},

	// Cluster tracks + vias by net/layer/geometry and report (or delete) the
	// redundant copies that pile up after multiple autoroute/import passes.
	// PCB2 hit ~125 same-net same-coordinate via duplicates after a few
	// FreeRouting cycles — this gives an agent a single reliable way to
	// preview and clean them up without hand-deleting via primitiveId.
	//
	// Clustering key:
	//   line: layer | net | round(startX,startY,endX,endY,lineWidth)
	//         (start/end are sorted so reversed-direction copies cluster too)
	//   via:  net   | round(x,y,diameter,holeDiameter)
	//
	// Within a cluster we keep the locked one if any, otherwise the first.
	'pcb.copper.dedupe': async (params) => {
		const scope: 'lines' | 'vias' | 'all' = params.scope || 'all';
		const dryRun: boolean = params.dryRun !== false; // default true — preview only
		const layer = params.layer != null ? normalizeLayer(params.layer) : undefined;
		const net: string | undefined = params.net;
		const tol: number = typeof params.tolerance === 'number' && params.tolerance > 0 ? params.tolerance : 0.01;

		const round = (n: any): number => {
			if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
			return Math.round(n / tol) * tol;
		};
		const lockedOf = (o: any): boolean => {
			try { if (typeof o?.getState_PrimitiveLock === 'function') return !!o.getState_PrimitiveLock(); } catch {/* */}
			return !!o?.primitiveLock || !!o?.locked;
		};
		const idOf = (o: any): string | undefined => {
			try { if (typeof o?.getState_PrimitiveId === 'function') return o.getState_PrimitiveId(); } catch {/* */}
			return o?.primitiveId ?? o?.globalIndex;
		};
		const flatProp = (o: any, getter: string, fallback: string): any => {
			try { if (typeof o?.[getter] === 'function') return o[getter](); } catch {/* */}
			return o?.[fallback];
		};

		type Cluster = { key: string; ids: string[]; keepId?: string; deleteIds: string[] };
		const clusters = new Map<string, Cluster>();

		const addToCluster = (key: string, id: string, locked: boolean): void => {
			let c = clusters.get(key);
			if (!c) { c = { key, ids: [], keepId: undefined, deleteIds: [] }; clusters.set(key, c); }
			c.ids.push(id);
			// Prefer keeping locked primitives; otherwise first id wins.
			if (locked && !c.keepId) c.keepId = id;
			else if (!c.keepId) c.keepId = id;
		};

		// Lines
		let scannedLines = 0;
		if (scope === 'lines' || scope === 'all') {
			const lines = (await eda.pcb_PrimitiveLine.getAll(net, layer, undefined)) || [];
			scannedLines = lines.length;
			for (const l of lines) {
				const id = idOf(l);
				if (!id) continue;
				const ln = String(flatProp(l, 'getState_Layer', 'layer') ?? '');
				const nt = String(flatProp(l, 'getState_Net', 'net') ?? '');
				const sx = round(flatProp(l, 'getState_StartX', 'startX'));
				const sy = round(flatProp(l, 'getState_StartY', 'startY'));
				const ex = round(flatProp(l, 'getState_EndX', 'endX'));
				const ey = round(flatProp(l, 'getState_EndY', 'endY'));
				const lw = round(flatProp(l, 'getState_LineWidth', 'lineWidth'));
				// Sort endpoints so AB and BA cluster together.
				const [ax, ay, bx, by] = (sx < ex || (sx === ex && sy <= ey))
					? [sx, sy, ex, ey] : [ex, ey, sx, sy];
				const key = `line|${ln}|${nt}|${ax},${ay}->${bx},${by}|w${lw}`;
				addToCluster(key, id, lockedOf(l));
			}
		}

		// Vias
		let scannedVias = 0;
		if (scope === 'vias' || scope === 'all') {
			const vias = (await eda.pcb_PrimitiveVia.getAll(net, undefined)) || [];
			scannedVias = vias.length;
			for (const v of vias) {
				const id = idOf(v);
				if (!id) continue;
				const nt = String(flatProp(v, 'getState_Net', 'net') ?? '');
				const x = round(flatProp(v, 'getState_X', 'x'));
				const y = round(flatProp(v, 'getState_Y', 'y'));
				const d = round(flatProp(v, 'getState_Diameter', 'diameter'));
				const h = round(flatProp(v, 'getState_HoleDiameter', 'holeDiameter'));
				const key = `via|${nt}|${x},${y}|d${d}|h${h}`;
				addToCluster(key, id, lockedOf(v));
			}
		}

		// Compute deletions per cluster (everything except keepId).
		const duplicateClusters: Cluster[] = [];
		for (const c of clusters.values()) {
			if (c.ids.length <= 1) continue;
			c.deleteIds = c.ids.filter((id) => id !== c.keepId);
			duplicateClusters.push(c);
		}
		const allDeleteLineIds: string[] = [];
		const allDeleteViaIds: string[] = [];
		for (const c of duplicateClusters) {
			if (c.key.startsWith('line|')) allDeleteLineIds.push(...c.deleteIds);
			else if (c.key.startsWith('via|')) allDeleteViaIds.push(...c.deleteIds);
		}

		let deletedLines = 0;
		let deletedVias = 0;
		if (!dryRun) {
			if (allDeleteLineIds.length > 0) {
				const ok = await eda.pcb_PrimitiveLine.delete(allDeleteLineIds);
				if (ok) deletedLines = allDeleteLineIds.length;
			}
			if (allDeleteViaIds.length > 0) {
				const ok = await eda.pcb_PrimitiveVia.delete(allDeleteViaIds);
				if (ok) deletedVias = allDeleteViaIds.length;
			}
		}

		// Cap cluster detail in the response so big boards don't flood the
		// channel; agents can re-run with a tighter scope to inspect.
		const sampleClusters = duplicateClusters
			.sort((a, b) => b.ids.length - a.ids.length)
			.slice(0, 50)
			.map((c) => ({
				key: c.key,
				count: c.ids.length,
				keepId: c.keepId,
				deleteIds: c.deleteIds.slice(0, 10),
			}));

		return {
			dryRun,
			scope,
			scannedLines,
			scannedVias,
			duplicateClusterCount: duplicateClusters.length,
			lineDuplicateCount: allDeleteLineIds.length,
			viaDuplicateCount: allDeleteViaIds.length,
			deletedLines,
			deletedVias,
			clusters: sampleClusters,
		};
	},

	'pcb.deleteByFilter.line': async (params) => {
		const layer = params.layer != null ? normalizeLayer(params.layer) : undefined;
		const all = await eda.pcb_PrimitiveLine.getAll(params.net, layer, undefined);
		let lines = all || [];

		const lockedOf = (l: any): boolean => {
			try { if (typeof l?.getState_PrimitiveLock === 'function') return !!l.getState_PrimitiveLock(); } catch {/* */}
			return !!l?.primitiveLock || !!l?.locked;
		};
		const idOf = (l: any): string | undefined => {
			try { if (typeof l?.getState_PrimitiveId === 'function') return l.getState_PrimitiveId(); } catch {/* */}
			return l?.primitiveId ?? l?.globalIndex;
		};

		if (params.preserveLocked) lines = lines.filter((l: any) => !lockedOf(l));

		const ids = lines.map(idOf).filter((x): x is string => Boolean(x));
		if (ids.length === 0) return { deletedCount: 0, ids: [] };
		const ok = await eda.pcb_PrimitiveLine.delete(ids);
		return { deletedCount: ok ? ids.length : 0, ids };
	},

	'pcb.lockByFilter': async (params) => {
		const lock = params.lock !== false;
		const nets: Array<string | undefined> = Array.isArray(params.nets) && params.nets.length > 0 ? params.nets : [params.net];
		const layers = Array.isArray(params.layers) && params.layers.length > 0
			? params.layers.map(normalizeLayer)
			: params.layer != null ? [normalizeLayer(params.layer)] : [undefined];
		const types: string[] = Array.isArray(params.types) && params.types.length > 0
			? params.types
			: ['track', 'via', 'arc', 'polyline', 'pour', 'fill', 'region'];

			const idOf = (o: any): string | undefined => {
				try { if (typeof o?.getState_PrimitiveId === 'function') return o.getState_PrimitiveId(); } catch {/* */}
				return o?.primitiveId ?? o?.globalIndex;
			};
			const idsOf = (items: any[] | undefined): string[] => (items || [])
				.map(idOf)
				.filter((id): id is string => typeof id === 'string' && id.length > 0);
			const results: Array<Record<string, any>> = [];
		let matched = 0;
		let modified = 0;

		const update = async (type: string, ids: string[], fn: (id: string) => Promise<any>) => {
			matched += ids.length;
			let okCount = 0;
			for (const id of ids) {
				try {
					const out = await fn(id);
					if (out) okCount += 1;
				} catch {/* per-id failure is reflected by okCount */}
			}
			modified += okCount;
			if (ids.length > 0) results.push({ type, matched: ids.length, modified: okCount, ids: ids.slice(0, 50) });
		};

			if (types.includes('track')) {
				for (const net of nets) for (const layer of layers) {
					const all = await eda.pcb_PrimitiveLine.getAll(net, layer, undefined);
					await update('track', idsOf(all), (id) => eda.pcb_PrimitiveLine.modify(id, { primitiveLock: lock }));
				}
			}
			if (types.includes('arc')) {
				for (const net of nets) for (const layer of layers) {
					const all = await eda.pcb_PrimitiveArc.getAll(net, layer, undefined);
					await update('arc', idsOf(all), (id) => eda.pcb_PrimitiveArc.modify(id, { primitiveLock: lock }));
				}
			}
			if (types.includes('polyline')) {
				for (const net of nets) for (const layer of layers) {
					const all = await eda.pcb_PrimitivePolyline.getAll(net, layer, undefined);
					await update('polyline', idsOf(all), (id) => eda.pcb_PrimitivePolyline.modify(id, { primitiveLock: lock }));
				}
			}
			if (types.includes('via')) {
				for (const net of nets) {
					const all = await eda.pcb_PrimitiveVia.getAll(net, undefined);
					await update('via', idsOf(all), (id) => eda.pcb_PrimitiveVia.modify(id, { primitiveLock: lock }));
				}
			}
			if (types.includes('pour')) {
				for (const net of nets) for (const layer of layers) {
					const all = await eda.pcb_PrimitivePour.getAll(net, layer, undefined);
					await update('pour', idsOf(all), (id) => eda.pcb_PrimitivePour.modify(id, { primitiveLock: lock }));
				}
			}
			if (types.includes('fill')) {
				for (const net of nets) for (const layer of layers) {
					const all = await eda.pcb_PrimitiveFill.getAll(layer, net, undefined);
					await update('fill', idsOf(all), (id) => eda.pcb_PrimitiveFill.modify(id, { primitiveLock: lock }));
				}
			}
			if (types.includes('region')) {
				for (const layer of layers) {
					const all = await eda.pcb_PrimitiveRegion.getAll(layer, undefined, undefined);
					await update('region', idsOf(all), (id) => eda.pcb_PrimitiveRegion.modify(id, { primitiveLock: lock }));
				}
			}

		return { lock, matched, modified, results };
	},
};

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
		`Accepted forms: {points: [{x,y},...]}, [{x,y},...], ["L",x1,y1,x2,y2,...,x1,y1], ["R",cx,cy,w,h,rot,radius]. ` +
		`Pour/fill/region need a CLOSED ring on a copper layer.`
	);
}

const TRACK_PROPERTY_KEYS = new Set(['net', 'layer', 'startX', 'startY', 'endX', 'endY', 'lineWidth', 'primitiveLock']);
