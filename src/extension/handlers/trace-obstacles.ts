import { didTimeOut, flattenState, flattenStateArray, mapWithConcurrency, normalizeLayer, withTimeout } from './_utils';
import { ASSUMED_ZERO_ORIGIN_TRANSFORM, resolveCanvasTransform, type PolygonTransform } from './pour-fill';
import { componentPinScale } from './pin-units';
import {
	clearanceResolverFromRules,
	explicitClearanceMil,
	explicitClearanceResolver,
	type ClearanceResolver,
} from '../../shared/drc-rules';

// Rule parsing moved to src/shared/drc-rules.ts; re-exported so existing
// importers (board-context, route-path, via, smoke tests) keep working.
export {
	clearanceBetween,
	clearanceForKind,
	clearanceResolverFromRules,
	resolverForRule,
	resolveTrackWidth,
	resolveViaSize,
	trackWidthForNet,
	viaSizeForNet,
	type ClearanceDecision,
	type ClearanceKind,
	type ClearanceResolver,
	type ClearanceRule,
	type TrackWidthRule,
	type ViaSizeRule,
} from '../../shared/drc-rules';

export type TraceSegmentSpec = {
	net?: string;
	layer?: any;
	startX: number;
	startY: number;
	endX: number;
	endY: number;
	lineWidth?: number;
	role?: string;
	primitiveId?: string;
};

type Point = { x: number; y: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type PadObstacle = {
	type: 'pad' | 'component_pad';
	center: Point;
	polygon: Point[];
	bounds: Bounds;
	shape: 'rect' | 'ellipse' | 'polygon';
	widthMil: number;
	heightMil: number;
	rotationDeg: number;
	/** Through-hole (drilled) pad: copper on every layer, clearance from the "TH Pad" row. */
	drilled: boolean;
	net?: string;
	layer?: any;
	primitiveId?: string;
	componentPrimitiveId?: string;
	reference?: string;
	padNumber?: string;
};
type Obstacle = {
	type: 'track' | 'via' | 'pad' | 'component_pad' | 'component_body' | 'pour' | 'keepout' | 'board_boundary';
	severity: 'blocker' | 'warning';
	reason: string;
	net?: string;
	layer?: any;
	primitiveId?: string;
	componentPrimitiveId?: string;
	reference?: string;
	padNumber?: string;
	distanceMil?: number;
	clearanceRequiredMil?: number;
	clearanceSource?: string;
	point?: Point;
	bounds?: Bounds;
	segmentIndex: number;
	routeSegment: TraceSegmentSpec;
};

type PolygonObstacle = {
	type: 'pour' | 'keepout';
	net?: string;
	layer?: any;
	primitiveId?: string;
	name?: string;
	bounds?: Bounds;
	polygon?: Point[];
};

// Unit conventions for every source this checker reads. These were re-derived
// empirically against a live board by reading the SAME pad primitive through
// both APIs (component pin `e64e19` on connector J1, and the standalone
// pcb_PrimitivePad record for the same id) — see the table below.
//
//   field                         pcb_PrimitivePad.getAll   getAllPinsByPrimitiveId
//   ---------------------------   -----------------------   -----------------------
//   x / y / centerX / …           mil (169.0019)            10-mil units (16.90019)
//   pad  ["ELLIPSE", w, h]        mil (66.929)              mil (66.929)
//   hole ["ROUND", w, h]          10-mil units (3.937)      10-mil units (3.937)
//
// So the `pad` and `hole` tuples carry IDENTICAL raw numbers on both APIs and
// do NOT follow the coordinate convention of the record that contains them:
//   - `pad` is already mil on every path — scaling it is what produced the
//     ~10x inflated obstacle bounds (bug #18).
//   - `hole` is 10-mil units on every path — including the "mil" standalone-pad
//     path, which is why holes read 1/10 there (bug #13).
// normalizePadShapeUnits() encodes exactly that: pad untouched, hole x10. It is
// therefore safe (and required) on component-pin AND standalone-pad records.
//
//   - eda.pcb_PrimitiveLine / pcb_PrimitiveVia / pcb_PrimitivePour /
//     pcb_PrimitiveRegion getters and their polygon sources report mil directly.
//   - Component-pin *coordinates* were 10-mil units on EasyEDA 2.x and are mil
//     on 3.x; COMPONENT_PAD_COORD_KEYS are scaled by componentPinScale().
//     Hole extents (COMPONENT_PAD_HOLE_KEYS) stay COMPONENT_PAD_UNIT_MIL.
//   - Caller-supplied segments, clearances and margins are mil.
// Everything this module returns — segment coordinates included — is therefore mil.
const DEFAULT_OBSTACLE_CHECK_TIMEOUT_MS = 3_000;
const DEFAULT_LINE_WIDTH_MIL = 10;
const COMPONENT_PAD_UNIT_MIL = 10;
const FALLBACK_PAD_SIZE_MIL = 36;
const FALLBACK_VIA_DIAMETER_MIL = 24;
const MULTI_LAYER_ID = 12;
// Copper exactly at the required clearance is legal (EasyEDA's DRC agrees);
// only a gap below it — or touching copper — is a violation. Without the
// tolerance a pair routed at gap == Safe Spacing blocked itself.
export const CLEARANCE_TOLERANCE_MIL = 1e-3;
export function violatesClearance(distanceMil: number, requiredMil: number): boolean {
	return distanceMil <= 0 || distanceMil < requiredMil - CLEARANCE_TOLERANCE_MIL;
}
// Coordinate-family keys only. Pad-extent keys (width/height/sizeX/sizeY/
// diameter/padWidth/padHeight) are deliberately NOT here: they are the
// fallback source for the `pad` tuple and share its mil convention, so scaling
// them would reintroduce the inflated-bounds bug. Hole-extent keys stay,
// matching the `hole` tuple's 10-mil convention.
// Coordinates follow componentPinScale() (10-mil on EasyEDA 2.x, mil on 3.x);
// hole extents stayed 10-mil on 3.x, matching the `hole` tuple.
const COMPONENT_PAD_COORD_KEYS = ['x', 'y', 'centerX', 'centerY', 'startX', 'startY', 'endX', 'endY'];
const COMPONENT_PAD_HOLE_KEYS = ['holeDiameter', 'holeWidth', 'holeHeight', 'holeOffsetX', 'holeOffsetY'];

export const traceObstacleHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.trace.checkObstacles': async (params) => checkTraceObstacles(params),
};

export async function enforceTraceObstacles(params: Record<string, any>): Promise<any | undefined> {
	const enabled = firstDefined(params.obstacleCheck, params.checkObstacles, params.preflight) !== false;
	if (!enabled) return undefined;

	const result = await checkTraceObstacles(params);
	const failOnObstacle = firstDefined(params.failOnObstacle, params.failOnObstruction, true) !== false;
	if (failOnObstacle && result.blockingObstacleCount > 0) {
		const sample = result.obstacles.slice(0, 5).map((o: Obstacle) => ({
			type: o.type,
			reason: o.reason,
			net: o.net,
			reference: o.reference,
			padNumber: o.padNumber,
			distanceMil: o.distanceMil,
			clearanceRequiredMil: o.clearanceRequiredMil,
			clearanceSource: o.clearanceSource,
			segmentIndex: o.segmentIndex,
		}));
		throw new Error(
			`Trace obstacle preflight found ${result.blockingObstacleCount} blocking obstacle(s). ` +
			`Use pcb_check_trace_obstacles for details, route around them, or pass failOnObstacle:false only if intentional. ` +
			`Sample: ${JSON.stringify(sample)}`,
		);
	}
	return result;
}

export async function checkTraceObstacles(params: Record<string, any>): Promise<any> {
	const timeoutMs = numberOrDefault(firstDefined(params.obstacleCheckTimeoutMs, params.timeoutMs, params._timeoutMs), DEFAULT_OBSTACLE_CHECK_TIMEOUT_MS);
	const out = await withTimeout(runTraceObstacleCheck(params), timeoutMs);
	if (didTimeOut(out)) {
		throw new Error(`Trace obstacle preflight did not complete within ${timeoutMs}ms. Use a tighter region/segment set or raise obstacleCheckTimeoutMs.`);
	}
	return out;
}

async function runTraceObstacleCheck(params: Record<string, any>): Promise<any> {
	const segments = normalizeSegments(params);
	if (segments.length === 0) throw new Error('Trace obstacle check needs either segments:[...] or startX/startY/endX/endY.');

	const clearance = await buildClearanceResolver(params, segments);
	const ignoreSameNet = params.ignoreSameNet !== false;
	const includeLines = params.includeLines !== false;
	const includeVias = params.includeVias !== false;
	const includePads = params.includePads !== false;
	const includeComponentPads = includePads && params.includeComponentPads !== false;
	const includeStandalonePads = includePads && params.includeStandalonePads !== false;
	const includeComponentBodies = !!params.includeComponentBodies;
	const includePours = params.includePours !== false;
	// A pour is not an obstacle: its copper re-flows around new tracks on the
	// next repour. Crossing one is reported as a plane-cut warning. Treating the
	// pour OUTLINE as a wall flagged every route on boards with board-wide
	// planes (all four GND pours here span the whole outline).
	const poursBlock = params.poursBlock === true;
	const includeKeepouts = params.includeKeepouts !== false;
	const includeBoardBoundary = params.includeBoardBoundary !== false;
	const maxObstacles = Math.max(1, Math.floor(Number(params.maxObstacles ?? 75)));
	const ignoreIds = new Set<string>(
		Array.isArray(params.ignorePrimitiveIds)
			? params.ignorePrimitiveIds.map((id: any) => String(id))
			: [],
	);

	const routeBounds = expandBounds(boundsForSegments(segments), numberOrDefault(params.scanMarginMil, 250));
	const layerSet = new Set(segments.map((s) => normalizeLayerSafe(s.layer)).filter((x) => x != null).map(String));
	const obstacles: Obstacle[] = [];
	const checked = {
		segments: segments.length,
		tracks: 0,
		tracksByLayer: {} as Record<string, number>,
		vias: 0,
		standalonePads: 0,
		componentPadDuplicatesSkipped: 0,
		components: 0,
		componentPads: 0,
		componentBodies: 0,
		pours: 0,
		regions: 0,
		keepouts: 0,
		boardOutlineSegments: 0,
	};

	if (includeBoardBoundary) {
		const outlineLines = flattenStateArray(await eda.pcb_PrimitiveLine.getAll(undefined, 11, undefined).catch(() => []));
		checked.boardOutlineSegments = outlineLines.length;
		const outlineBounds = boundsForPoints(outlineLines.flatMap((line) => [
			{ x: Number(line.startX), y: Number(line.startY) },
			{ x: Number(line.endX), y: Number(line.endY) },
		]));
		if (outlineBounds) {
			forEachRouteHit(segments, (segment, index) => {
				const start = segStart(segment);
				const end = segEnd(segment);
				if (!pointInBounds(start, outlineBounds) || !pointInBounds(end, outlineBounds) || !lineIntersectsRect(start, end, outlineBounds)) {
					obstacles.push({
						type: 'board_boundary',
						severity: 'blocker',
						reason: 'trace leaves the board-outline bounds',
						layer: segment.layer,
						bounds: outlineBounds,
						point: midpoint(start, end),
						segmentIndex: index,
						routeSegment: segment,
					});
				}
			});
		}
	}

	if (includeLines) {
		// Fetch tracks once per distinct segment layer (a layer-less segment, a
		// layer that is not a numeric id, or a MULTI (12) segment — a via disc
		// checked as a zero-length segment spans every copper layer — needs every
		// layer; fetching "layer 12" alone returned no tracks, so vias saw none).
		// The per-layer fetch is only a prefetch: each segment is compared below
		// ONLY against tracks its layer touches (layersTouch), so a mixed-layer
		// segment list never checks a bottom segment against top copper.
		const layers = Array.from(layerSet);
		const needsAllLayers = layers.length === 0
			|| segments.some((s) => s.layer == null)
			|| layers.some((l) => !Number.isFinite(Number(l)) || String(l) === String(MULTI_LAYER_ID));
		const fetchLayers: Array<number | undefined> = needsAllLayers ? [undefined] : layers.map(Number);
		for (const layer of fetchLayers) {
			const lines = flattenStateArray(await eda.pcb_PrimitiveLine.getAll(undefined, layer, undefined));
			checked.tracks += lines.length;
			for (const line of lines) {
				const obstacleId = stringOrUndefined(firstDefined(line.primitiveId, line.id));
				if (obstacleId && ignoreIds.has(obstacleId)) continue;
				const obstacleLayer = normalizeLayerSafe(line.layer);
				if (obstacleLayer != null && layerSet.size > 0 && !needsAllLayers && !layerSet.has(String(obstacleLayer))) continue;
				if (obstacleLayer != null) {
					const key = String(obstacleLayer);
					checked.tracksByLayer[key] = (checked.tracksByLayer[key] ?? 0) + 1;
				}
				const obstacleSegment = {
					startX: Number(line.startX),
					startY: Number(line.startY),
					endX: Number(line.endX),
					endY: Number(line.endY),
				};
				if (!isFiniteSegment(obstacleSegment)) continue;
				if (!segmentTouchesBounds(obstacleSegment, routeBounds)) continue;
				forEachRouteHit(segments, (segment, index) => {
					// Tracks are single-layer copper: only same-layer tracks can block.
					if (!layersTouch(segment.layer, obstacleLayer)) return;
					if (samePhysicalSegment(segment, obstacleSegment)) return;
					if (ignoreSameNet && netsEqual(segment.net, line.net)) return;
					const centerDistance = segmentDistance(segStart(segment), segEnd(segment), segStart(obstacleSegment), segEnd(obstacleSegment));
					const d = Math.max(0, centerDistance - segmentHalfWidth(segment) - numberOrDefault(line.lineWidth, DEFAULT_LINE_WIDTH_MIL) / 2);
					// The larger of the two nets' rules (EasyEDA's DRC), not the routed net's alone.
					const decision = clearance.between(segment.net, stringOrUndefined(line.net), 'track');
					const required = decision.clearanceMil;
					if (violatesClearance(d, required)) {
						obstacles.push({
							type: 'track',
							severity: 'blocker',
							reason: netsEqual(segment.net, line.net) ? 'same-net track overlap' : 'crosses or violates clearance to another track',
							net: stringOrUndefined(line.net),
							layer: obstacleLayer,
							primitiveId: obstacleId,
							distanceMil: round(d, 2),
							clearanceRequiredMil: round(required, 2),
							clearanceSource: decision.source,
							point: nearestPointOnSegment(segStart(segment), segEnd(segment), midpoint(segStart(obstacleSegment), segEnd(obstacleSegment))),
							segmentIndex: index,
							routeSegment: segment,
						});
					}
				});
			}
		}
	}

	if (includeVias) {
		const vias = flattenStateArray(await eda.pcb_PrimitiveVia.getAll(undefined, undefined));
		checked.vias = vias.length;
		for (const via of vias) {
			const obstacleId = stringOrUndefined(firstDefined(via.primitiveId, via.id));
			if (obstacleId && ignoreIds.has(obstacleId)) continue;
			const x = Number(via.x);
			const y = Number(via.y);
			if (!Number.isFinite(x) || !Number.isFinite(y) || !pointInBounds({ x, y }, routeBounds)) continue;
			forEachRouteHit(segments, (segment, index) => {
				if (ignoreSameNet && netsEqual(segment.net, via.net)) return;
				const viaRadiusMil = numberOrDefault(via.diameter, FALLBACK_VIA_DIAMETER_MIL) / 2;
				const edgeDistance = Math.max(0, pointToSegmentDistance({ x, y }, segStart(segment), segEnd(segment)) - viaRadiusMil - segmentHalfWidth(segment));
				const decision = clearance.between(segment.net, stringOrUndefined(via.net), 'via');
				const required = decision.clearanceMil;
				if (violatesClearance(edgeDistance, required)) {
					obstacles.push({
						type: 'via',
						severity: 'blocker',
						reason: netsEqual(segment.net, via.net) ? 'same-net via overlap' : 'crosses or violates clearance to a via',
						net: stringOrUndefined(via.net),
						primitiveId: obstacleId,
						distanceMil: round(edgeDistance, 2),
						clearanceRequiredMil: round(required, 2),
						clearanceSource: decision.source,
						point: { x, y },
						segmentIndex: index,
						routeSegment: segment,
					});
				}
			});
		}
	}

	// Component pads checked below; pcb_PrimitivePad.getAll() returns them again.
	const componentPadIdsChecked = new Set<string>();
	if (includeComponentPads || includeComponentBodies) {
		const componentRows = await loadNearbyComponents(routeBounds, params);
		checked.components = componentRows.length;
		const componentBodies = new Map<string, { pins: any[]; reference?: string }>();
		const pinScale = await componentPinScale();
		await mapWithConcurrency(componentRows, Math.max(1, Math.min(6, Math.floor(Number(params.pinConcurrency ?? 4)))), async (component) => {
			const componentPrimitiveId = stringOrUndefined(firstDefined(component.primitiveId, component.id));
			if (!componentPrimitiveId) return;
			const reference = stringOrUndefined(component.designator);
			const rawPins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentPrimitiveId);
			const pins = flattenStateArray(rawPins as any[]).map((pin) => normalizeComponentPinToMil(pin, pinScale));
			componentBodies.set(componentPrimitiveId, { pins, reference });
			if (includeComponentPads) {
				for (const pin of pins) {
					checked.componentPads += 1;
					const pinId = stringOrUndefined(firstDefined(pin?.primitiveId, pin?.id));
					if (pinId) componentPadIdsChecked.add(pinId);
					pushPadObstacles(
						obstacles,
						segments,
						padToObstacle(pin, 'component_pad', componentPrimitiveId, reference),
						routeBounds,
						clearance,
						ignoreSameNet,
						ignoreIds,
					);
				}
			}
		});

		if (includeComponentBodies) {
			for (const [componentPrimitiveId, row] of componentBodies) {
				const pinPoints = row.pins
					.map((pin) => ({ x: firstFinite(pin.x, pin.centerX), y: firstFinite(pin.y, pin.centerY) }))
					.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
				const body = boundsForPoints(pinPoints);
				if (!body) continue;
				checked.componentBodies += 1;
				const expandedBody = expandBounds(body, numberOrDefault(params.componentBodyPaddingMil, 35));
				if (!boundsOverlap(expandedBody, routeBounds)) continue;
				forEachRouteHit(segments, (segment, index) => {
					if (lineIntersectsRect(segStart(segment), segEnd(segment), expandedBody)) {
						obstacles.push({
							type: 'component_body',
							severity: 'warning',
							reason: 'trace crosses approximate component body bounding box',
							componentPrimitiveId,
							reference: row.reference,
							segmentIndex: index,
							routeSegment: segment,
						});
					}
				});
			}
		}
	}

	if (includeStandalonePads) {
		const pads = flattenStateArray(await eda.pcb_PrimitivePad.getAll(undefined, undefined, undefined));
		for (const pad of pads) {
			// The same pad was already checked as a component_pad (same primitiveId);
			// a pad of a component outside the nearby-component scan is still checked here.
			const padId = stringOrUndefined(firstDefined(pad?.primitiveId, pad?.id));
			if (padId && componentPadIdsChecked.has(padId)) {
				checked.componentPadDuplicatesSkipped += 1;
				continue;
			}
			checked.standalonePads += 1;
			pushPadObstacles(obstacles, segments, padToObstacle(pad, 'pad'), routeBounds, clearance, ignoreSameNet, ignoreIds);
		}
	}

	// Pour/region outlines are stored Y-down relative to the data origin;
	// tracks and pads are canvas Y-up (see pour-fill COORDINATE_SPACE).
	const polygonTransform = includePours || includeKeepouts ? await polygonCanvasTransform() : ASSUMED_ZERO_ORIGIN_TRANSFORM;

	if (includePours) {
		const rawPours = await eda.pcb_PrimitivePour.getAll(undefined, undefined, undefined).catch(() => []);
		const flatPours = flattenStateArray(rawPours as any[]);
		checked.pours = flatPours.length;
		for (let i = 0; i < flatPours.length; i++) {
			pushPolygonObstacles(
				obstacles,
				segments,
				normalizePolygonObstacle(flatPours[i], (rawPours as any[])[i], 'pour', polygonTransform),
				routeBounds,
				clearance,
				ignoreSameNet,
				ignoreIds,
				poursBlock ? 'blocker' : 'warning',
			);
		}
	}

	if (includeKeepouts) {
		const regionApi = (eda as any).pcb_PrimitiveRegion;
		const rawRegions = regionApi?.getAll
			? await regionApi.getAll(undefined, undefined, undefined).catch(() => [])
			: [];
		const flatRegions = flattenStateArray(rawRegions as any[]);
		checked.regions = flatRegions.length;
		for (let i = 0; i < flatRegions.length; i++) {
			const flat = flatRegions[i];
			if (!isKeepoutRegion(flat)) continue;
			checked.keepouts += 1;
			pushPolygonObstacles(
				obstacles,
				segments,
				normalizePolygonObstacle(flat, (rawRegions as any[])[i], 'keepout', polygonTransform),
				routeBounds,
				clearance,
				false,
				ignoreIds,
			);
		}
	}

	const deduped = dedupeObstacles(obstacles);
	const blockers = deduped.filter((o) => o.severity === 'blocker');
	return {
		clear: blockers.length === 0,
		obstacleCount: deduped.length,
		blockingObstacleCount: blockers.length,
		warningCount: deduped.length - blockers.length,
		checked,
		segments,
		obstacles: deduped.slice(0, maxObstacles),
		truncated: deduped.length > maxObstacles,
		units: 'mil',
		unitsNote: 'Every coordinate and distance in this response — segment coordinates included — is mil. Board primitives are read in mil; component pads are converted from EasyEDA 10-mil component units.',
		clearanceMil: clearance.summary.clearanceMil,
		clearanceSource: clearance.summary.clearanceSource,
		clearanceRules: clearance.summary,
		note: 'Default check blocks different-net tracks/vias/pads/pours, keepout candidates, and board-outline escapes. Each obstacle needs the larger of both nets\' rules (its clearanceSource names the deciding one). Same-net copper is ignored by default; pass ignoreSameNet:false to audit overlaps too.',
	};
}

function normalizeSegments(params: Record<string, any>): TraceSegmentSpec[] {
	const raw = Array.isArray(params.segments) && params.segments.length > 0
		? params.segments
		: [params];
	return raw
		.map((segment: any): TraceSegmentSpec | undefined => {
			const layer = firstDefined(segment.layer, params.layer, params.layer_preference, params.layerPreference);
			const net = stringOrUndefined(firstDefined(segment.net, params.net));
			const out: TraceSegmentSpec = {
				net,
				// Throwing normalizeLayer (not the Safe variant): an unrecognised
				// segment layer like "BOT" must fail loudly instead of matching no
				// copper and reporting a false clear:true.
				layer: layer != null ? normalizeLayer(layer) : undefined,
				startX: Number(firstDefined(segment.startX, segment.x1, segment.fromX)),
				startY: Number(firstDefined(segment.startY, segment.y1, segment.fromY)),
				endX: Number(firstDefined(segment.endX, segment.x2, segment.toX)),
				endY: Number(firstDefined(segment.endY, segment.y2, segment.toY)),
				lineWidth: numberOrDefault(firstDefined(segment.lineWidth, segment.width_mil, segment.trace_width_mil, params.lineWidth), DEFAULT_LINE_WIDTH_MIL),
				role: stringOrUndefined(segment.role),
				primitiveId: stringOrUndefined(segment.primitiveId),
			};
			if (!isFiniteSegment(out)) return undefined;
			return out;
		})
		.filter((segment): segment is TraceSegmentSpec => !!segment);
}

function loadNearbyComponents(routeBounds: Bounds, params: Record<string, any>): Promise<any[]> {
	return eda.pcb_PrimitiveComponent.getAll().then((rawComponents: any[]) => {
		const all = flattenStateArray(rawComponents);
		const scanAll = !!params.scanAllComponents;
		const max = Math.max(1, Math.floor(Number(params.maxComponentScan ?? 120)));
		const margin = numberOrDefault(params.componentScanMarginMil, 800);
		const scanBounds = expandBounds(routeBounds, margin);
		const filtered = scanAll
			? all
			: all.filter((c) => {
				const x = Number(c.x);
				const y = Number(c.y);
				return Number.isFinite(x) && Number.isFinite(y) && pointInBounds({ x, y }, scanBounds);
			});
		return filtered.slice(0, max);
	});
}

function pushPadObstacles(
	obstacles: Obstacle[],
	segments: TraceSegmentSpec[],
	pad: PadObstacle | undefined,
	routeBounds: Bounds,
	clearance: ClearanceResolver,
	ignoreSameNet: boolean,
	ignoreIds: Set<string>,
): void {
	if (!pad) return;
	if (pad.primitiveId && ignoreIds.has(pad.primitiveId)) return;
	if (pad.componentPrimitiveId && ignoreIds.has(pad.componentPrimitiveId)) return;
	if (!boundsOverlap(pad.bounds, routeBounds)) return;
	forEachRouteHit(segments, (segment, index) => {
		if (pad.layer != null && segment.layer != null && !layersTouch(segment.layer, pad.layer)) return;
		if (ignoreSameNet && netsEqual(segment.net, pad.net)) return;
		const decision = clearance.between(segment.net, pad.net, pad.drilled ? 'thPad' : 'smdPad');
		const required = decision.clearanceMil;
		const hit = polygonHit(segStart(segment), segEnd(segment), pad.polygon, pad.bounds, segmentHalfWidth(segment), Math.max(0, required - CLEARANCE_TOLERANCE_MIL));
		if (!hit) return;
		obstacles.push({
			type: pad.type,
			severity: 'blocker',
			reason: netsEqual(segment.net, pad.net) ? 'same-net pad overlap' : 'crosses or violates clearance to a pad',
			net: pad.net,
			layer: pad.layer,
			primitiveId: pad.primitiveId,
			componentPrimitiveId: pad.componentPrimitiveId,
			reference: pad.reference,
			padNumber: pad.padNumber,
			distanceMil: round(hit.distanceMil, 2),
			clearanceRequiredMil: round(required, 2),
			clearanceSource: decision.source,
			point: hit.point,
			bounds: pad.bounds,
			segmentIndex: index,
			routeSegment: segment,
		});
	});
}

export function padToObstacle(flat: any, type: 'pad' | 'component_pad', componentPrimitiveId?: string, reference?: string): PadObstacle | undefined {
	const x = firstFinite(flat?.x, flat?.centerX);
	const y = firstFinite(flat?.y, flat?.centerY);
	if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
	const center = { x, y };
	const shape = padShapeOf(flat, center);
	const drilled = padHasHole(flat);
	return {
		type,
		center,
		polygon: shape.polygon,
		bounds: boundsForPoints(shape.polygon) ?? { minX: x, minY: y, maxX: x, maxY: y },
		shape: shape.kind,
		widthMil: shape.widthMil,
		heightMil: shape.heightMil,
		rotationDeg: shape.rotationDeg,
		net: stringOrUndefined(firstDefined(flat.net, flat.netName)),
		// A drilled (through-hole) pad is copper on every layer regardless of the
		// layer it reports, so treat it as MULTI (12) — it blocks every segment.
		layer: drilled ? MULTI_LAYER_ID : normalizeLayerSafe(flat.layer),
		drilled,
		primitiveId: stringOrUndefined(firstDefined(flat.primitiveId, flat.id)),
		componentPrimitiveId,
		reference,
		padNumber: stringOrUndefined(firstDefined(flat.padNumber, flat.pinNumber, flat.number, flat.name)),
	};
}

// EasyEDA pad shape: [ELLIPSE|OVAL|NGON, w, h] | [RECT, w, h, cornerRadius]
// | [POLYGON, polygonSource]. Everything else falls back to explicit
// width/height/diameter fields, then to FALLBACK_PAD_SIZE_MIL.
function padShapeOf(flat: any, center: Point): { kind: 'rect' | 'ellipse' | 'polygon'; polygon: Point[]; widthMil: number; heightMil: number; rotationDeg: number } {
	const rotationDeg = padRotationDeg(firstDefined(flat?.rotation, flat?.angle, flat?.rotate));
	const shapeArray = Array.isArray(flat?.pad) ? flat.pad : undefined;
	const shapeType = shapeArray ? String(shapeArray[0]).toUpperCase() : undefined;

	if (shapeType === 'POLYGON') {
		const polygon = polygonSourcePoints(shapeArray?.[1]);
		if (polygon.length >= 3) {
			const bounds = boundsForPoints(polygon)!;
			return {
				kind: 'polygon',
				polygon,
				widthMil: bounds.maxX - bounds.minX,
				heightMil: bounds.maxY - bounds.minY,
				rotationDeg,
			};
		}
	}

	let widthMil = shapeArray ? firstFinite(shapeArray[1]) : Number.NaN;
	let heightMil = shapeArray ? firstFinite(shapeArray[2], shapeArray[1]) : Number.NaN;
	if (!Number.isFinite(widthMil)) widthMil = firstFinite(flat?.width, flat?.w, flat?.sizeX, flat?.padWidth, flat?.diameter);
	if (!Number.isFinite(heightMil)) heightMil = firstFinite(flat?.height, flat?.h, flat?.sizeY, flat?.padHeight, flat?.diameter);
	if (!Number.isFinite(widthMil) && !Number.isFinite(heightMil)) {
		widthMil = FALLBACK_PAD_SIZE_MIL;
		heightMil = FALLBACK_PAD_SIZE_MIL;
	}
	if (!Number.isFinite(widthMil)) widthMil = heightMil;
	if (!Number.isFinite(heightMil)) heightMil = widthMil;
	widthMil = Math.max(1, widthMil);
	heightMil = Math.max(1, heightMil);
	// Round pads as rectangles made every corner region a false obstacle (and a
	// false contact): agents switched the obstacle check off because of it.
	const polygon = shapeType === 'ELLIPSE'
		? ellipsePolygon(center, widthMil, heightMil, rotationDeg)
		: shapeType === 'OVAL'
			? stadiumPolygon(center, widthMil, heightMil, rotationDeg)
			: rotatedRectCorners(center, widthMil, heightMil, rotationDeg);
	return {
		kind: shapeType === 'ELLIPSE' || shapeType === 'OVAL' ? 'ellipse' : 'rect',
		polygon,
		widthMil,
		heightMil,
		rotationDeg,
	};
}

const CURVE_STEPS = 24;

function rotateAbout(center: Point, local: Point[], rotationDeg: number): Point[] {
	const radians = (rotationDeg * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return local.map((p) => ({ x: center.x + p.x * cos - p.y * sin, y: center.y + p.x * sin + p.y * cos }));
}

/** Ellipse circumscribing polygon (vertices pushed out so the true curve is never inside-out of the test). */
function ellipsePolygon(center: Point, widthMil: number, heightMil: number, rotationDeg: number): Point[] {
	const grow = 1 / Math.cos(Math.PI / CURVE_STEPS);
	const pts: Point[] = [];
	for (let i = 0; i < CURVE_STEPS; i++) {
		const a = (2 * Math.PI * i) / CURVE_STEPS;
		pts.push({ x: (widthMil / 2) * grow * Math.cos(a), y: (heightMil / 2) * grow * Math.sin(a) });
	}
	return rotateAbout(center, pts, rotationDeg);
}

/** Obround / stadium: a rectangle capped by semicircles on its short sides. */
function stadiumPolygon(center: Point, widthMil: number, heightMil: number, rotationDeg: number): Point[] {
	const horizontal = widthMil >= heightMil;
	const r = (horizontal ? heightMil : widthMil) / 2;
	const straight = (horizontal ? widthMil : heightMil) / 2 - r;
	const grow = 1 / Math.cos(Math.PI / CURVE_STEPS);
	const half = CURVE_STEPS / 2;
	const pts: Point[] = [];
	for (const [cx, start] of [[straight, -Math.PI / 2], [-straight, Math.PI / 2]] as const) {
		for (let i = 0; i <= half; i++) {
			const a = start + (Math.PI * i) / half;
			pts.push({ x: cx + r * grow * Math.cos(a), y: r * grow * Math.sin(a) });
		}
	}
	return rotateAbout(center, horizontal ? pts : pts.map((p) => ({ x: p.y, y: p.x })), rotationDeg);
}

/**
 * Pad `rotation` comes back in RADIANS from both pad APIs (a 270°-rotated
 * connector reports its pins as -1.5707963), while component `rotation` is
 * degrees. Feeding radians into a degree-based rotation left rotated pads
 * effectively unrotated, so their bounding box had width/height swapped.
 * Any |value| within one turn of radians is treated as radians; larger values
 * can only be degrees.
 */
export function padRotationDeg(value: any): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return 0;
	if (n === 0) return 0;
	return Math.abs(n) <= Math.PI * 2 + 1e-6 ? (n * 180) / Math.PI : n;
}

function rotatedRectCorners(center: Point, widthMil: number, heightMil: number, rotationDeg: number): Point[] {
	const hw = widthMil / 2;
	const hh = heightMil / 2;
	const radians = (rotationDeg * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return [
		{ x: -hw, y: -hh },
		{ x: hw, y: -hh },
		{ x: hw, y: hh },
		{ x: -hw, y: hh },
	].map((corner) => ({
		x: center.x + corner.x * cos - corner.y * sin,
		y: center.y + corner.x * sin + corner.y * cos,
	}));
}

function pushPolygonObstacles(
	obstacles: Obstacle[],
	segments: TraceSegmentSpec[],
	obstacle: PolygonObstacle | undefined,
	routeBounds: Bounds,
	clearance: ClearanceResolver,
	ignoreSameNet: boolean,
	ignoreIds: Set<string>,
	pourSeverity: 'blocker' | 'warning' = 'blocker',
): void {
	if (!obstacle || !obstacle.bounds) return;
	if (obstacle.primitiveId && ignoreIds.has(obstacle.primitiveId)) return;
	if (!boundsOverlap(expandBounds(obstacle.bounds, clearance.summary.clearanceMil + DEFAULT_LINE_WIDTH_MIL), routeBounds)) return;
	forEachRouteHit(segments, (segment, index) => {
		if (obstacle.layer != null && segment.layer != null && !layersTouch(segment.layer, obstacle.layer)) return;
		if (ignoreSameNet && netsEqual(segment.net, obstacle.net)) return;
		const isPour = obstacle.type === 'pour';
		// A pour is net copper: the larger of the two nets' rules. A keepout is
		// not copper and has no net: the routed net's own rule.
		const keepoutRule = isPour ? undefined : clearance.for(segment.net);
		const { clearanceMil: required, source } = keepoutRule
			? { clearanceMil: keepoutRule.clearanceMil, source: keepoutRule.source }
			: clearance.between(segment.net, obstacle.net, 'track');
		const hit = polygonHit(segStart(segment), segEnd(segment), obstacle.polygon, obstacle.bounds!, segmentHalfWidth(segment), Math.max(0, required - CLEARANCE_TOLERANCE_MIL));
		if (!hit) return;
		obstacles.push({
			type: obstacle.type,
			severity: isPour ? pourSeverity : 'blocker',
			reason: isPour
				? (netsEqual(segment.net, obstacle.net)
					? 'same-net pour overlap'
					: `cuts the ${obstacle.net ?? 'different-net'} pour${obstacle.name ? ` "${obstacle.name}"` : ''} on this layer — its copper re-flows around the track on the next repour (plane cut; matters for reference planes)`)
				: 'crosses or violates a keepout/no-route region',
			...(isPour && !netsEqual(segment.net, obstacle.net) ? { planeCut: true } : {}),
			net: obstacle.net,
			layer: obstacle.layer,
			primitiveId: obstacle.primitiveId,
			distanceMil: round(hit.distanceMil, 2),
			clearanceRequiredMil: round(required, 2),
			clearanceSource: source,
			point: hit.point,
			bounds: obstacle.bounds,
			segmentIndex: index,
			routeSegment: segment,
		});
	});
}

// Short-lived so a multi-leg route check probes the origin once, not per leg.
let cachedPolygonTransform: { at: number; transform: PolygonTransform } | undefined;
const POLYGON_TRANSFORM_TTL_MS = 5_000;

export async function polygonCanvasTransform(): Promise<PolygonTransform> {
	if (cachedPolygonTransform && Date.now() - cachedPolygonTransform.at < POLYGON_TRANSFORM_TTL_MS) return cachedPolygonTransform.transform;
	const resolved = await resolveCanvasTransform().catch(() => undefined);
	// Unresolved origin: Y-flip only (same assumption as the board outline).
	const transform = resolved?.resolved ? resolved : ASSUMED_ZERO_ORIGIN_TRANSFORM;
	cachedPolygonTransform = { at: Date.now(), transform };
	return transform;
}

function normalizePolygonObstacle(flat: any, raw: any, type: 'pour' | 'keepout', transform: PolygonTransform = ASSUMED_ZERO_ORIGIN_TRANSFORM): PolygonObstacle | undefined {
	const source = readPolygonSource(raw) ?? readPolygonSource(flat);
	const polygon = polygonSourcePoints(source).map((p) => ({ x: transform.x(p.x), y: transform.y(p.y) }));
	const bounds = polygon.length > 0 ? boundsForPoints(polygon) : boundsFromAny(flat);
	if (!bounds) return undefined;
	return {
		type,
		net: type === 'pour' ? stringOrUndefined(firstDefined(flat.net, flat.netName)) : undefined,
		layer: normalizeLayerSafe(flat.layer),
		primitiveId: stringOrUndefined(firstDefined(flat.primitiveId, flat.id)),
		name: stringOrUndefined(firstDefined(flat.regionName, flat.pourName, flat.name)),
		bounds,
		polygon: polygon.length > 0 ? polygon : undefined,
	};
}

export function polygonHit(
	start: Point,
	end: Point,
	polygon: Point[] | undefined,
	bounds: Bounds,
	halfWidthMil: number,
	clearanceMil: number,
): { distanceMil: number; point: Point } | undefined {
	const reach = halfWidthMil + clearanceMil;
	if (!lineIntersectsRect(start, end, expandBounds(bounds, reach))) return undefined;

	if (!polygon || polygon.length < 3) {
		return { distanceMil: 0, point: nearestPointOnRect(midpoint(start, end), bounds) };
	}

	if (pointInPolygon(start, polygon) || pointInPolygon(end, polygon)) {
		return { distanceMil: 0, point: midpoint(start, end) };
	}

	let bestDistance = Number.POSITIVE_INFINITY;
	let bestPoint = midpoint(start, end);
	for (const [a, b] of polygonEdges(polygon)) {
		const d = segmentDistance(start, end, a, b);
		if (d < bestDistance) {
			bestDistance = d;
			bestPoint = nearestPointOnSegment(start, end, midpoint(a, b));
		}
	}
	const edgeDistance = Math.max(0, bestDistance - halfWidthMil);
	if (edgeDistance <= clearanceMil) {
		return { distanceMil: edgeDistance, point: bestPoint };
	}
	return undefined;
}

function isKeepoutRegion(region: any): boolean {
	const hay = JSON.stringify({
		ruleType: region?.ruleType,
		regionName: region?.regionName,
		name: region?.name,
		type: region?.type,
	}).toLowerCase();
	return /keep\s*out|keepout|no[\s_-]*(route|copper|track|via)|forbid|prohibit|restrict/.test(hay)
		|| hasNumericKeepoutRule(region);
}

function hasNumericKeepoutRule(region: any): boolean {
	const raw = Array.isArray(region?.ruleType) ? region.ruleType : [];
	// EasyEDA EPCB_PrimitiveRegionRuleType: 3=NO_VIAS, 5=NO_WIRES,
	// 6=NO_FILLS, 7=NO_POURS, 8=NO_INNER_ELECTRICAL_LAYERS.
	return raw.some((v: any) => [3, 5, 6, 7, 8].includes(Number(v)));
}

function readPolygonSource(value: any): any {
	if (!value) return undefined;
	for (const fn of ['getState_ComplexPolygon', 'getState_Polygon', 'getState_Source']) {
		try {
			if (typeof value[fn] === 'function') {
				const source = sourceOfPolygon(value[fn]());
				if (source != null) return source;
			}
		} catch {/* ignore */}
	}
	return sourceOfPolygon(value.complexPolygon ?? value.polygon ?? value.source ?? value.sourcePolygon);
}

function sourceOfPolygon(value: any): any {
	if (!value) return value;
	if (typeof value.getSource === 'function') {
		try { return value.getSource(); } catch {/* ignore */ }
	}
	return value;
}

function polygonSourcePoints(source: any): Point[] {
	if (!source) return [];
	if (Array.isArray(source)) {
		if (source.length >= 7 && String(source[0]).toUpperCase() === 'R') {
			const left = Number(source[1]);
			const top = Number(source[2]);
			const width = Number(source[3]);
			const height = Number(source[4]);
			if ([left, top, width, height].every(Number.isFinite)) {
				return [
					{ x: left, y: top },
					{ x: left + width, y: top },
					{ x: left + width, y: top + height },
					{ x: left, y: top + height },
				];
			}
		}
		if (source.length > 0 && typeof source[0] === 'object') {
			return source
				.map((p) => ({ x: Number(p.x), y: Number(p.y) }))
				.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
		}
		const nums = source.filter((v) => typeof v === 'number').map(Number);
		const points: Point[] = [];
		for (let i = 0; i + 1 < nums.length; i += 2) points.push({ x: nums[i], y: nums[i + 1] });
		return points;
	}
	if (typeof source === 'object' && Array.isArray(source.points)) return polygonSourcePoints(source.points);
	return [];
}

function polygonEdges(points: Point[]): Array<[Point, Point]> {
	const edges: Array<[Point, Point]> = [];
	for (let i = 0; i < points.length; i++) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		if (distance(a, b) > 1e-9) edges.push([a, b]);
	}
	return edges;
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i];
		const b = polygon[j];
		const intersects = ((a.y > point.y) !== (b.y > point.y)) &&
			(point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || 1e-12) + a.x);
		if (intersects) inside = !inside;
	}
	return inside;
}

function boundsFromAny(value: any): Bounds | undefined {
	if (!value || typeof value !== 'object') return undefined;
	if ([value.minX, value.minY, value.maxX, value.maxY].every((v) => Number.isFinite(Number(v)))) {
		return normalizeBounds(Number(value.minX), Number(value.minY), Number(value.maxX), Number(value.maxY));
	}
	if ([value.left, value.top, value.right, value.bottom].every((v) => Number.isFinite(Number(v)))) {
		return normalizeBounds(Number(value.left), Number(value.top), Number(value.right), Number(value.bottom));
	}
	if (value.bounds) return boundsFromAny(value.bounds);
	if (value.summary?.bbox) return boundsFromAny(value.summary.bbox);
	return undefined;
}

function normalizeBounds(x1: number, y1: number, x2: number, y2: number): Bounds {
	return {
		minX: Math.min(x1, x2),
		minY: Math.min(y1, y2),
		maxX: Math.max(x1, x2),
		maxY: Math.max(y1, y2),
	};
}

function nearestPointOnRect(p: Point, rect: Bounds): Point {
	return {
		x: Math.max(rect.minX, Math.min(rect.maxX, p.x)),
		y: Math.max(rect.minY, Math.min(rect.maxY, p.y)),
	};
}

function normalizeComponentPinToMil(pin: any, pinScale: number): any {
	if (!pin || typeof pin !== 'object') return pin;
	const out: Record<string, any> = { ...pin };
	for (const key of COMPONENT_PAD_COORD_KEYS) {
		if (typeof out[key] === 'number' && Number.isFinite(out[key])) out[key] = out[key] * pinScale;
	}
	for (const key of COMPONENT_PAD_HOLE_KEYS) {
		if (typeof out[key] === 'number' && Number.isFinite(out[key])) out[key] = out[key] * COMPONENT_PAD_UNIT_MIL;
	}
	normalizePadShapeUnits(out);
	return out;
}

/**
 * Normalize a `pad` shape tuple (`["RECT", w, h, r]`, `["ELLIPSE", w, h]`,
 * `["POLYGON", source]`, …) to mil. EasyEDA already reports pad extents in mil
 * on BOTH the standalone-pad and component-pin APIs, so this is an intentional
 * identity — it exists so call sites state the unit contract explicitly rather
 * than silently omitting a conversion.
 */
export function normalizePadShapeToMil(shape: any): any {
	return shape;
}

/**
 * Scale a `hole` shape tuple (`["ROUND", w, h]`, `["SLOT", w, h]`, …) from
 * EasyEDA's 10-mil hole units to mil. Unlike `pad`, hole extents are 10-mil on
 * every API — including the otherwise-mil standalone-pad path.
 */
export function normalizeHoleShapeToMil(shape: any): any {
	return Array.isArray(shape) ? scalePadShapeToMil(shape) : shape;
}

/**
 * Bring the `pad`/`hole` tuples of an already-copied flat pad record into mil,
 * in place. Correct for component-pin records and standalone-pad records alike,
 * because both carry the same raw tuple units (`pad` mil, `hole` 10-mil).
 */
export function normalizePadShapeUnits(out: Record<string, any>): Record<string, any> {
	if (Array.isArray(out.pad)) out.pad = normalizePadShapeToMil(out.pad);
	if (Array.isArray(out.hole)) out.hole = normalizeHoleShapeToMil(out.hole);
	return out;
}

function scalePadShapeToMil(shape: any[]): any[] {
	const kind = String(shape[0]).toUpperCase();
	if (kind === 'POLYGON') {
		return [shape[0], scalePolygonSourceToMil(shape[1])];
	}
	return shape.map((value, index) => (
		index > 0 && typeof value === 'number' && Number.isFinite(value) ? value * COMPONENT_PAD_UNIT_MIL : value
	));
}

function scalePolygonSourceToMil(source: any): any {
	if (Array.isArray(source)) {
		return source.map((value) => (
			typeof value === 'number' && Number.isFinite(value) ? value * COMPONENT_PAD_UNIT_MIL : scalePolygonSourceToMil(value)
		));
	}
	if (source && typeof source === 'object') {
		const out: Record<string, any> = { ...source };
		for (const key of ['x', 'y']) {
			if (typeof out[key] === 'number' && Number.isFinite(out[key])) out[key] = out[key] * COMPONENT_PAD_UNIT_MIL;
		}
		return out;
	}
	return source;
}

async function buildClearanceResolver(params: Record<string, any>, segments: TraceSegmentSpec[]): Promise<ClearanceResolver> {
	return resolveClearance(segments.map((s) => s.net), params);
}

// DRC clearance: the rule parsing (structure, units, plausibility fallback) is
// pure and lives in src/shared/drc-rules.ts so the MCP server reads rules the
// same way. This module only fetches the payloads.
//
// The fuzzy search it replaced (/clearance|spacing/ -> first number) matched
// none of the Safe Spacing keys and landed on Physics -> "Differential Pair" ->
// form.differentailPairSpacingMin, in mm: 0.152 "mil" on the JLCPCB profile,
// i.e. every clearance check was effectively off.

/** The current board's rule payloads; either is undefined when the SDK cannot read it. */
export async function fetchDrcRules(): Promise<{ ruleConfig: any; netRules: any }> {
	const drc = (eda as any)?.pcb_Drc;
	const [ruleConfig, netRules] = await Promise.all([
		Promise.resolve().then(() => drc?.getCurrentRuleConfiguration?.()).catch(() => undefined),
		Promise.resolve().then(() => drc?.getNetRules?.()).catch(() => undefined),
	]);
	return { ruleConfig, netRules };
}

/**
 * Resolve DRC clearance for `nets` (the net(s) being routed/checked). An
 * explicit params.clearanceMil overrides the board rules for every net.
 * `nets` only decides what summary.perNet pre-reports; resolver.for() works
 * for any net.
 */
export async function resolveClearance(nets: Array<string | undefined>, params: Record<string, any> = {}): Promise<ClearanceResolver> {
	const explicit = explicitClearanceMil(params);
	if (explicit != null) return explicitClearanceResolver(explicit);
	const { ruleConfig, netRules } = await fetchDrcRules();
	return clearanceResolverFromRules(ruleConfig, netRules, nets);
}

function forEachRouteHit(segments: TraceSegmentSpec[], fn: (segment: TraceSegmentSpec, index: number) => void): void {
	for (let i = 0; i < segments.length; i++) fn(segments[i], i);
}

function isFiniteSegment(s: Pick<TraceSegmentSpec, 'startX' | 'startY' | 'endX' | 'endY'>): boolean {
	return Number.isFinite(s.startX) && Number.isFinite(s.startY) && Number.isFinite(s.endX) && Number.isFinite(s.endY);
}

function segStart(s: Pick<TraceSegmentSpec, 'startX' | 'startY'>): Point {
	return { x: s.startX, y: s.startY };
}

function segEnd(s: Pick<TraceSegmentSpec, 'endX' | 'endY'>): Point {
	return { x: s.endX, y: s.endY };
}

function segmentHalfWidth(s: TraceSegmentSpec): number {
	return numberOrDefault(s.lineWidth, DEFAULT_LINE_WIDTH_MIL) / 2;
}

function boundsForSegments(segments: TraceSegmentSpec[]): Bounds {
	const points = segments.flatMap((s) => [segStart(s), segEnd(s)]);
	return boundsForPoints(points) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

function boundsForPoints(points: Point[]): Bounds | undefined {
	const finite = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
	if (finite.length === 0) return undefined;
	let minX = finite[0].x;
	let maxX = finite[0].x;
	let minY = finite[0].y;
	let maxY = finite[0].y;
	for (const p of finite.slice(1)) {
		minX = Math.min(minX, p.x);
		maxX = Math.max(maxX, p.x);
		minY = Math.min(minY, p.y);
		maxY = Math.max(maxY, p.y);
	}
	return { minX, minY, maxX, maxY };
}

function expandBounds(bounds: Bounds, amount: number): Bounds {
	return {
		minX: bounds.minX - amount,
		minY: bounds.minY - amount,
		maxX: bounds.maxX + amount,
		maxY: bounds.maxY + amount,
	};
}

function pointInBounds(p: Point, b: Bounds): boolean {
	return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

function segmentTouchesBounds(segment: Pick<TraceSegmentSpec, 'startX' | 'startY' | 'endX' | 'endY'>, bounds: Bounds): boolean {
	const sBounds = boundsForPoints([segStart(segment), segEnd(segment)]);
	return !!sBounds && boundsOverlap(sBounds, bounds);
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function lineIntersectsRect(a: Point, b: Point, rect: Bounds): boolean {
	if (pointInBounds(a, rect) || pointInBounds(b, rect)) return true;
	const corners = [
		{ x: rect.minX, y: rect.minY },
		{ x: rect.maxX, y: rect.minY },
		{ x: rect.maxX, y: rect.maxY },
		{ x: rect.minX, y: rect.maxY },
	];
	for (let i = 0; i < 4; i++) {
		if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return true;
	}
	return false;
}

export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
	if (segmentsIntersect(a, b, c, d)) return 0;
	return Math.min(
		pointToSegmentDistance(a, c, d),
		pointToSegmentDistance(b, c, d),
		pointToSegmentDistance(c, a, b),
		pointToSegmentDistance(d, a, b),
	);
}

export function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
	return distance(p, nearestPointOnSegment(a, b, p));
}

function nearestPointOnSegment(a: Point, b: Point, p: Point): Point {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	if (len2 <= 1e-12) return a;
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
	return { x: a.x + t * dx, y: a.y + t * dy };
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
	const o1 = orient(a, b, c);
	const o2 = orient(a, b, d);
	const o3 = orient(c, d, a);
	const o4 = orient(c, d, b);
	return o1 * o2 < 0 && o3 * o4 < 0;
}

function orient(a: Point, b: Point, c: Point): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function samePhysicalSegment(a: TraceSegmentSpec, b: Pick<TraceSegmentSpec, 'startX' | 'startY' | 'endX' | 'endY'>): boolean {
	const ab = distance(segStart(a), segStart(b)) <= 1e-6 && distance(segEnd(a), segEnd(b)) <= 1e-6;
	const ba = distance(segStart(a), segEnd(b)) <= 1e-6 && distance(segEnd(a), segStart(b)) <= 1e-6;
	return ab || ba;
}

// True when copper on layer `a` and copper on layer `b` can collide. Accepts
// numeric ids, numeric strings and names ("2", 2, "BOTTOM", "BottomLayer") —
// both sides go through normalizeLayer so the comparison is on EPCB_LayerId.
// An unknown/absent layer is conservatively treated as touching; MULTI (12)
// touches every layer.
export function layersTouch(a: any, b: any): boolean {
	const la = normalizeLayerSafe(a);
	const lb = normalizeLayerSafe(b);
	if (la == null || lb == null) return true;
	if (String(la) === String(MULTI_LAYER_ID) || String(lb) === String(MULTI_LAYER_ID)) return true;
	return String(la).trim().toLowerCase() === String(lb).trim().toLowerCase();
}

function padHasHole(flat: any): boolean {
	const hole = flat?.hole;
	if (Array.isArray(hole)) return hole.slice(1).some((v: any) => Number(v) > 0);
	if (hole && typeof hole === 'object') return true;
	return firstFinite(flat?.holeDiameter, flat?.holeWidth) > 0;
}

function netsEqual(a: any, b: any): boolean {
	const aa = stringOrUndefined(a);
	const bb = stringOrUndefined(b);
	return !!aa && !!bb && aa === bb;
}

function dedupeObstacles(obstacles: Obstacle[]): Obstacle[] {
	const seen = new Set<string>();
	const out: Obstacle[] = [];
	for (const o of obstacles) {
		const key = [
			o.type,
			o.primitiveId,
			o.componentPrimitiveId,
			o.reference,
			o.padNumber,
			o.segmentIndex,
			o.net,
			o.reason,
		].join('|');
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(o);
	}
	return out.sort((a, b) => {
		if (a.severity !== b.severity) return a.severity === 'blocker' ? -1 : 1;
		return (a.distanceMil ?? 0) - (b.distanceMil ?? 0);
	});
}

function firstDefined(...values: any[]): any {
	for (const value of values) if (value !== undefined && value !== null) return value;
	return undefined;
}

function firstFinite(...values: any[]): number {
	for (const value of values) {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return Number.NaN;
}

function numberOrDefault(value: any, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function stringOrUndefined(value: any): string | undefined {
	if (value === undefined || value === null) return undefined;
	const s = String(value).trim();
	return s ? s : undefined;
}

function normalizeLayerSafe(layer: any): any {
	try {
		return layer != null ? normalizeLayer(layer) : undefined;
	} catch {
		return layer;
	}
}

function round(value: number, digits = 0): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}
