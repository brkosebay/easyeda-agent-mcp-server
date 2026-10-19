// Controlled-impedance solver — pure TypeScript, no deps, MCP-side.
//
// The EasyEDA Pro SDK CANNOT read board stackup (dielectric height, Er, copper
// thickness). So every impedance number here is computed against an *assumed*
// stackup — either a built-in JLCPCB preset or a per-call override. Callers MUST
// surface `assumedStackup` + a "confirm with your fab" caveat to the user; this
// module deliberately never silently defaults a stackup it wasn't given.
//
// Units convention: all geometry inputs to the Z0 formulas are in micrometres
// (µm) so dielectric/copper/width share one unit internally. Widths returned to
// callers (solveWidthForImpedance / solveDiffPair) are in mil, because the EDA
// track APIs work in mil.
//
// Formulas: IPC-2141A microstrip & symmetric stripline closed forms (the same
// family Wheeler/IPC use). These are first-order estimates good to roughly
// ±5–10% vs a 2D field solver — adequate for picking a trace width to hand to a
// fab's own impedance calculator, not a substitute for it.

const MIL_PER_UM = 1 / 25.4; // 1 µm = 1/25.4 mil
const UM_PER_MIL = 25.4; // 1 mil = 25.4 µm

export type ImpedanceMode = 'microstrip' | 'stripline';

export interface Stackup {
	/** Total copper layer count of the board (2/4/6…). */
	layerCount: number;
	/** Nominal finished board thickness in mm (1.6, 0.8…). */
	boardThicknessMm: number;
	/** Dielectric constant (relative permittivity) of the substrate. */
	er: number;
	/** Height of dielectric between the signal layer and its reference plane, in µm. */
	h_dielectric_um: number;
	/** Finished copper thickness of the signal layer, in µm (1oz ≈ 35µm). */
	t_copper_um: number;
	/** Which formula family the preset assumes (outer = microstrip, inner = stripline). */
	mode?: ImpedanceMode;
}

/**
 * Built-in JLCPCB standard-stackup presets, keyed `"${layers}L_${thicknessMm}mm"`.
 *
 * These are *typical* values from JLCPCB's published stackup tables; the exact
 * prepreg/core heights vary by order. Always echo `assumedStackup` and tell the
 * user to verify against JLCPCB's own impedance calculator.
 *
 * Sources / assumptions:
 *  - "2L_1.6mm": single FR-4 core ~1.5mm (≈59 mil) between top & bottom copper,
 *    Er≈4.6 @ low MHz for generic FR-4, 1oz outer copper = 35µm. Outer signal →
 *    microstrip referenced to the opposite plane (when bottom is poured GND).
 *  - "4L_1.6mm": JLCPCB JLC04161H-7628 stackup. Outer-signal to nearest inner
 *    plane prepreg ≈ 0.2104mm (7628 prepreg), Er≈4.05 @ high freq, 1oz outer =
 *    35µm. Modeled as microstrip (top signal over inner GND plane). This is the
 *    common 50Ω single-ended / 90Ω diff target stackup.
 *  - "4L_0.8mm": thin 4-layer. Outer-to-inner dielectric ≈ 0.12mm, Er≈4.05,
 *    1oz outer = 35µm. Microstrip.
 *  - "6L_1.6mm": JLCPCB 6-layer ~1.6mm. Inner signal routed as stripline between
 *    two planes with dielectric ≈ 0.2mm each side; we model the inner-signal
 *    stripline core ≈ 0.2mm half-height, Er≈4.05, inner copper 0.5oz ≈ 17.5µm.
 *    (Outer 6L impedance should use a microstrip override.)
 */
export const JLCPCB_PRESETS: Record<string, Stackup> = {
	'2L_1.6mm': {
		layerCount: 2,
		boardThicknessMm: 1.6,
		er: 4.6,
		h_dielectric_um: 1500, // ~1.5mm core
		t_copper_um: 35, // 1oz
		mode: 'microstrip',
	},
	'4L_1.6mm': {
		layerCount: 4,
		boardThicknessMm: 1.6,
		er: 4.05,
		h_dielectric_um: 210, // 7628 prepreg, outer signal → inner plane
		t_copper_um: 35, // 1oz outer
		mode: 'microstrip',
	},
	'4L_0.8mm': {
		layerCount: 4,
		boardThicknessMm: 0.8,
		er: 4.05,
		h_dielectric_um: 120,
		t_copper_um: 35, // 1oz outer
		mode: 'microstrip',
	},
	'6L_1.6mm': {
		layerCount: 6,
		boardThicknessMm: 1.6,
		er: 4.05,
		h_dielectric_um: 200, // inner-signal stripline core half-height
		t_copper_um: 17.5, // 0.5oz inner copper
		mode: 'stripline',
	},
};

export interface SelectStackupOverride extends Partial<Stackup> {
	target_ohms?: number;
}

/**
 * Pick the closest JLCPCB preset by (layerCount, thickness) and apply any
 * override fields. If no preset matches AND the override doesn't fully specify a
 * usable stackup (er + h_dielectric_um + t_copper_um), throw a clear error —
 * we never invent a dielectric.
 */
export function selectStackup(
	layerCount: number,
	boardThicknessMm: number,
	override?: SelectStackupOverride,
): Stackup {
	const presets = Object.values(JLCPCB_PRESETS);

	// Exact layer-count matches first, then nearest thickness within them.
	const sameLayers = presets.filter((p) => p.layerCount === layerCount);
	let base: Stackup | undefined;
	if (sameLayers.length > 0) {
		base = sameLayers.reduce((best, p) =>
			Math.abs(p.boardThicknessMm - boardThicknessMm) < Math.abs(best.boardThicknessMm - boardThicknessMm)
				? p
				: best,
		);
	}

	const ovr = override ?? {};
	const merged: Partial<Stackup> = {
		layerCount,
		boardThicknessMm,
		er: ovr.er ?? base?.er,
		h_dielectric_um: ovr.h_dielectric_um ?? base?.h_dielectric_um,
		t_copper_um: ovr.t_copper_um ?? base?.t_copper_um,
		mode: ovr.mode ?? base?.mode,
	};

	if (
		!Number.isFinite(merged.er as number) ||
		!Number.isFinite(merged.h_dielectric_um as number) ||
		!Number.isFinite(merged.t_copper_um as number)
	) {
		const available = Object.keys(JLCPCB_PRESETS).join(', ');
		throw new Error(
			`No JLCPCB preset for ${layerCount}L @ ${boardThicknessMm}mm and the override is incomplete. ` +
			`Provide er, h_dielectric_um, and t_copper_um (and optionally mode) in the override, ` +
			`or pick a (layerCount, boardThicknessMm) that matches a preset. Presets: ${available}.`,
		);
	}

	return {
		layerCount,
		boardThicknessMm,
		er: merged.er as number,
		h_dielectric_um: merged.h_dielectric_um as number,
		t_copper_um: merged.t_copper_um as number,
		mode: (merged.mode as ImpedanceMode) ?? (layerCount <= 2 ? 'microstrip' : 'microstrip'),
	};
}

// --- Z0 closed forms (all geometry args in µm) ---------------------------------

/**
 * Single-ended microstrip characteristic impedance (IPC-2141A eq.):
 *   Z0 = 87 / sqrt(Er + 1.41) * ln( 5.98*h / (0.8*w + t) )
 * Valid roughly for 0.1 < w/h < 2.0 and Er 1–15.
 */
export function microstripZ0(w_um: number, h_um: number, t_um: number, er: number): number {
	const denom = 0.8 * w_um + t_um;
	if (denom <= 0 || h_um <= 0) return Number.NaN;
	const arg = (5.98 * h_um) / denom;
	if (arg <= 0) return Number.NaN;
	return (87 / Math.sqrt(er + 1.41)) * Math.log(arg);
}

/**
 * Symmetric (edge-coupled) stripline characteristic impedance (IPC-2141A):
 *   Z0 = 60 / sqrt(Er) * ln( 1.9*b / (0.8*w + t) )
 * where b is the full plane-to-plane dielectric height. Here `h_um` is the
 * dielectric from the signal layer to ONE plane, so the full spacing b = 2*h.
 */
export function striplineZ0(w_um: number, h_um: number, t_um: number, er: number): number {
	const b = 2 * h_um;
	const denom = 0.8 * w_um + t_um;
	if (denom <= 0 || b <= 0) return Number.NaN;
	const arg = (1.9 * b) / denom;
	if (arg <= 0) return Number.NaN;
	return (60 / Math.sqrt(er)) * Math.log(arg);
}

/**
 * Differential microstrip. Use the single-ended Z0 then apply the standard
 * edge-coupling correction:
 *   Zdiff ≈ 2*Z0 * (1 - 0.48 * exp(-0.96 * s/h))
 * s = edge-to-edge spacing, h = dielectric height (all µm).
 */
export function diffMicrostripZ0(w_um: number, s_um: number, h_um: number, t_um: number, er: number): number {
	const z0 = microstripZ0(w_um, h_um, t_um, er);
	return 2 * z0 * (1 - 0.48 * Math.exp((-0.96 * s_um) / h_um));
}

/**
 * Differential stripline. Single-ended stripline Z0 with the same coupling
 * approximation but the stronger stripline coupling constant:
 *   Zdiff ≈ 2*Z0 * (1 - 0.347 * exp(-2.9 * s/h))
 */
export function diffStriplineZ0(w_um: number, s_um: number, h_um: number, t_um: number, er: number): number {
	const z0 = striplineZ0(w_um, h_um, t_um, er);
	return 2 * z0 * (1 - 0.347 * Math.exp((-2.9 * s_um) / h_um));
}

function singleEndedZ0(w_um: number, stackup: Stackup, mode: ImpedanceMode): number {
	return mode === 'stripline'
		? striplineZ0(w_um, stackup.h_dielectric_um, stackup.t_copper_um, stackup.er)
		: microstripZ0(w_um, stackup.h_dielectric_um, stackup.t_copper_um, stackup.er);
}

function diffZ0(w_um: number, s_um: number, stackup: Stackup, mode: ImpedanceMode): number {
	return mode === 'stripline'
		? diffStriplineZ0(w_um, s_um, stackup.h_dielectric_um, stackup.t_copper_um, stackup.er)
		: diffMicrostripZ0(w_um, s_um, stackup.h_dielectric_um, stackup.t_copper_um, stackup.er);
}

// --- Solvers -------------------------------------------------------------------

const MIN_WIDTH_MIL = 3;
const MAX_WIDTH_MIL = 30;
const MIN_SPACING_MIL = 3;
const MAX_SPACING_MIL = 30;
const BISECTION_ITERS = 60;

/**
 * Solve trace width (mil) that yields `targetOhms` single-ended. Bisection over
 * 3..30 mil. Z0 is monotonically DECREASING in width (wider → lower Z), so we
 * narrow the bracket accordingly.
 *
 * Self-check: 4L_1.6mm microstrip (h≈210µm 7628 prepreg, Er≈4.05) @ 50Ω returns
 * ≈ 14.4 mil (≈ 0.366 mm). This matches JLCPCB's own controlled-impedance
 * calculator for the JLC04161H-7628 stackup (~0.3675mm for 50Ω single-ended) —
 * NOT the ~8 mil figure, which applies only to thin (~0.1mm) prepregs.
 */
export function solveWidthForImpedance(
	targetOhms: number,
	stackup: Stackup,
	mode: ImpedanceMode,
): { widthMil: number; achievedOhms: number } {
	let lo = MIN_WIDTH_MIL;
	let hi = MAX_WIDTH_MIL;
	let mid = (lo + hi) / 2;
	let achieved = Number.NaN;

	for (let i = 0; i < BISECTION_ITERS; i++) {
		mid = (lo + hi) / 2;
		achieved = singleEndedZ0(mid * UM_PER_MIL, stackup, mode);
		if (!Number.isFinite(achieved)) {
			// Degenerate width → widen toward hi where the formula is well-behaved.
			lo = mid;
			continue;
		}
		if (achieved > targetOhms) {
			// Too high impedance → need a wider trace.
			lo = mid;
		} else {
			hi = mid;
		}
	}

	return { widthMil: round3(mid), achievedOhms: round2(achieved) };
}

/**
 * Solve a differential pair: outer bisection on edge-to-edge spacing, inner
 * bisection on per-trace width. We hold spacing, solve the width that hits the
 * differential target at that spacing, and converge spacing toward the value
 * where the width is "reasonable" (closest to the single-ended-derived width).
 *
 * In practice the joint target is under-determined (many (w,s) pairs hit one
 * Zdiff), so we anchor spacing to the dielectric-height-scaled default
 * (s ≈ 1× the single-ended width) and report the matching width — a sane,
 * fab-friendly geometry. Callers can override spacing downstream.
 *
 * Self-check: 4L_1.6mm microstrip @ 90Ω diff (h≈210µm prepreg) → width ≈ 15 mil,
 * spacing ≈ 17 mil, achieving 90.0Ω (odd-mode ≈45Ω, hence wider than the 50Ω
 * single-ended trace). Geometry scales with prepreg thickness; thin (~0.1mm)
 * stackups land near the ~8 mil USB-2.0 rule of thumb. Always confirm against
 * the fab's calculator — the stackup here is assumed, not measured.
 */
export function solveDiffPair(
	targetOhms: number,
	stackup: Stackup,
	mode: ImpedanceMode,
): { widthMil: number; spacingMil: number; achievedOhms: number } {
	// Anchor spacing near the single-ended width for the half-target; this keeps
	// the pair coupled enough that the 2*Z0 coupling term is meaningful.
	const seGuess = solveWidthForImpedance(targetOhms / 2, stackup, mode).widthMil;
	const spacingMil = clamp(seGuess, MIN_SPACING_MIL, MAX_SPACING_MIL);
	const s_um = spacingMil * UM_PER_MIL;

	// Inner bisection: width that hits the differential target at this spacing.
	let lo = MIN_WIDTH_MIL;
	let hi = MAX_WIDTH_MIL;
	let mid = (lo + hi) / 2;
	let achieved = Number.NaN;
	for (let i = 0; i < BISECTION_ITERS; i++) {
		mid = (lo + hi) / 2;
		achieved = diffZ0(mid * UM_PER_MIL, s_um, stackup, mode);
		if (!Number.isFinite(achieved)) {
			lo = mid;
			continue;
		}
		if (achieved > targetOhms) {
			lo = mid; // wider trace lowers impedance
		} else {
			hi = mid;
		}
	}

	return { widthMil: round3(mid), spacingMil: round3(spacingMil), achievedOhms: round2(achieved) };
}

// --- helpers -------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

/** Convenience: mil → mm, for echoing geometry in fab-friendly units. */
export function milToMm(mil: number): number {
	return round3((mil * UM_PER_MIL) / 1000);
}

/** Convenience: µm → mil. */
export function umToMil(um: number): number {
	return round3(um * MIL_PER_UM);
}
