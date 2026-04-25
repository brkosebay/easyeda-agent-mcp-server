import { flattenState, flattenStateArray, mmToMil, normalizeViaType } from './_utils';

export const viaHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.getAll.via': async (params) => {
		const all = await eda.pcb_PrimitiveVia.getAll(params.net, params.primitiveLock);
		return flattenStateArray(all);
	},

	'pcb.get.via': async (params) => {
		const result = await eda.pcb_PrimitiveVia.get(params.primitiveIds);
		return Array.isArray(result) ? flattenStateArray(result) : flattenState(result);
	},

	'pcb.create.via': async (params) => {
		const via = await eda.pcb_PrimitiveVia.create(
			params.net,
			params.x,
			params.y,
			params.holeDiameter,
			params.diameter,
			normalizeViaType(params.viaType),
		);
		return flattenState(via);
	},

	'pcb.create.via.mm': async (params) => {
		const holeMil = round3(mmToMil(params.drill_mm));
		const diameterMil = round3(mmToMil(params.diameter_mm));
		const via = await eda.pcb_PrimitiveVia.create(
			params.net,
			params.x,
			params.y,
			holeMil,
			diameterMil,
			normalizeViaType(params.viaType),
		);
		const flat = flattenState(via);
		return { ...flat, holeDiameter_mil: holeMil, diameter_mil: diameterMil };
	},

	'pcb.modify.via': async (params) => {
		const property = { ...params.property };
		if (property.viaType != null) property.viaType = normalizeViaType(property.viaType);
		const result = await eda.pcb_PrimitiveVia.modify(params.primitiveId, property);
		// Verify by re-fetching — modify return may not reflect persisted state.
		const after = await eda.pcb_PrimitiveVia.get(params.primitiveId);
		return { modified: !!result, after: flattenState(after) };
	},

	'pcb.delete.via': async (params) => {
		return eda.pcb_PrimitiveVia.delete(params.ids);
	},
};

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}
