// Impedance write handlers — apply a computed trace width to every line of a
// net (single-ended) or a diff pair (both nets). The MCP-side analyzer
// (mcp-server/analyzers/impedance.ts) does the Z0 math; this handler only
// touches geometry.
//
// Width units: EasyEDA's line API works in MIL — `lineWidth` on a line getter
// and `pcb_PrimitiveLine.modify(id, {lineWidth})` are both mil. We do NOT
// re-scale here (unlike component pins, which are 10-mil units and need ×10 —
// see trace-obstacles.normalizeComponentPinToMil). Track geometry is already
// mil, matching track.ts which passes lineWidth straight through.

import { flattenStateArray, mapWithConcurrency } from './_utils';
import { checkTraceObstacles } from './trace-obstacles';
import { pourFillHandlers } from './pour-fill';

const DEFAULT_APPLY_TIMEOUT_MS = 8_000;
const REPOUR_TOTAL_BUDGET_MS = 90_000;

const NO_REPOUR_WARNING =
	'Track widths changed. Pours and clearances are NOT auto-updated — re-pour copper and run DRC to confirm clearances/impedance.';
const REPOUR_WARNING =
	'Track widths changed and copper was re-poured. Run DRC to confirm clearances/impedance.';

/** Rebuild every pour after a width change. Never throws — failures are reported. */
async function repourAfterWidthChange(params: Record<string, any>): Promise<any> {
	try {
		return await pourFillHandlers['pcb.pour.repourAll']({
			_timeoutMs: params?._timeoutMs,
			perPourTimeoutMs: params?.perPourTimeoutMs,
			// Without an explicit budget the bridge timer is 120s, so keep the
			// repour loop safely inside it.
			totalTimeoutMs: params?.totalTimeoutMs ?? (params?._timeoutMs ? undefined : REPOUR_TOTAL_BUDGET_MS),
		});
	} catch (err: any) {
		return { error: err?.message ?? String(err), rebuilt: 0 };
	}
}

type LineRow = {
	primitiveId?: string;
	net?: string;
	layer?: any;
	startX?: number;
	startY?: number;
	endX?: number;
	endY?: number;
	lineWidth?: number;
};

// The SDK's EPCB_PrimitiveType.LINE token is the string "Line". The runtime is
// known to also report line primitives as "Track" in getState_PrimitiveType
// (see net.ts), but the getAllPrimitivesByNet *filter* takes the enum value, so
// we pass ['Line']. If the filtered query returns nothing we fall back to the
// unfiltered query and keep rows that look like lines (have start/end + width).
const LINE_TYPE_TOKEN = 'Line';

function idOf(o: any): string | undefined {
	try {
		if (typeof o?.getState_PrimitiveId === 'function') return o.getState_PrimitiveId();
	} catch { /* getter threw */ }
	return o?.primitiveId ?? o?.id ?? o?.globalIndex;
}

function looksLikeLine(row: LineRow): boolean {
	return (
		Number.isFinite(Number(row.startX)) &&
		Number.isFinite(Number(row.startY)) &&
		Number.isFinite(Number(row.endX)) &&
		Number.isFinite(Number(row.endY))
	);
}

/** Fetch all line primitives carrying a net, as flattened plain rows. */
async function getNetLines(net: string): Promise<LineRow[]> {
	let raw: any[] | undefined;
	try {
		raw = await eda.pcb_Net.getAllPrimitivesByNet(net, [LINE_TYPE_TOKEN] as any);
	} catch {
		raw = undefined;
	}
	let rows = flattenStateArray(raw).filter(looksLikeLine);
	if (rows.length === 0) {
		// Fallback: unfiltered query, then keep line-shaped rows. Covers runtime
		// versions whose enum filter rejects the token or returns "Track".
		const all = flattenStateArray(await eda.pcb_Net.getAllPrimitivesByNet(net));
		rows = all.filter(looksLikeLine);
	}
	return rows;
}

function buildObstacleSegments(rows: LineRow[], lineWidth: number) {
	return rows.map((r) => ({
		net: r.net,
		layer: r.layer,
		startX: Number(r.startX),
		startY: Number(r.startY),
		endX: Number(r.endX),
		endY: Number(r.endY),
		lineWidth,
		role: 'impedance_width',
		primitiveId: idOf(r),
	}));
}

function applyTimeoutMs(params: any): number {
	const explicit = Number(params?.timeoutMs);
	const underscore = Number(params?._timeoutMs);
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	if (Number.isFinite(underscore) && underscore > 0) return underscore;
	return DEFAULT_APPLY_TIMEOUT_MS;
}

/**
 * Core single-net width application. Returns the plan (and applies it unless
 * dryRun). Used by both applyWidth and applyDiffPair (once per net).
 */
async function applyWidthToNet(
	net: string,
	lineWidth: number,
	dryRun: boolean,
	timeoutMs: number,
): Promise<any> {
	if (!net || typeof net !== 'string') {
		throw new Error('impedance.applyWidth requires a net name (string).');
	}
	if (!Number.isFinite(lineWidth) || lineWidth <= 0) {
		throw new Error('impedance.applyWidth requires a positive lineWidth (mil).');
	}

	const rows = await getNetLines(net);
	if (rows.length === 0) {
		return {
			net,
			linesAffected: 0,
			newWidthMil: lineWidth,
			applied: false,
			obstacleCheck: null,
			note: `No line/track primitives found on net "${net}". Route the net before applying a width.`,
		};
	}

	const ids = rows.map(idOf).filter((x): x is string => typeof x === 'string' && x.length > 0);
	const oldWidths = Array.from(new Set(rows.map((r) => Number(r.lineWidth)).filter((w) => Number.isFinite(w))));

	// Obstacle gate: widening a trace can newly violate clearance to neighbours.
	// Check the proposed-width segments, ignoring the original lines themselves
	// (they are the ones being modified, so they must not count as obstacles).
	const segments = buildObstacleSegments(rows, lineWidth);
	const obstacleCheck = await checkTraceObstacles({
		segments,
		ignorePrimitiveIds: ids,
		timeoutMs,
	});

	const plan = {
		net,
		linesAffected: rows.length,
		oldWidthsMil: oldWidths,
		newWidthMil: lineWidth,
		primitiveIds: ids.slice(0, 50),
		obstacleCheck,
	};

	if (dryRun) {
		return {
			...plan,
			dryRun: true,
			applied: false,
			warning:
				'Dry run — nothing modified. Applying a wider trace can require re-pouring copper and may change clearances; re-run DRC after apply.',
		};
	}

	let modified = 0;
	await mapWithConcurrency(ids, 4, async (id) => {
		const out = await eda.pcb_PrimitiveLine.modify(id, { lineWidth });
		if (out) modified += 1;
	});

	// Re-fetch to report the achieved width(s).
	const after = await getNetLines(net);
	const newWidths = Array.from(new Set(after.map((r) => Number(r.lineWidth)).filter((w) => Number.isFinite(w))));

	return {
		...plan,
		dryRun: false,
		applied: true,
		modifiedCount: modified,
		beforeWidthsMil: oldWidths,
		afterWidthsMil: newWidths,
		warning: NO_REPOUR_WARNING,
	};
}

/**
 * Estimate center-to-center spacing between two nets' nearest parallel line
 * segments. Best-effort geometry read only (we never move tracks). Returns the
 * minimum mid-to-mid distance between roughly-parallel segment pairs, or null
 * if no parallel pair is found.
 */
function estimateCenterToCenterSpacing(rowsP: LineRow[], rowsN: LineRow[]): number | null {
	const PARALLEL_DOT = 0.965; // ~15° tolerance on direction
	let best: number | null = null;
	for (const a of rowsP) {
		const ax = Number(a.endX) - Number(a.startX);
		const ay = Number(a.endY) - Number(a.startY);
		const aLen = Math.hypot(ax, ay);
		if (aLen <= 1e-6) continue;
		const amx = (Number(a.startX) + Number(a.endX)) / 2;
		const amy = (Number(a.startY) + Number(a.endY)) / 2;
		for (const b of rowsN) {
			const bx = Number(b.endX) - Number(b.startX);
			const by = Number(b.endY) - Number(b.startY);
			const bLen = Math.hypot(bx, by);
			if (bLen <= 1e-6) continue;
			const dot = Math.abs((ax * bx + ay * by) / (aLen * bLen));
			if (dot < PARALLEL_DOT) continue; // not parallel enough
			const bmx = (Number(b.startX) + Number(b.endX)) / 2;
			const bmy = (Number(b.startY) + Number(b.endY)) / 2;
			const d = Math.hypot(amx - bmx, amy - bmy);
			if (best == null || d < best) best = d;
		}
	}
	return best == null ? null : Math.round(best * 100) / 100;
}

export const impedanceHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// Apply a single-ended controlled-impedance trace width to every line of a
	// net. Obstacle-gated; dryRun returns the plan without mutating.
	'pcb.impedance.applyWidth': async (params) => {
		const net = params.net;
		const lineWidth = Number(params.lineWidth);
		const dryRun = params.dryRun === true;
		const timeoutMs = applyTimeoutMs(params);
		const repour = params.repour !== false;
		const result = await applyWidthToNet(net, lineWidth, dryRun, timeoutMs);
		if (!result.applied || !repour) return result;
		const repourResult = await repourAfterWidthChange(params);
		return { ...result, repour: repourResult, warning: REPOUR_WARNING };
	},

	// Apply a diff-pair trace width to BOTH nets and assess center-to-center
	// spacing vs target. We never move tracks — only widths are written; spacing
	// is reported as a warning so the user can decide whether to re-route.
	'pcb.impedance.applyDiffPair': async (params) => {
		const netP = params.netP;
		const netN = params.netN;
		const lineWidth = Number(params.lineWidth);
		const targetSpacingMil = Number.isFinite(Number(params.targetSpacingMil))
			? Number(params.targetSpacingMil)
			: undefined;
		const dryRun = params.dryRun === true;
		const timeoutMs = applyTimeoutMs(params);
		const repour = params.repour !== false;

		if (!netP || !netN || typeof netP !== 'string' || typeof netN !== 'string') {
			throw new Error('impedance.applyDiffPair requires netP and netN (net name strings).');
		}
		if (!Number.isFinite(lineWidth) || lineWidth <= 0) {
			throw new Error('impedance.applyDiffPair requires a positive lineWidth (mil).');
		}

		// Read geometry up front for the spacing assessment (uses pre-apply
		// geometry; widths don't move centerlines so this is valid either way).
		const rowsP = await getNetLines(netP);
		const rowsN = await getNetLines(netN);
		const measuredSpacingMil = estimateCenterToCenterSpacing(rowsP, rowsN);

		const resultP = await applyWidthToNet(netP, lineWidth, dryRun, timeoutMs);
		const resultN = await applyWidthToNet(netN, lineWidth, dryRun, timeoutMs);

		let spacingAssessment: any = {
			measuredCenterToCenterMil: measuredSpacingMil,
			targetSpacingMil: targetSpacingMil ?? null,
		};
		if (measuredSpacingMil == null) {
			spacingAssessment.note =
				'Could not find parallel segments between the two nets to measure spacing. Verify the pair is routed as a coupled pair.';
		} else if (targetSpacingMil != null) {
			const deviation = Math.round((measuredSpacingMil - targetSpacingMil) * 100) / 100;
			const pct = targetSpacingMil > 0 ? Math.abs(deviation) / targetSpacingMil : 0;
			spacingAssessment.deviationMil = deviation;
			spacingAssessment.withinTolerance = pct <= 0.1; // 10%
			if (pct > 0.1) {
				spacingAssessment.warning =
					`Measured center-to-center spacing (${measuredSpacingMil} mil) deviates ${deviation} mil from target ` +
					`${targetSpacingMil} mil (>10%). Tracks were NOT moved — re-route the pair to the target spacing for the diff impedance to hold.`;
			}
		} else {
			spacingAssessment.note = 'No targetSpacingMil given — spacing reported but not assessed.';
		}

		const anyApplied = resultP.applied === true || resultN.applied === true;
		const repourResult = anyApplied && repour ? await repourAfterWidthChange(params) : undefined;

		return {
			netP: resultP,
			netN: resultN,
			spacingAssessment,
			...(repourResult ? { repour: repourResult } : {}),
			warning: repourResult
				? 'Diff-pair widths applied to both nets and copper re-poured; spacing is only measured, never changed. Run DRC.'
				: 'Diff-pair widths applied to both nets; spacing is only measured, never changed. Re-pour copper and run DRC.',
		};
	},
};
