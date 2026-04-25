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
		validateViaSize(params.holeDiameter, params.diameter);
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

// EasyEDA's via API uses MIL. Anything under ~3 mil is almost certainly the
// caller passing mm by mistake (0.3 mm pad → reads back as 0/0 because the
// runtime rounds tiny mil values to integers). Reject early with a clear hint.
function validateViaSize(holeMil: number, diameterMil: number): void {
	if (typeof holeMil !== 'number' || !Number.isFinite(holeMil) || holeMil <= 0) {
		throw new Error('holeDiameter must be a positive number in mil. Use pcb_create_via_mm for mm input.');
	}
	if (typeof diameterMil !== 'number' || !Number.isFinite(diameterMil) || diameterMil <= 0) {
		throw new Error('diameter must be a positive number in mil. Use pcb_create_via_mm for mm input.');
	}
	if (diameterMil < 6 || holeMil < 4) {
		throw new Error(
			`Via dimensions too small: hole=${holeMil} mil, diameter=${diameterMil} mil. ` +
			`EasyEDA's via API uses mil (1 mm ≈ 39.37 mil). Sub-3-mil values typically mean ` +
			`mm was passed by mistake — use pcb_create_via_mm({drill_mm, diameter_mm}) for mm.`,
		);
	}
	if (diameterMil <= holeMil) {
		throw new Error(
			`diameter (${diameterMil} mil) must be greater than holeDiameter (${holeMil} mil) — ` +
			`otherwise there is no annular ring and DRC will reject the via.`,
		);
	}
}
