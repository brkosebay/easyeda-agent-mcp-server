import { flattenState, flattenStateArray } from './_utils';

export const componentHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.getAll.component': async (params) => {
		const all = await eda.pcb_PrimitiveComponent.getAll(params.layer, params.primitiveLock);
		return flattenStateArray(all);
	},

	'pcb.get.component': async (params) => {
		const result = await eda.pcb_PrimitiveComponent.get(params.primitiveIds);
		return Array.isArray(result) ? flattenStateArray(result) : flattenState(result);
	},

	'pcb.modify.component': async (params) => {
		const result = await eda.pcb_PrimitiveComponent.modify(params.primitiveId, params.property);
		const after = await eda.pcb_PrimitiveComponent.get(params.primitiveId);
		return { modified: !!result, after: flattenState(after) };
	},

	'pcb.delete.component': async (params) => {
		return eda.pcb_PrimitiveComponent.delete(params.ids);
	},

	'pcb.component.getPins': async (params) => {
		const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(params.primitiveId);
		return flattenStateArray(pins as any[]);
	},
};
