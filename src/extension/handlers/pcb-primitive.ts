import { flattenState, flattenStateArray, normalizeLayer, normalizePolygon } from './_utils';

export const pcbPrimitiveHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// === Arc ===

	'pcb.getAll.arc': async (params) => {
		const all = await eda.pcb_PrimitiveArc.getAll(params.net, normalizeLayer(params.layer), params.primitiveLock);
		return flattenStateArray(all);
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

	'pcb.getAll.region': async (params) => {
		const all = await eda.pcb_PrimitiveRegion.getAll(normalizeLayer(params.layer), params.ruleType, params.primitiveLock);
		return flattenStateArray(all);
	},

	'pcb.get.region': async (params) => {
		const result = await eda.pcb_PrimitiveRegion.get(params.primitiveIds);
		return Array.isArray(result) ? flattenStateArray(result) : flattenState(result);
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
		const ref: string = params.reference;
		const padNum: string = String(params.padNumber);

		const components = await eda.pcb_PrimitiveComponent.getAll();
		const target = (components || []).find((c: any) => c?.getState_Designator?.() === ref);
		if (!target) {
			throw new Error(`Component with designator "${ref}" not found on PCB.`);
		}
		const targetId = target.getState_PrimitiveId?.();
		const pads = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(targetId);
		const pad = (pads || []).find((p: any) => String(p?.getState_PadNumber?.()) === padNum);
		if (!pad) {
			throw new Error(`Pad ${padNum} not found on component ${ref}.`);
		}
		return {
			...flattenState(pad),
			reference: ref,
			padNumber: padNum,
		};
	},

	// === Orthogonal (Manhattan) routing — emits real Line primitives ===

	'pcb.route.orthogonal': async (params) => {
		const { net, fromX, fromY, toX, toY, lineWidth } = params;
		const layer = normalizeLayer(params.layer);
		const lines: any[] = [];

		if (fromX === toX || fromY === toY) {
			const a = await eda.pcb_PrimitiveLine.create(net, layer, fromX, fromY, toX, toY, lineWidth);
			lines.push(a);
		} else if (params.jogY != null && params.jogY !== fromY && params.jogY !== toY) {
			const a = await eda.pcb_PrimitiveLine.create(net, layer, fromX, fromY, fromX, params.jogY, lineWidth);
			const b = await eda.pcb_PrimitiveLine.create(net, layer, fromX, params.jogY, toX, params.jogY, lineWidth);
			const c = await eda.pcb_PrimitiveLine.create(net, layer, toX, params.jogY, toX, toY, lineWidth);
			lines.push(a, b, c);
		} else if (params.jogX != null && params.jogX !== fromX && params.jogX !== toX) {
			const a = await eda.pcb_PrimitiveLine.create(net, layer, fromX, fromY, params.jogX, fromY, lineWidth);
			const b = await eda.pcb_PrimitiveLine.create(net, layer, params.jogX, fromY, params.jogX, toY, lineWidth);
			const c = await eda.pcb_PrimitiveLine.create(net, layer, params.jogX, toY, toX, toY, lineWidth);
			lines.push(a, b, c);
		} else {
			const cornerX = toX;
			const cornerY = fromY;
			const a = await eda.pcb_PrimitiveLine.create(net, layer, fromX, fromY, cornerX, cornerY, lineWidth);
			const b = await eda.pcb_PrimitiveLine.create(net, layer, cornerX, cornerY, toX, toY, lineWidth);
			lines.push(a, b);
		}

		return {
			segmentCount: lines.length,
			primitiveIds: lines.map((l) => l?.getState_PrimitiveId?.()).filter(Boolean),
		};
	},
};
