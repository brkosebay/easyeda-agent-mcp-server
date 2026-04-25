import { flattenState, flattenStateArray, normalizeLayer, normalizePolygon } from './_utils';

export const trackHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// Line
	'pcb.getAll.line': async (params) => {
		const all = await eda.pcb_PrimitiveLine.getAll(params.net, normalizeLayer(params.layer), params.primitiveLock);
		return flattenStateArray(all);
	},

	'pcb.get.line': async (params) => {
		const result = await eda.pcb_PrimitiveLine.get(params.primitiveIds);
		return Array.isArray(result) ? flattenStateArray(result) : flattenState(result);
	},

	'pcb.create.line': async (params) => {
		const line = await eda.pcb_PrimitiveLine.create(
			params.net,
			normalizeLayer(params.layer),
			params.startX,
			params.startY,
			params.endX,
			params.endY,
			params.lineWidth,
		);
		return flattenState(line);
	},

	'pcb.modify.line': async (params) => {
		const property = { ...params.property };
		if (property.layer != null) property.layer = normalizeLayer(property.layer);

		await eda.pcb_PrimitiveLine.modify(params.primitiveId, property);

		// Always re-fetch and verify — EasyEDA's modify(line, {lineWidth, ...})
		// silently no-ops on lineWidth changes in some versions.
		let after = await eda.pcb_PrimitiveLine.get(params.primitiveId);
		let flat = flattenState(after);
		let persisted = !!flat && Object.entries(property).every(([k, v]) =>
			v == null || (flat as any)[k] === v,
		);

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
	'pcb.getAll.polyline': async (params) => {
		const all = await eda.pcb_PrimitivePolyline.getAll(params.net, normalizeLayer(params.layer), params.primitiveLock);
		return flattenStateArray(all);
	},

	'pcb.get.polyline': async (params) => {
		const result = await eda.pcb_PrimitivePolyline.get(params.primitiveIds);
		return Array.isArray(result) ? flattenStateArray(result) : flattenState(result);
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

	'pcb.deleteByFilter.line': async (params) => {
		const layer = params.layer != null ? normalizeLayer(params.layer) : undefined;
		const all = await eda.pcb_PrimitiveLine.getAll(params.net, layer, undefined);
		let lines = all || [];

		if (params.preserveLocked) {
			lines = lines.filter((l: any) => !l.getState_PrimitiveLock?.());
		}

		const ids = lines.map((l: any) => l.getState_PrimitiveId?.()).filter(Boolean);
		if (ids.length === 0) return { deletedCount: 0, ids: [] };
		const ok = await eda.pcb_PrimitiveLine.delete(ids);
		return { deletedCount: ok ? ids.length : 0, ids };
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
