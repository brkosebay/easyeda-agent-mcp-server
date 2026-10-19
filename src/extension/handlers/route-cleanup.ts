// Extension-side write handler for in-SDK route geometry cleanup.
//
// Resolves a net's (or the current selection's) Line/Arc primitives, runs the
// pure geometry brain in route-geometry.ts, gates the proposed new geometry
// through the trace-obstacle preflight (ignoring the ORIGINAL primitive ids so
// the trace doesn't collide with the copper it's about to replace), then —
// outside dryRun — CREATES every new primitive FIRST and only afterwards
// DELETES the originals. Create-then-delete means a mid-flight failure leaves a
// transient (DRC-visible) short, never a disconnected net.

import { didTimeOut, flattenStateArray, mapWithConcurrency, normalizeLayer, withTimeout } from './_utils';
import { checkTraceObstacles } from './trace-obstacles';
import {
	analyzeRouteGeometry,
	type CleanOptions,
	type LineSpec,
	type Segment,
} from '../../mcp-server/analyzers/route-geometry';

const DEFAULT_CLEANUP_TIMEOUT_MS = 8_000;

function firstFinite(...values: any[]): number {
	for (const v of values) {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return Number.NaN;
}

function idOf(flat: any): string | undefined {
	const id = flat?.primitiveId ?? flat?.id;
	return id != null ? String(id) : undefined;
}

/** Map a flattened Line primitive to a Segment (straight). */
function lineToSegment(flat: any): Segment | undefined {
	const x1 = firstFinite(flat.startX);
	const y1 = firstFinite(flat.startY);
	const x2 = firstFinite(flat.endX);
	const y2 = firstFinite(flat.endY);
	if (![x1, y1, x2, y2].every(Number.isFinite)) return undefined;
	return {
		x1, y1, x2, y2,
		width: Number.isFinite(Number(flat.lineWidth)) ? Number(flat.lineWidth) : undefined,
		layer: flat.layer,
		net: flat.net,
		id: idOf(flat),
	};
}

/** Map a flattened Arc primitive to a Segment (with signed arcAngle). */
function arcToSegment(flat: any): Segment | undefined {
	const x1 = firstFinite(flat.startX);
	const y1 = firstFinite(flat.startY);
	const x2 = firstFinite(flat.endX);
	const y2 = firstFinite(flat.endY);
	if (![x1, y1, x2, y2].every(Number.isFinite)) return undefined;
	const arcAngle = Number.isFinite(Number(flat.arcAngle)) ? Number(flat.arcAngle) : undefined;
	return {
		x1, y1, x2, y2,
		width: Number.isFinite(Number(flat.lineWidth)) ? Number(flat.lineWidth) : undefined,
		layer: flat.layer,
		net: flat.net,
		id: idOf(flat),
		arcAngle,
	};
}

export const routeCleanupHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.route.cleanup': async (params) => {
		const net: string | undefined = params.net != null ? String(params.net) : undefined;
		const useSelection = !!params.useSelection;
		const dryRun = !!params.dryRun;
		const timeoutMs = Number.isFinite(Number(params.timeoutMs)) && Number(params.timeoutMs) > 0
			? Number(params.timeoutMs)
			: DEFAULT_CLEANUP_TIMEOUT_MS;

		if (!net && !useSelection) {
			throw new Error('pcb.route.cleanup requires net:"NAME" or useSelection:true.');
		}

		const cleanOpts: CleanOptions = {
			snap45: !!params.snap45,
			miter90: !!params.miter90,
			fillet: !!params.fillet,
			minSegMil: Number.isFinite(Number(params.minSegMil)) && Number(params.minSegMil) > 0 ? Number(params.minSegMil) : undefined,
			trimStubs: !!params.trimStubs,
		};

		// 1. Gather line + arc primitives for the target scope. Track which ids
		//    belong to lines vs arcs so each can be deleted via its own API.
		const segments: Segment[] = [];
		const lineIds = new Set<string>();
		const arcIds = new Set<string>();
		let scannedLines = 0;
		let scannedArcs = 0;

		if (useSelection) {
			const selected = flattenStateArray(await eda.pcb_SelectControl.getAllSelectedPrimitives());
			for (const flat of selected) {
				const type = String(flat.primitiveType ?? flat.pcbItemPrimitiveType ?? '');
				if (flat.net != null && net != null && String(flat.net) !== net) continue;
				if (flat.arcAngle != null && Number(flat.arcAngle) !== 0) {
					const seg = arcToSegment(flat);
					if (seg) { segments.push(seg); scannedArcs += 1; if (seg.id) arcIds.add(seg.id); }
				} else if (flat.startX != null && flat.endX != null && (type === 'Line' || type === 'Track' || type === 'Arc' || type === '')) {
					const seg = lineToSegment(flat);
					if (seg) { segments.push(seg); scannedLines += 1; if (seg.id) lineIds.add(seg.id); }
				}
			}
		} else {
			const lines = flattenStateArray(await eda.pcb_PrimitiveLine.getAll(net, undefined, undefined));
			scannedLines = lines.length;
			for (const flat of lines) {
				const seg = lineToSegment(flat);
				if (seg) { segments.push(seg); if (seg.id) lineIds.add(seg.id); }
			}
			const arcs = flattenStateArray(await eda.pcb_PrimitiveArc.getAll(net, undefined, undefined));
			scannedArcs = arcs.length;
			for (const flat of arcs) {
				const seg = arcToSegment(flat);
				if (seg) { segments.push(seg); if (seg.id) arcIds.add(seg.id); }
			}
		}

		if (segments.length === 0) {
			return {
				dryRun,
				net,
				useSelection,
				scannedLines,
				scannedArcs,
				issues: [],
				plannedSpecCount: 0,
				lengthBeforeMil: 0,
				lengthAfterMil: 0,
				note: 'No line/arc primitives found for the requested net/selection.',
				units: 'mil',
			};
		}

		// 2. Run the pure geometry brain.
		const analysis = analyzeRouteGeometry(segments, cleanOpts);
		const originalIds = Array.from(new Set(segments.map((s) => s.id).filter((x): x is string => !!x)));

		// 3. Obstacle-gate the cleaned geometry, ignoring the originals (which
		//    are about to be deleted) so we don't self-collide.
		const obstacleSegments = analysis.cleanedSpecs.map((s) => ({
			net: s.net,
			layer: s.layer,
			startX: s.startX,
			startY: s.startY,
			endX: s.endX,
			endY: s.endY,
			lineWidth: s.lineWidth,
			role: 'route_cleanup',
		}));

		let obstacleCheck: any = { skipped: true, reason: 'no cleaned segments to check' };
		if (obstacleSegments.length > 0) {
			obstacleCheck = await checkTraceObstacles({
				...params,
				net,
				segments: obstacleSegments,
				ignorePrimitiveIds: [
					...(Array.isArray(params.ignorePrimitiveIds) ? params.ignorePrimitiveIds : []),
					...originalIds,
				],
				obstacleCheckTimeoutMs: params.obstacleCheckTimeoutMs ?? timeoutMs,
			});
		}

		// 4a. dryRun — report the plan WITHOUT mutating.
		if (dryRun) {
			return {
				dryRun: true,
				net,
				useSelection,
				scannedLines,
				scannedArcs,
				polylineCount: analysis.polylineCount,
				issues: analysis.issues,
				plannedSpecCount: analysis.cleanedSpecs.length,
				originalCount: originalIds.length,
				lengthBeforeMil: analysis.lengthBeforeMil,
				lengthAfterMil: analysis.lengthAfterMil,
				lengthDeltaMil: round2(analysis.lengthAfterMil - analysis.lengthBeforeMil),
				obstacleCheck,
				units: 'mil',
			};
		}

		// 4b. apply — CREATE all new primitives FIRST, then DELETE originals.
		const createdLineIds: string[] = [];
		let createFailures = 0;
		await mapWithConcurrency(analysis.cleanedSpecs, 4, async (spec: LineSpec) => {
			try {
				const created = await createSpecPrimitive(spec);
				const id = idOf(created);
				if (id) createdLineIds.push(id);
			} catch {
				createFailures += 1;
			}
		});

		let deletedCount = 0;
		if (createFailures === 0 && originalIds.length > 0) {
			const out = await withTimeout(deleteOriginals(Array.from(lineIds), Array.from(arcIds)), timeoutMs);
			if (didTimeOut(out)) {
				throw new Error(
					`Route cleanup created ${createdLineIds.length} new primitive(s) but deleting the ${originalIds.length} original(s) did not complete within ${timeoutMs}ms. ` +
					`The net now carries BOTH old and new copper (a transient short visible to DRC). Re-run delete or raise timeoutMs.`,
				);
			}
			deletedCount = out as number;
		}

		return {
			dryRun: false,
			net,
			useSelection,
			scannedLines,
			scannedArcs,
			polylineCount: analysis.polylineCount,
			issues: analysis.issues,
			before: { primitiveCount: originalIds.length },
			after: { primitiveCount: createdLineIds.length, createFailures },
			deletedCount,
			lengthBeforeMil: analysis.lengthBeforeMil,
			lengthAfterMil: analysis.lengthAfterMil,
			lengthDeltaMil: round2(analysis.lengthAfterMil - analysis.lengthBeforeMil),
			obstacleCheck,
			note: createFailures > 0
				? 'Some new primitives failed to create — originals were NOT deleted to avoid breaking the net. Inspect and re-run.'
				: 'Created new geometry, then deleted originals (create-then-delete).',
			units: 'mil',
		};
	},
};

/** Create one spec — an arc when `arcAngle` is present (sign preserved), else a line. */
async function createSpecPrimitive(spec: LineSpec): Promise<any> {
	const layer = normalizeLayer(spec.layer);
	const net = String(spec.net ?? '');
	if (spec.arcAngle != null && Math.abs(spec.arcAngle) > 1e-9) {
		// pcb_PrimitiveArc.create(net, layer, startX, startY, endX, endY, arcAngle, lineWidth, interactiveMode?, primitiveLock?)
		return eda.pcb_PrimitiveArc.create(
			net,
			layer,
			spec.startX,
			spec.startY,
			spec.endX,
			spec.endY,
			spec.arcAngle,
			spec.lineWidth,
		);
	}
	// pcb_PrimitiveLine.create(net, layer, startX, startY, endX, endY, lineWidth)
	return eda.pcb_PrimitiveLine.create(
		net,
		layer,
		spec.startX,
		spec.startY,
		spec.endX,
		spec.endY,
		spec.lineWidth,
	);
}

/** Delete originals: lines via the Line API, arcs via the Arc API. */
async function deleteOriginals(lineIds: string[], arcIds: string[]): Promise<number> {
	let deleted = 0;
	if (lineIds.length > 0) {
		try {
			const ok = await eda.pcb_PrimitiveLine.delete(lineIds);
			if (ok) deleted += lineIds.length;
		} catch {/* ignore */}
	}
	if (arcIds.length > 0) {
		try {
			const ok = await eda.pcb_PrimitiveArc.delete(arcIds);
			if (ok) deleted += arcIds.length;
		} catch {/* ignore */}
	}
	return deleted;
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
