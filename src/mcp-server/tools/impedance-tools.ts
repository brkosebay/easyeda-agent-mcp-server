// Controlled-impedance tools. `pcb_impedance_compute` is pure (no bridge call —
// runs the analyzer locally). The two apply tools delegate to the extension's
// impedance handlers. Every result echoes the ASSUMED stackup plus a caveat,
// because the SDK cannot read the real board stackup.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';
import {
	selectStackup,
	solveWidthForImpedance,
	solveDiffPair,
	microstripZ0,
	striplineZ0,
	diffMicrostripZ0,
	diffStriplineZ0,
	milToMm,
	type ImpedanceMode,
	type Stackup,
} from '../analyzers/impedance';

const STACKUP_CAVEAT =
	'Stackup is assumed; confirm with your fab (JLCPCB) impedance calculator.';

const UM_PER_MIL = 25.4;

function buildStackup(args: {
	layerCount: number;
	boardThicknessMm: number;
	mode?: ImpedanceMode;
	er?: number;
	h_dielectric_um?: number;
	t_copper_um?: number;
}): Stackup {
	return selectStackup(args.layerCount, args.boardThicknessMm, {
		mode: args.mode,
		er: args.er,
		h_dielectric_um: args.h_dielectric_um,
		t_copper_um: args.t_copper_um,
	});
}

/** Build the bridge payload, forwarding timeoutMs with the +5000ms bridge margin. */
function applyPayload(params: Record<string, any>): Record<string, any> {
	const timeoutMs = Number(params.timeoutMs);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { ...params };
	return { ...params, _timeoutMs: timeoutMs + 5000 };
}

export function registerImpedanceTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_impedance_compute',
		`Compute a controlled-impedance trace width (and diff-pair spacing) for a target Z0 using IPC-2141 microstrip/stripline formulas. Pure/local — no board access. Covers single-ended and differential (diff-pair) controlled impedance, e.g. 50Ω microstrip, 90Ω USB diff pair, 100Ω stripline. REQUIRES layerCount + boardThicknessMm (no silent default). Always returns assumedStackup + a caveat to verify with your fab; the SDK cannot read real stackup. Keywords: impedance, Z0, controlled-impedance, microstrip, stripline, differential pair, diff-pair, 50ohm, 90ohm, 100ohm.`,
		withDocumentParam({
			layerCount: z.number().int().positive().describe('Board copper layer count (2/4/6). Required — picks the assumed JLCPCB stackup.'),
			boardThicknessMm: z.number().positive().describe('Finished board thickness in mm (1.6, 0.8). Required.'),
			mode: z.enum(['microstrip', 'stripline']).optional().describe('Transmission-line model. Defaults to the preset mode (outer=microstrip, inner=stripline).'),
			targetOhms: z.number().positive().describe('Target characteristic impedance in ohms (single-ended Z0, or differential Zdiff when diff:true).'),
			diff: z.boolean().optional().describe('Solve a differential pair (width + spacing) instead of single-ended width.'),
			er: z.number().positive().optional().describe('Override dielectric constant (Er). Required if no preset matches.'),
			h_dielectric_um: z.number().positive().optional().describe('Override signal-to-plane dielectric height in µm. Required if no preset matches.'),
			t_copper_um: z.number().positive().optional().describe('Override copper thickness in µm (1oz≈35). Required if no preset matches.'),
		}),
		async ({ layerCount, boardThicknessMm, mode, targetOhms, diff, er, h_dielectric_um, t_copper_um }) => {
			const stackup = buildStackup({ layerCount, boardThicknessMm, mode, er, h_dielectric_um, t_copper_um });
			const effectiveMode: ImpedanceMode = mode ?? stackup.mode ?? 'microstrip';

			let payload: Record<string, any>;
			if (diff) {
				const solved = solveDiffPair(targetOhms, stackup, effectiveMode);
				payload = {
					mode: effectiveMode,
					differential: true,
					targetOhms,
					widthMil: solved.widthMil,
					widthMm: milToMm(solved.widthMil),
					spacingMil: solved.spacingMil,
					spacingMm: milToMm(solved.spacingMil),
					achievedOhms: solved.achievedOhms,
				};
			} else {
				const solved = solveWidthForImpedance(targetOhms, stackup, effectiveMode);
				payload = {
					mode: effectiveMode,
					differential: false,
					targetOhms,
					widthMil: solved.widthMil,
					widthMm: milToMm(solved.widthMil),
					achievedOhms: solved.achievedOhms,
				};
			}

			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						...payload,
						assumedStackup: stackup,
						caveat: STACKUP_CAVEAT,
					}),
				}],
			};
		},
	);

	server.tool(
		'pcb_impedance_apply',
		`Apply a single-ended controlled-impedance trace width to every line of a net. If widthMil is omitted but targetOhms + layerCount + boardThicknessMm are given, the width is solved locally (IPC-2141 microstrip/stripline) first. Obstacle-gated: widening a trace that would violate clearance is reported. Use dryRun:true to preview the plan (lines affected, old/new width, obstacle check) without mutating. Copper pours are rebuilt automatically after a successful apply (repour:false opts out); run DRC after. Keywords: impedance, Z0, controlled-impedance, microstrip, stripline, trace width, 50ohm.`,
		withDocumentParam({
			net: z.string().describe('Net whose lines get the new width.'),
			widthMil: z.number().positive().optional().describe('Explicit trace width in mil. Omit to solve from targetOhms + stackup.'),
			targetOhms: z.number().positive().optional().describe('Target Z0 in ohms — used to solve width when widthMil is omitted.'),
			layerCount: z.number().int().positive().optional().describe('Layer count (required to solve from targetOhms).'),
			boardThicknessMm: z.number().positive().optional().describe('Board thickness mm (required to solve from targetOhms).'),
			mode: z.enum(['microstrip', 'stripline']).optional().describe('Transmission-line model when solving from targetOhms.'),
			er: z.number().positive().optional().describe('Override Er when no preset matches.'),
			h_dielectric_um: z.number().positive().optional().describe('Override dielectric height µm when no preset matches.'),
			t_copper_um: z.number().positive().optional().describe('Override copper thickness µm when no preset matches.'),
			dryRun: z.boolean().optional().describe('Preview only — return the plan without modifying tracks.'),
			repour: z.boolean().optional().describe('Rebuild every copper pour after a successful width change (default true). Set false to leave pours stale.'),
				timeoutMs: z.number().int().positive().optional().describe('Per-call timeout (ms) for the obstacle check + apply.'),
		}),
		async ({ widthMil, targetOhms, layerCount, boardThicknessMm, mode, er, h_dielectric_um, t_copper_um, ...rest }) => {
			let lineWidth = Number(widthMil);
			let assumedStackup: Stackup | undefined;
			let solvedAchievedOhms: number | undefined;

			if (!Number.isFinite(lineWidth) || lineWidth <= 0) {
				if (!Number.isFinite(Number(targetOhms))) {
					throw new Error('pcb_impedance_apply needs either widthMil, or targetOhms + layerCount + boardThicknessMm to solve a width.');
				}
				if (!Number.isFinite(Number(layerCount)) || !Number.isFinite(Number(boardThicknessMm))) {
					throw new Error('Solving width from targetOhms requires layerCount and boardThicknessMm.');
				}
				assumedStackup = buildStackup({
					layerCount: Number(layerCount),
					boardThicknessMm: Number(boardThicknessMm),
					mode,
					er,
					h_dielectric_um,
					t_copper_um,
				});
				const effectiveMode: ImpedanceMode = mode ?? assumedStackup.mode ?? 'microstrip';
				const solved = solveWidthForImpedance(Number(targetOhms), assumedStackup, effectiveMode);
				lineWidth = solved.widthMil;
				solvedAchievedOhms = solved.achievedOhms;
			}

			const payload = applyPayload({ ...rest, lineWidth });
			const result = await bridge.send('pcb.impedance.applyWidth', payload);

			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						result,
						appliedWidthMil: lineWidth,
						...(assumedStackup ? { assumedStackup, solvedAchievedOhms, caveat: STACKUP_CAVEAT } : {}),
					}),
				}],
			};
		},
	);

	server.tool(
		'pcb_impedance_apply_diff_pair',
		`Apply a differential controlled-impedance trace width to BOTH nets of a diff pair and assess center-to-center spacing vs target. If lineWidth is omitted but targetOhms + layerCount + boardThicknessMm are given, width AND target spacing are solved locally (IPC-2141 coupled microstrip/stripline). Tracks are never moved — spacing is only measured and warned on. Use dryRun:true to preview. Copper pours are rebuilt automatically after a successful apply (repour:false opts out); run DRC after. Keywords: differential pair, diff-pair, controlled-impedance, 90ohm, 100ohm USB, microstrip, stripline, Zdiff.`,
		withDocumentParam({
			netP: z.string().describe('Positive net of the pair (e.g. USB_DP).'),
			netN: z.string().describe('Negative net of the pair (e.g. USB_DM).'),
			lineWidth: z.number().positive().optional().describe('Per-trace width in mil. Omit to solve from targetOhms + stackup.'),
			targetOhms: z.number().positive().optional().describe('Target differential impedance Zdiff in ohms (e.g. 90 for USB 2.0).'),
			targetSpacingMil: z.number().positive().optional().describe('Target center-to-center spacing (mil) to assess against. Solved from stackup if omitted with targetOhms.'),
			layerCount: z.number().int().positive().optional().describe('Layer count (required to solve from targetOhms).'),
			boardThicknessMm: z.number().positive().optional().describe('Board thickness mm (required to solve from targetOhms).'),
			mode: z.enum(['microstrip', 'stripline']).optional().describe('Transmission-line model when solving from targetOhms.'),
			er: z.number().positive().optional().describe('Override Er when no preset matches.'),
			h_dielectric_um: z.number().positive().optional().describe('Override dielectric height µm when no preset matches.'),
			t_copper_um: z.number().positive().optional().describe('Override copper thickness µm when no preset matches.'),
			dryRun: z.boolean().optional().describe('Preview only — return the plan without modifying tracks.'),
			repour: z.boolean().optional().describe('Rebuild every copper pour after a successful width change (default true). Set false to leave pours stale.'),
				timeoutMs: z.number().int().positive().optional().describe('Per-call timeout (ms).'),
		}),
		async ({ lineWidth, targetOhms, targetSpacingMil, layerCount, boardThicknessMm, mode, er, h_dielectric_um, t_copper_um, ...rest }) => {
			let width = Number(lineWidth);
			let spacing = Number(targetSpacingMil);
			let assumedStackup: Stackup | undefined;
			let solvedAchievedOhms: number | undefined;

			if (!Number.isFinite(width) || width <= 0) {
				if (!Number.isFinite(Number(targetOhms))) {
					throw new Error('pcb_impedance_apply_diff_pair needs either lineWidth, or targetOhms + layerCount + boardThicknessMm to solve geometry.');
				}
				if (!Number.isFinite(Number(layerCount)) || !Number.isFinite(Number(boardThicknessMm))) {
					throw new Error('Solving diff-pair geometry from targetOhms requires layerCount and boardThicknessMm.');
				}
				assumedStackup = buildStackup({
					layerCount: Number(layerCount),
					boardThicknessMm: Number(boardThicknessMm),
					mode,
					er,
					h_dielectric_um,
					t_copper_um,
				});
				const effectiveMode: ImpedanceMode = mode ?? assumedStackup.mode ?? 'microstrip';
				const solved = solveDiffPair(Number(targetOhms), assumedStackup, effectiveMode);
				width = solved.widthMil;
				solvedAchievedOhms = solved.achievedOhms;
				if (!Number.isFinite(spacing) || spacing <= 0) spacing = solved.spacingMil;
			}

			const payload = applyPayload({
				...rest,
				lineWidth: width,
				...(Number.isFinite(spacing) && spacing > 0 ? { targetSpacingMil: spacing } : {}),
			});
			const result = await bridge.send('pcb.impedance.applyDiffPair', payload);

			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						result,
						appliedWidthMil: width,
						targetSpacingMil: Number.isFinite(spacing) && spacing > 0 ? spacing : null,
						...(assumedStackup ? { assumedStackup, solvedAchievedOhms, caveat: STACKUP_CAVEAT } : {}),
					}),
				}],
			};
		},
	);
}

// Silence unused-import noise: the raw Z0 formulas are re-exported here for any
// future tool that wants to report Z0 at a given geometry without solving.
export const _impedanceFormulaRefs = {
	microstripZ0,
	striplineZ0,
	diffMicrostripZ0,
	diffStriplineZ0,
	UM_PER_MIL,
};
