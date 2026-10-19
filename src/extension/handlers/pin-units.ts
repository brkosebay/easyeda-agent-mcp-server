// Component-pin coordinate units differ by EasyEDA Pro version:
// `pcb_PrimitiveComponent.getAllPinsByPrimitiveId` returned x/y in 10-mil
// units on 2.x, and returns mil — like every other PCB primitive — on 3.x
// (verified on 3.2.206: track endpoints land exactly on the raw pin centers).
// Only the coordinates moved; the `pad` tuple is still mil and the `hole`
// tuple still 10-mil, so normalizePadShapeUnits() is unchanged.
//
// Instead of guessing from a version string, compare pins against their
// component origin, which is mil on both versions: pins sit within the
// footprint, so the wrong scale puts them roughly 10x (or 1/10) too far away.

const MIN_ORIGIN_DISTANCE_MIL = 100;
const SAMPLE_COMPONENTS = 6;
let cachedScale: 1 | 10 | undefined;

const finite = (value: unknown): number | undefined => {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
};
function read(primitive: any, getter: string, field: string): unknown {
	try { if (typeof primitive?.[getter] === 'function') return primitive[getter](); } catch {/* */}
	return primitive?.[field];
}

/**
 * Multiplier that converts raw component-pin x/y to mil on this runtime:
 * 10 on EasyEDA Pro 2.x, 1 on 3.x. Probed once, then cached. A board with no
 * usable component returns 1 without caching (there is nothing to convert).
 */
export async function componentPinScale(): Promise<1 | 10> {
	if (cachedScale) return cachedScale;
	let votesMil = 0, votesTenMil = 0, sampled = 0;
	const components: any[] = (await eda.pcb_PrimitiveComponent.getAll().catch(() => [])) ?? [];
	for (const component of components) {
		if (sampled >= SAMPLE_COMPONENTS) break;
		const cx = finite(read(component, 'getState_X', 'x')), cy = finite(read(component, 'getState_Y', 'y'));
		const id = read(component, 'getState_PrimitiveId', 'primitiveId');
		if (cx == null || cy == null || !id || Math.hypot(cx, cy) < MIN_ORIGIN_DISTANCE_MIL) continue;
		const pins: any[] = (await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(String(id)).catch(() => [])) ?? [];
		let counted = false;
		for (const pin of pins) {
			const px = finite(read(pin, 'getState_X', 'x')), py = finite(read(pin, 'getState_Y', 'y'));
			if (px == null || py == null) continue;
			const asMil = Math.hypot(px - cx, py - cy), asTenMil = Math.hypot(px * 10 - cx, py * 10 - cy);
			if (asMil < asTenMil) votesMil++;
			else if (asTenMil < asMil) votesTenMil++;
			counted = true;
		}
		if (counted) sampled++;
	}
	if (votesMil + votesTenMil === 0) return 1;
	cachedScale = votesTenMil > votesMil ? 10 : 1;
	return cachedScale;
}

/** Human-readable provenance for normalized pin records. */
export function componentPinSourceUnits(scale: number): string {
	return scale === 10
		? 'EasyEDA component-pin units (10 mil); normalized by MCP'
		: 'EasyEDA component-pin units (mil, EasyEDA Pro 3.x)';
}
