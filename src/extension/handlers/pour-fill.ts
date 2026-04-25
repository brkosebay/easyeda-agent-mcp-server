import { flattenState, flattenStateArray, normalizeLayer, normalizePolygon } from './_utils';

export const pourFillHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// === Pour ===

	'pcb.getAll.pour': async (params) => {
		const all = await eda.pcb_PrimitivePour.getAll(params.net, normalizeLayer(params.layer), params.primitiveLock);
		return flattenStateArray(all);
	},

	'pcb.get.pour': async (params) => {
		const result = await eda.pcb_PrimitivePour.get(params.primitiveIds);
		return Array.isArray(result) ? flattenStateArray(result) : flattenState(result);
	},

	'pcb.create.pour': async (params) => {
		const polygonSource = normalizePolygon(params.polygon);
		let polygon: any = eda.pcb_MathPolygon.createPolygon(polygonSource as any);
		if (!polygon) {
			// Fallback: try complex polygon if the simple form was rejected.
			polygon = eda.pcb_MathPolygon.createComplexPolygon?.(polygonSource as any);
		}
		if (!polygon) throw new Error(buildPolygonError('pour', params.polygon, polygonSource));

		const result = await eda.pcb_PrimitivePour.create(
			params.net,
			normalizeLayer(params.layer),
			polygon,
			params.pourFillMethod,
			params.preserveSilos,
			params.pourName,
			params.pourPriority,
			params.lineWidth,
			params.primitiveLock,
		);
		return flattenState(result);
	},

	'pcb.modify.pour': async (params) => {
		const property = { ...params.property };
		if (property.layer != null) property.layer = normalizeLayer(property.layer);
		const result = await eda.pcb_PrimitivePour.modify(params.primitiveId, property);
		const after = await eda.pcb_PrimitivePour.get(params.primitiveId);
		return { modified: !!result, after: flattenState(after) };
	},

	'pcb.delete.pour': async (params) => {
		return eda.pcb_PrimitivePour.delete(params.ids);
	},

	// === Fill ===

	'pcb.getAll.fill': async (params) => {
		const all = await eda.pcb_PrimitiveFill.getAll(normalizeLayer(params.layer), params.net, params.primitiveLock);
		return flattenStateArray(all);
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

	'pcb.pour.repourAll': async (params) => {
		const layer = params?.layer != null ? normalizeLayer(params.layer) : undefined;
		const pours = await eda.pcb_PrimitivePour.getAll(params?.net, layer, undefined);
		let rebuilt = 0;
		const failures: Array<{ primitiveId: string; reason: string }> = [];

		for (const pour of pours || []) {
			try {
				if (pour.getState_PrimitiveLock?.()) continue;
				const out = await pour.rebuildCopperRegion?.();
				if (out) rebuilt += 1;
			} catch (err: any) {
				failures.push({
					primitiveId: pour.getState_PrimitiveId?.() || 'unknown',
					reason: err?.message ?? String(err),
				});
			}
		}

		return {
			pourCount: pours?.length ?? 0,
			rebuilt,
			failures,
		};
	},
};

function buildPolygonError(label: string, original: any, normalized: any): string {
	const origKind = Array.isArray(original)
		? `array len=${original.length}, first=${JSON.stringify(original[0])}`
		: typeof original;
	const normKind = Array.isArray(normalized)
		? `["${normalized[0]}", ... len=${normalized.length}]`
		: typeof normalized;
	return (
		`Invalid ${label} polygon — eda.pcb_MathPolygon.createPolygon returned undefined.\n` +
		`Input: ${origKind}\nNormalized: ${normKind}\n` +
		`Accepted forms: {points: [{x,y},...]}, [{x,y},...], ["L",x1,y1,x2,y2,...,x1,y1], ["R",cx,cy,w,h,rot,radius]. ` +
		`Pour/fill/region need a CLOSED ring on a copper layer.`
	);
}
