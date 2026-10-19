import { envelopeStateArray, flattenState, flattenStateArray, normalizeLayer, normalizePolygon, withTimeout, didTimeOut } from './_utils';
import { normalizePadShapeUnits, enforceTraceObstacles, type TraceSegmentSpec } from './trace-obstacles';
import { componentPinScale, componentPinSourceUnits } from './pin-units';
import { COORDINATE_SPACE, attachPolygonSummaries, readPourSource, summarizePolygonSource } from './pour-fill';

const DEFAULT_PAD_LOOKUP_TIMEOUT_MS = 5_000;

function getTimeoutMs(params: any, fallbackMs: number): number {
	const explicit = Number(params?.timeoutMs);
	const underscore = Number(params?._timeoutMs);
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	if (Number.isFinite(underscore) && underscore > 0) return underscore;
	return fallbackMs;
}

async function awaitPadLookupCommand<T>(label: string, p: Promise<T>, params: any): Promise<T> {
	const ms = getTimeoutMs(params, DEFAULT_PAD_LOOKUP_TIMEOUT_MS);
	const out = await withTimeout(p, ms);
	if (didTimeOut(out)) {
		throw new Error(`${label} did not complete within ${ms}ms. EasyEDA may be busy resolving component/pin geometry; retry with a higher timeoutMs or a smaller query.`);
	}
	return out as T;
}

export const pcbPrimitiveHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// === Arc ===

	'pcb.getAll.arc': async (params) => {
		const all = await eda.pcb_PrimitiveArc.getAll(params.net, normalizeLayer(params.layer), params.primitiveLock);
		return envelopeStateArray(all, params);
	},

	'pcb.get.arc': async (params) => {
		const result = await eda.pcb_PrimitiveArc.get(params.primitiveIds);
		return Array.isArray(result) ? flattenStateArray(result) : flattenState(result);
	},

	'pcb.create.arc': async (params) => {
		const arc = await eda.pcb_PrimitiveArc.create(
			params.net,
			normalizeLayer(params.layer),
			params.startX,
			params.startY,
			params.endX,
			params.endY,
			params.arcAngle,
			params.lineWidth,
			params.interactiveMode,
			params.primitiveLock,
		);
		return flattenState(arc);
	},

	'pcb.modify.arc': async (params) => {
		const property = { ...params.property };
		if (property.layer != null) property.layer = normalizeLayer(property.layer);
		const result = await eda.pcb_PrimitiveArc.modify(params.primitiveId, property);
		const after = await eda.pcb_PrimitiveArc.get(params.primitiveId);
		return { modified: !!result, after: flattenState(after) };
	},

	'pcb.delete.arc': async (params) => {
		return eda.pcb_PrimitiveArc.delete(params.ids);
	},

	// === Region ===

	// A region's ONLY geometry lives in its complexPolygon, which flattenState
	// strips as a heavy field. Without a summary the response is unusable —
	// so emit bbox + point count + a leading point sample alongside the
	// identity fields, in the same canvas Y convention tracks/pads/vias use.
	'pcb.getAll.region': async (params) => {
		const all = await eda.pcb_PrimitiveRegion.getAll(normalizeLayer(params.layer), params.ruleType, params.primitiveLock);
		const envelope = envelopeStateArray(all, params, { verbose: !!params.verbose });
		attachPolygonSummaries(envelope, all);
		return { ...envelope, coordinateSpace: COORDINATE_SPACE };
	},

	'pcb.get.region': async (params) => {
		const result = await eda.pcb_PrimitiveRegion.get(params.primitiveIds);
		const verbose = !!params.verbose;
		if (Array.isArray(result)) {
			const flat = flattenStateArray(result, { verbose });
			return flat.map((entry, i) => {
				const s = summarizePolygonSource(readPourSource(result[i]));
				return s ? { ...entry, summary: s, coordinateSpace: COORDINATE_SPACE } : entry;
			});
		}
		const flat = flattenState(result, { verbose });
		const s = summarizePolygonSource(readPourSource(result));
		return s ? { ...flat, summary: s, coordinateSpace: COORDINATE_SPACE } : flat;
	},

	'pcb.create.region': async (params) => {
		const polygonSource = normalizePolygon(params.polygon);
		let polygon: any = eda.pcb_MathPolygon.createPolygon(polygonSource as any);
		if (!polygon) polygon = eda.pcb_MathPolygon.createComplexPolygon?.(polygonSource as any);
		if (!polygon) {
			throw new Error(
				`Invalid region polygon. Accepted: {points:[{x,y}]}, [{x,y}], ["L",x,y,...], ["R",cx,cy,w,h,rot,radius]`,
			);
		}
		const result = await eda.pcb_PrimitiveRegion.create(
			normalizeLayer(params.layer),
			polygon,
			params.ruleType,
			params.regionName,
			params.lineWidth,
			params.primitiveLock,
		);
		return flattenState(result);
	},

	'pcb.modify.region': async (params) => {
		const property = { ...params.property };
		if (property.layer != null) property.layer = normalizeLayer(property.layer);
		const result = await eda.pcb_PrimitiveRegion.modify(params.primitiveId, property);
		return flattenState(result);
	},

	'pcb.delete.region': async (params) => {
		return eda.pcb_PrimitiveRegion.delete(params.ids);
	},

	// === Pad lookup by ref+pin ===

	'pcb.pad.findByRef': async (params) => {
		const lookup = async () => {
			const ref: string = params.reference;
			const padNum: string = String(params.padNumber);

			const designatorOf = (c: any): string | undefined => {
				try { if (typeof c?.getState_Designator === 'function') return c.getState_Designator(); } catch {/* */}
				return c?.designator;
			};
			const idOf = (c: any): string | undefined => {
				try { if (typeof c?.getState_PrimitiveId === 'function') return c.getState_PrimitiveId(); } catch {/* */}
				return c?.primitiveId;
			};
			const padNumberOf = (p: any): string | undefined => {
				try { if (typeof p?.getState_PadNumber === 'function') return String(p.getState_PadNumber()); } catch {/* */}
				return p?.padNumber != null ? String(p.padNumber) : undefined;
			};

			const components = await eda.pcb_PrimitiveComponent.getAll();
			const target = (components || []).find((c: any) => designatorOf(c) === ref);
			if (!target) {
				throw new Error(`Component with designator "${ref}" not found on PCB.`);
			}
			const targetId = idOf(target);
			if (!targetId) {
				throw new Error(`Could not resolve primitiveId for component "${ref}".`);
			}
			const pads = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(targetId);
			const pad = (pads || []).find((p: any) => padNumberOf(p) === padNum);
			if (!pad) {
				throw new Error(`Pad ${padNum} not found on component ${ref}.`);
			}
			const flat: any = flattenState(pad);
			const pinScale = await componentPinScale();
			const readCoord = (axis: 'X' | 'Y', flatName: 'x' | 'y'): number | undefined => {
				try {
					const getter = (pad as any)?.[`getState_${axis}`];
					if (typeof getter === 'function') {
						const value = getter.call(pad);
						if (Number.isFinite(value)) return Number(value) * pinScale;
					}
				} catch {/* */}
				return Number.isFinite(flat?.[flatName]) ? Number(flat[flatName]) * pinScale : undefined;
			};
			normalizePadShapeUnits(flat);
			return {
				...flat,
				x: readCoord('X', 'x') ?? flat?.x,
				y: readCoord('Y', 'y') ?? flat?.y,
				reference: ref,
				padNumber: padNum,
				units: 'mil',
				sourceUnits: componentPinSourceUnits(pinScale),
			};
		};

		return await awaitPadLookupCommand('pcb.pad.findByRef', lookup(), params);
	},

	// === Orthogonal (Manhattan) routing — emits real Line primitives ===

	'pcb.route.orthogonal': async (params) => {
		const { net, fromX, fromY, toX, toY, lineWidth } = params;
		const layer = normalizeLayer(params.layer);
		const lines: any[] = [];
		const segments: TraceSegmentSpec[] = [];
		const addSegment = (startX: number, startY: number, endX: number, endY: number, role: string) => {
			segments.push({ net, layer, startX, startY, endX, endY, lineWidth, role });
		};

		if (fromX === toX || fromY === toY) {
			addSegment(fromX, fromY, toX, toY, 'orthogonal_direct');
		} else if (params.jogY != null && params.jogY !== fromY && params.jogY !== toY) {
			addSegment(fromX, fromY, fromX, params.jogY, 'orthogonal_jog');
			addSegment(fromX, params.jogY, toX, params.jogY, 'orthogonal_jog');
			addSegment(toX, params.jogY, toX, toY, 'orthogonal_jog');
		} else if (params.jogX != null && params.jogX !== fromX && params.jogX !== toX) {
			addSegment(fromX, fromY, params.jogX, fromY, 'orthogonal_jog');
			addSegment(params.jogX, fromY, params.jogX, toY, 'orthogonal_jog');
			addSegment(params.jogX, toY, toX, toY, 'orthogonal_jog');
		} else {
			const cornerX = toX;
			const cornerY = fromY;
			addSegment(fromX, fromY, cornerX, cornerY, 'orthogonal_corner');
			addSegment(cornerX, cornerY, toX, toY, 'orthogonal_corner');
		}

		const dryRun = !!params.dryRun;
		const obstacleCheck = await enforceTraceObstacles({
			...params,
			net,
			layer,
			segments,
			failOnObstacle: dryRun ? false : params.failOnObstacle,
		});
		if (!dryRun) {
			for (const s of segments) {
				lines.push(await eda.pcb_PrimitiveLine.create(net, layer, s.startX, s.startY, s.endX, s.endY, lineWidth));
			}
		}

		const idOf = (l: any): string | undefined => {
			try { if (typeof l?.getState_PrimitiveId === 'function') return l.getState_PrimitiveId(); } catch {/* */}
			return l?.primitiveId;
		};
		return {
			dryRun,
			segmentCount: dryRun ? segments.length : lines.length,
			segments,
			obstacleCheck,
			primitiveIds: lines.map(idOf).filter(Boolean),
		};
	},
};
