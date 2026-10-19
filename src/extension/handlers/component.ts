import { envelopeStateArray, flattenState, flattenStateArray } from './_utils';
import { normalizePadShapeUnits } from './trace-obstacles';
import { componentPinScale, componentPinSourceUnits } from './pin-units';

export const componentHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.getAll.component': async (params) => {
		const all = await eda.pcb_PrimitiveComponent.getAll(params.layer, params.primitiveLock);
		return envelopeStateArray(all, params);
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

	// Look a footprint up by designator: position, rotation, layer and pads.
	'pcb.component.findByDesignator': async (params) => {
		const want = String(params.designator ?? '').trim();
		if (!want) throw new Error('pcb_get_component requires designator.');
		const all: any[] = (await eda.pcb_PrimitiveComponent.getAll()) ?? [];
		const flat = all.map((c) => flattenState(c));
		let hit = flat.find((c) => c.designator === want) ?? flat.find((c) => String(c.designator ?? '').toUpperCase() === want.toUpperCase());
		if (!hit) {
			const near = flat.map((c) => c.designator).filter((d) => typeof d === 'string' && d.toUpperCase().startsWith(want.replace(/\d+$/, '').toUpperCase())).slice(0, 20);
			throw new Error(`No PCB footprint with designator "${want}" on the active PCB.${near.length ? ` Similar: ${near.join(', ')}` : ''}`);
		}
		let pads: any[] = [];
		let padsError: string | undefined;
		if (params.includePads !== false) {
			try {
				const pinScale = await componentPinScale();
				pads = flattenStateArray(((await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(hit.primitiveId)) ?? []) as any[]).map((pin) => normalizePinToMil(pin, pinScale));
			} catch (err: any) {
				padsError = err?.message ?? String(err);
			}
		}
		return {
			primitiveId: hit.primitiveId,
			designator: hit.designator,
			x: hit.x,
			y: hit.y,
			rotation: hit.rotation,
			layer: hit.layer,
			primitiveLock: hit.primitiveLock,
			footprint: hit.footprint,
			name: hit.name,
			units: 'mil',
			padCount: pads.length,
			pads,
			padsError,
		};
	},

	'pcb.component.getPins': async (params) => {
		const pinScale = await componentPinScale();
		const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(params.primitiveId);
		return flattenStateArray(pins as any[]).map((pin) => normalizePinToMil(pin, pinScale));
	},
};

function normalizePinToMil(pin: any, pinScale: number): any {
	if (!pin || typeof pin !== 'object') return pin;
	const out: Record<string, any> = { ...pin };
	for (const key of ['x', 'y', 'centerX', 'centerY', 'startX', 'startY', 'endX', 'endY']) {
		if (typeof out[key] === 'number' && Number.isFinite(out[key])) out[key] = out[key] * pinScale;
	}
	normalizePadShapeUnits(out);
	out.units = 'mil';
	out.sourceUnits = componentPinSourceUnits(pinScale);
	return out;
}
