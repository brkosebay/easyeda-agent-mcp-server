import { decideComponentYFrame, type FrameDecision, type FrameSample } from './sch-geometry';

// One coordinate frame for every schematic tool.
//
// EasyEDA Pro reports wires (sch_PrimitiveWire) and component pins
// (getAllPinsByPrimitiveId) in the same frame, but component origins
// (sch_PrimitiveComponent get/getAll/create/modify, net flags, net ports) in
// a Y-inverted one on current builds. Agents copy numbers between these
// tools, so component Y values are converted to the pin/wire frame
// ("schematic-canvas") on the way out and back on the way in. The inversion
// is measured from real parts rather than assumed (see decideComponentYFrame).

export const SCH_COORDINATE_SPACE = 'schematic-canvas (same frame as sch_get_all_wires and sch_get_pin_position)';

const FRAME_KEY = '__claude_mcp_sch_component_frame__';
const MAX_SAMPLE_PARTS = 8;

function cached(): FrameDecision | undefined {
	return (globalThis as any)[FRAME_KEY];
}

export async function componentFrame(): Promise<FrameDecision> {
	const hit = cached();
	if (hit?.decided) return hit;
	const samples: FrameSample[] = [];
	try {
		const parts: any[] = (await eda.sch_PrimitiveComponent.getAll('part' as any, false)) ?? [];
		for (const part of parts.slice(0, MAX_SAMPLE_PARTS)) {
			const id = part?.getState_PrimitiveId?.();
			const componentY = Number(part?.getState_Y?.());
			if (!id || !Number.isFinite(componentY)) continue;
			const pins: any[] = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)) ?? [];
			samples.push({ componentY, pinYs: pins.map((p) => Number(p?.getState_Y?.())) });
			const d = decideComponentYFrame(samples);
			if (d.decided && d.votesFlip + d.votesSame >= 3) break;
		}
	} catch {
		// Fall back below; a later call re-measures.
	}
	const decision = decideComponentYFrame(samples);
	// Only a conclusive measurement is cached. Undecided (empty page, all
	// parts on y≈0) uses the fallback observed on EasyEDA Pro 2.2.47.
	if (decision.decided) (globalThis as any)[FRAME_KEY] = decision;
	return decision;
}

/** Multiplier between the component API frame and the canvas frame (self-inverse). */
export async function componentYSign(rawFrame = false): Promise<1 | -1> {
	if (rawFrame) return 1;
	return (await componentFrame()).flip ? -1 : 1;
}

export function forgetComponentFrame(): void {
	delete (globalThis as any)[FRAME_KEY];
}
