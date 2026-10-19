import { flattenState, flattenStateArray, mapWithConcurrency, normalizeLayer } from './_utils';
import { normalizePadShapeUnits } from './trace-obstacles';
import { componentPinScale, componentPinSourceUnits } from './pin-units';

type Point = { x: number; y: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
type PinSide = 'left' | 'right' | 'top' | 'bottom' | 'center';

interface ComponentInfo {
	primitiveId: string;
	designator?: string;
	name?: string;
	layer?: any;
	origin: Point;
	rotation: number;
	primitiveLock: boolean;
	pins: PadInfo[];
	bounds?: Bounds;
	raw?: any;
}

interface PadInfo {
	primitiveId?: string;
	padNumber?: string;
	net?: string;
	layer?: any;
	x: number;
	y: number;
	localX: number;
	localY: number;
	side: PinSide;
	quadrant: string;
	rotation?: number;
	componentPrimitiveId: string;
	componentDesignator?: string;
}

interface IndexedPad extends PadInfo {
	componentPrimitiveId: string;
	componentDesignator?: string;
}

interface RotationScore {
	rotation: number;
	score: number;
	ratlineLengthMil: number;
	targetedPadCount: number;
	unmatchedPadCount: number;
	crossingCount: number;
	facingAwayCount: number;
	collisionCount: number;
	collisions: Array<Record<string, any>>;
	bounds?: Bounds;
	targetPairs: Array<Record<string, any>>;
}

interface AutoRipPlan {
	enabled: boolean;
	dryRun: boolean;
	toleranceMil: number;
	preserveLocked: boolean;
	maxPrimitives: number;
	overLimit: boolean;
	lineIds: string[];
	viaIds: string[];
	skippedLockedLineIds: string[];
	skippedLockedViaIds: string[];
	affectedNets: string[];
	attachmentCount: number;
	pins: Array<{ label: string; net?: string; x: number; y: number }>;
	lines: Array<{ primitiveId: string; net?: string; layer?: any; endpoint: 'start' | 'end'; distanceMil: number; pad: string }>;
	vias: Array<{ primitiveId: string; net?: string; distanceMil: number; pad: string }>;
	note: string;
}

interface AutoRipResult extends AutoRipPlan {
	applied: boolean;
	deletedLineCount: number;
	deletedViaCount: number;
	deleteOk: { lines?: boolean; vias?: boolean };
	error?: string;
}

const DEFAULT_CANDIDATE_ROTATIONS = [0, 90, 180, 270];
const MECHANICAL_DESIGNATOR = /^(MH|H|FID|TP|LOGO|MOUNT|MTG)\d*$/i;
const DEFAULT_AUTO_RIP_TOLERANCE_MIL = 25;
const DEFAULT_AUTO_RIP_MAX_PRIMITIVES = 100;

export const placementHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.footprint.map': async (params) => {
		const raw = await resolveComponentRaw(params);
		const info = await buildComponentInfo(raw);
		const candidateRotations = resolveCandidateRotations(params, info.rotation);
		const includeCandidatePins = !!params.includeCandidatePins;

		return {
			component: summarizeComponent(info),
			origin: info.origin,
			currentRotation: info.rotation,
			pinCount: info.pins.length,
			bounds: info.bounds,
			pins: info.pins.map(summarizePin),
			sideSummary: buildSideSummary(info.pins),
			netSummary: buildNetSummary(info.pins),
			candidateRotations: candidateRotations.map((rotation) => {
				const pins = transformPins(info, rotation);
				return {
					rotation,
					bounds: boundsForPins(pins),
					sideSummary: buildSideSummary(pins),
					netSummary: buildNetSummary(pins),
					...(includeCandidatePins ? { pins: pins.map(summarizePin) } : {}),
				};
			}),
			units: 'mil',
			note: 'Candidate rotations are simulated around the component origin from current absolute pad positions. Use this before routing dense parts so the agent can see which side each net exits.',
		};
	},

	'pcb.placement.suggestRotation': async (params) => {
		const allRaw = await loadAllRawComponents();
		const targetRaw = await resolveComponentRaw(params, allRaw);
		const target = await buildComponentInfo(targetRaw);
		const contextRaw = selectContextComponents(allRaw, target, params);
		const context = await buildComponentInfos(contextRaw, params);
		const board = buildBoardIndex([target, ...context]);
		return buildSuggestionResult(target, board, params);
	},

	'pcb.placement.reviewOrientations': async (params) => {
		const allRaw = await loadAllRawComponents();
		const maxComponents = Math.max(1, Math.floor(Number(params.maxComponents ?? 200)));
		const raws = allRaw.slice(0, maxComponents);
		const infos = await buildComponentInfos(raws, params);
		const board = buildBoardIndex(infos);
		const references = new Set<string>(
			Array.isArray(params.references)
				? params.references.map((r: any) => String(r).toUpperCase())
				: [],
		);
		const skipMechanical = params.skipMechanical !== false;
		const respectLocked = params.respectLocked !== false;
		const includeStable = !!params.includeStable;
		const minImprovementPercent = Number(params.minImprovementPercent ?? 8);
		const minScoreImprovementMil = Number(params.minScoreImprovementMil ?? 75);
		const limit = Math.max(1, Math.floor(Number(params.limit ?? 10)));
		const recommendations: any[] = [];
		const skipped: Record<string, number> = {
			locked: 0,
			mechanical: 0,
			noPins: 0,
			referenceFilter: 0,
			overLimit: Math.max(0, allRaw.length - raws.length),
		};

		for (const info of infos) {
			if (info.pins.length === 0) {
				skipped.noPins += 1;
				continue;
			}
			const ref = String(info.designator ?? '').toUpperCase();
			if (references.size > 0 && !references.has(ref)) {
				skipped.referenceFilter += 1;
				continue;
			}
			if (skipMechanical && info.designator && MECHANICAL_DESIGNATOR.test(info.designator)) {
				skipped.mechanical += 1;
				continue;
			}
			if (respectLocked && info.primitiveLock) {
				skipped.locked += 1;
				continue;
			}

			const suggestion = buildSuggestionResult(info, board, params);
			const current = suggestion.currentScore;
			const best = suggestion.recommendedScore;
			const improvedEnough = suggestion.improvementPercent >= minImprovementPercent || suggestion.improvementScoreMil >= minScoreImprovementMil;
			if (includeStable || (best.rotation !== current.rotation && improvedEnough)) {
				recommendations.push({
					component: suggestion.component,
					currentRotation: suggestion.currentRotation,
					recommendedRotation: suggestion.recommendedRotation,
					improvementPercent: suggestion.improvementPercent,
					improvementScoreMil: suggestion.improvementScoreMil,
					safeToApply: suggestion.safeToApply,
					reasons: suggestion.reasons,
					currentScore: current,
					recommendedScore: best,
					scoreBreakdown: suggestion.scoreBreakdown,
				});
			}
		}

		recommendations.sort((a, b) => b.improvementScoreMil - a.improvementScoreMil);

		return {
			units: 'mil',
			scannedComponentCount: infos.length,
			totalComponentCount: allRaw.length,
			skipped,
			limit,
			recommendations: recommendations.slice(0, limit),
			note: 'This is a placement heuristic, not a DRC solver. Apply one rotation at a time, then rerun DRC/connectivity before routing.',
		};
	},

	'pcb.placement.applyRotation': async (params) => {
		const rotationInput = firstDefined(params.rotation, params.targetRotation, params.recommendedRotation);
		const deltaInput = firstDefined(params.deltaRotation, params.rotateBy);
		if (!Number.isFinite(Number(rotationInput)) && !Number.isFinite(Number(deltaInput))) {
			throw new Error('pcb_apply_component_rotation requires rotation (absolute degrees) or deltaRotation.');
		}
		return applyComponentTransform({
			...params,
			rotation: rotationInput,
			deltaRotation: deltaInput,
		});
	},

	'pcb.placement.setPosition': async (params) => {
		const xInput = firstDefined(params.x, params.targetX);
		const yInput = firstDefined(params.y, params.targetY);
		const rotationInput = firstDefined(params.rotation, params.targetRotation);
		const deltaInput = firstDefined(params.deltaRotation, params.rotateBy);
		if (
			!Number.isFinite(Number(xInput)) &&
			!Number.isFinite(Number(yInput)) &&
			!Number.isFinite(Number(rotationInput)) &&
			!Number.isFinite(Number(deltaInput))
		) {
			throw new Error('pcb_set_component_position requires at least one of x, y, rotation, or deltaRotation.');
		}
		return applyComponentTransform({
			...params,
			x: xInput,
			y: yInput,
			rotation: rotationInput,
			deltaRotation: deltaInput,
		});
	},

	'pcb.placement.review': async (params) => {
		return buildPlacementSnapshot(params);
	},
};

// Shared transform applied by both applyRotation and setPosition. Keeps the
// locked-component guard, dryRun handling, the modify({ x, y, rotation }) call,
// re-read, before/after diff, and the "routes/pours not reshaped" warning in one
// place so both write paths behave identically.
async function applyComponentTransform(params: Record<string, any>): Promise<any> {
	const raw = await resolveComponentRaw(params);
	const info = await buildComponentInfo(raw);
	const respectLocked = params.respectLocked !== false;
	const dryRun = !!params.dryRun;
	const autoRipRequested = params.autoRipConnectedTracks === true || params.autoRip === true || params.ripConnectedTracks === true;
	const autoRipPlan = autoRipRequested ? await planComponentAutoRip(info, params, dryRun) : undefined;
	if (respectLocked && info.primitiveLock) {
		throw new Error(`Component ${info.designator ?? info.primitiveId} is locked. Pass respectLocked:false only if you intentionally want to override it.`);
	}

	const rotationInput = firstDefined(params.rotation, params.targetRotation, params.recommendedRotation);
	const deltaInput = firstDefined(params.deltaRotation, params.rotateBy);
	const hasRotation = Number.isFinite(Number(rotationInput)) || Number.isFinite(Number(deltaInput));
	const targetRotation = Number.isFinite(Number(rotationInput))
		? normalizeAngle(Number(rotationInput))
		: Number.isFinite(Number(deltaInput))
			? normalizeAngle(info.rotation + Number(deltaInput))
			: info.rotation;

	const property: Record<string, any> = {};
	if (hasRotation) property.rotation = targetRotation;
	if (params.x != null && Number.isFinite(Number(params.x))) property.x = Number(params.x);
	if (params.y != null && Number.isFinite(Number(params.y))) property.y = Number(params.y);
	if (params.primitiveLock != null) property.primitiveLock = !!params.primitiveLock;

	if (Object.keys(property).length === 0) {
		throw new Error('No transform requested. Provide rotation/deltaRotation and/or x/y.');
	}

	if (dryRun) {
		return {
			dryRun: true,
			applied: false,
			component: summarizeComponent(info),
			before: { rotation: info.rotation, origin: info.origin, primitiveLock: info.primitiveLock },
			plannedProperty: property,
			autoRip: autoRipPlan,
			units: 'mil',
		};
	}

	if (autoRipPlan?.overLimit && params.autoRipAllowOverLimit !== true) {
		throw new Error(`autoRipConnectedTracks matched ${autoRipPlan.attachmentCount} primitive(s), above maxAutoRipPrimitives=${autoRipPlan.maxPrimitives}. Re-run dryRun:true to inspect, raise maxAutoRipPrimitives, or pass autoRipAllowOverLimit:true.`);
	}

	const modified = await eda.pcb_PrimitiveComponent.modify(info.primitiveId, property);
	const afterRaw = await eda.pcb_PrimitiveComponent.get(info.primitiveId);
	const afterInfo = await buildComponentInfo(Array.isArray(afterRaw) ? afterRaw[0] : afterRaw);
	const autoRip = autoRipPlan && modified ? await applyAutoRipPlan(autoRipPlan) : autoRipPlan ? { ...autoRipPlan, applied: false, deletedLineCount: 0, deletedViaCount: 0, deleteOk: {} } : undefined;

	return {
		dryRun: false,
		applied: !!modified,
		component: summarizeComponent(afterInfo),
		before: { rotation: info.rotation, origin: info.origin, primitiveLock: info.primitiveLock },
		after: { rotation: afterInfo.rotation, origin: afterInfo.origin, primitiveLock: afterInfo.primitiveLock },
		modified: !!modified,
		autoRip,
		rerouteNets: autoRip?.affectedNets ?? [],
		warning: autoRip?.applied && (autoRip.deletedLineCount > 0 || autoRip.deletedViaCount > 0)
			? 'Attached route copper at the old component pads was ripped. Re-route rerouteNets, rebuild pours, and run DRC/connectivity after moving/rotating placed parts.'
			: 'Connected routes and pours are not reshaped by this call. Rebuild pours and run DRC/connectivity after moving/rotating placed parts.',
		units: 'mil',
	};
}

async function planComponentAutoRip(info: ComponentInfo, params: Record<string, any>, dryRun: boolean): Promise<AutoRipPlan> {
	const toleranceMil = Math.max(0.1, Number(firstDefined(params.autoRipToleranceMil, params.ripToleranceMil, DEFAULT_AUTO_RIP_TOLERANCE_MIL)));
	const preserveLocked = params.autoRipPreserveLocked !== false;
	const maxPrimitives = Math.max(1, Math.floor(Number(firstDefined(params.maxAutoRipPrimitives, params.autoRipMaxPrimitives, DEFAULT_AUTO_RIP_MAX_PRIMITIVES))));
	const pins = (info.pins ?? [])
		.filter((pin) => cleanNet(pin.net) && Number.isFinite(pin.x) && Number.isFinite(pin.y))
		.map((pin) => ({
			label: padLabel(pin),
			net: cleanNet(pin.net),
			x: round(pin.x, 3),
			y: round(pin.y, 3),
		}));
	const nets = unique(pins.map((pin) => pin.net).filter((net): net is string => !!net));
	const lineIds = new Set<string>();
	const viaIds = new Set<string>();
	const skippedLockedLineIds = new Set<string>();
	const skippedLockedViaIds = new Set<string>();
	const lineRows: AutoRipPlan['lines'] = [];
	const viaRows: AutoRipPlan['vias'] = [];
	const affectedNets = new Set<string>();

	for (const net of nets) {
		const netPins = pins.filter((pin) => pin.net === net);
		const [rawLines, rawVias] = await Promise.all([
			eda.pcb_PrimitiveLine.getAll(net, undefined, undefined).catch(() => []),
			eda.pcb_PrimitiveVia.getAll(net, undefined).catch(() => []),
		]);

		for (const rawLine of Array.isArray(rawLines) ? rawLines : []) {
			const flat = flattenState(rawLine);
			const primitiveId = stringOrUndefined(firstDefined(readField(rawLine, 'PrimitiveId', 'primitiveId', 'id'), flat?.primitiveId, flat?.id));
			if (!primitiveId || lineIds.has(primitiveId) || skippedLockedLineIds.has(primitiveId)) continue;
			const lineNet = cleanNet(firstDefined(readField(rawLine, 'Net', 'net'), flat?.net));
			if (lineNet !== net) continue;
			const start = {
				x: firstFinite(readField(rawLine, 'StartX', 'startX'), flat?.startX),
				y: firstFinite(readField(rawLine, 'StartY', 'startY'), flat?.startY),
			};
			const end = {
				x: firstFinite(readField(rawLine, 'EndX', 'endX'), flat?.endX),
				y: firstFinite(readField(rawLine, 'EndY', 'endY'), flat?.endY),
			};
			if (!Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(end.x) || !Number.isFinite(end.y)) continue;
			const hit = nearestLineEndpointHit(netPins, start, end, toleranceMil);
			if (!hit) continue;
			if (preserveLocked && primitiveLocked(rawLine, flat)) {
				skippedLockedLineIds.add(primitiveId);
				continue;
			}
			lineIds.add(primitiveId);
			affectedNets.add(net);
			lineRows.push({
				primitiveId,
				net,
				layer: normalizeLayerSafe(firstDefined(readField(rawLine, 'Layer', 'layer'), flat?.layer)),
				endpoint: hit.endpoint,
				distanceMil: round(hit.distanceMil, 2),
				pad: hit.pad,
			});
		}

		for (const rawVia of Array.isArray(rawVias) ? rawVias : []) {
			const flat = flattenState(rawVia);
			const primitiveId = stringOrUndefined(firstDefined(readField(rawVia, 'PrimitiveId', 'primitiveId', 'id'), flat?.primitiveId, flat?.id));
			if (!primitiveId || viaIds.has(primitiveId) || skippedLockedViaIds.has(primitiveId)) continue;
			const viaNet = cleanNet(firstDefined(readField(rawVia, 'Net', 'net'), flat?.net));
			if (viaNet !== net) continue;
			const point = {
				x: firstFinite(readField(rawVia, 'X', 'x'), flat?.x),
				y: firstFinite(readField(rawVia, 'Y', 'y'), flat?.y),
			};
			if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
			const hit = nearestPointHit(netPins, point, toleranceMil);
			if (!hit) continue;
			if (preserveLocked && primitiveLocked(rawVia, flat)) {
				skippedLockedViaIds.add(primitiveId);
				continue;
			}
			viaIds.add(primitiveId);
			affectedNets.add(net);
			viaRows.push({
				primitiveId,
				net,
				distanceMil: round(hit.distanceMil, 2),
				pad: hit.pad,
			});
		}
	}

	const attachmentCount = lineIds.size + viaIds.size;
	return {
		enabled: true,
		dryRun,
		toleranceMil,
		preserveLocked,
		maxPrimitives,
		overLimit: attachmentCount > maxPrimitives,
		lineIds: Array.from(lineIds).slice(0, maxPrimitives),
		viaIds: Array.from(viaIds).slice(0, maxPrimitives),
		skippedLockedLineIds: Array.from(skippedLockedLineIds),
		skippedLockedViaIds: Array.from(skippedLockedViaIds),
		affectedNets: Array.from(affectedNets).sort(),
		attachmentCount,
		pins,
		lines: lineRows.slice(0, maxPrimitives),
		vias: viaRows.slice(0, maxPrimitives),
		note: 'Auto-rip matches only same-net Line endpoints and vias touching the component pad centers. It does not delete unrelated same-net route segments.',
	};
}

async function applyAutoRipPlan(plan: AutoRipPlan): Promise<AutoRipResult> {
	const result: AutoRipResult = {
		...plan,
		applied: false,
		deletedLineCount: 0,
		deletedViaCount: 0,
		deleteOk: {},
	};
	try {
		if (plan.lineIds.length > 0) {
			const ok = await eda.pcb_PrimitiveLine.delete(plan.lineIds);
			result.deleteOk.lines = !!ok;
			if (ok) result.deletedLineCount = plan.lineIds.length;
		}
		if (plan.viaIds.length > 0) {
			const ok = await eda.pcb_PrimitiveVia.delete(plan.viaIds);
			result.deleteOk.vias = !!ok;
			if (ok) result.deletedViaCount = plan.viaIds.length;
		}
		result.applied = true;
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
	}
	return result;
}

function nearestLineEndpointHit(
	pins: Array<{ label: string; x: number; y: number }>,
	start: Point,
	end: Point,
	toleranceMil: number,
): { endpoint: 'start' | 'end'; distanceMil: number; pad: string } | undefined {
	const hits = [
		...pins.map((pin) => ({ endpoint: 'start' as const, distanceMil: distance(pin, start), pad: pin.label })),
		...pins.map((pin) => ({ endpoint: 'end' as const, distanceMil: distance(pin, end), pad: pin.label })),
	].filter((hit) => hit.distanceMil <= toleranceMil);
	return hits.sort((a, b) => a.distanceMil - b.distanceMil)[0];
}

function nearestPointHit(
	pins: Array<{ label: string; x: number; y: number }>,
	point: Point,
	toleranceMil: number,
): { distanceMil: number; pad: string } | undefined {
	return pins
		.map((pin) => ({ distanceMil: distance(pin, point), pad: pin.label }))
		.filter((hit) => hit.distanceMil <= toleranceMil)
		.sort((a, b) => a.distanceMil - b.distanceMil)[0];
}

function primitiveLocked(raw: any, flat?: any): boolean {
	try {
		if (typeof raw?.getState_PrimitiveLock === 'function') return !!raw.getState_PrimitiveLock();
	} catch {
		/* ignore */
	}
	return !!firstDefined(flat?.primitiveLock, flat?.locked, flat?.lock, false);
}

// Build a placement snapshot for the MCP-side analyzer (analyzePlacement).
// Every coordinate is in mil: component pads are produced by loadComponentPins
// (which applies normalizePinToMil ×10), and board-outline lines are native mil.
async function buildPlacementSnapshot(params: Record<string, any>): Promise<any> {
	const allRaw = await loadAllRawComponents();
	const maxComponents = Math.max(1, Math.floor(Number(params.maxComponents ?? 500)));
	const raws = allRaw.slice(0, maxComponents);
	const infos = await buildComponentInfos(raws, params);

	const components = infos.map((info) => ({
		primitiveId: info.primitiveId,
		designator: info.designator,
		name: info.name,
		layer: normalizeLayerSafe(info.layer),
		x: round(info.origin.x, 3),
		y: round(info.origin.y, 3),
		rotation: info.rotation,
		primitiveLock: info.primitiveLock,
		pads: info.pins.map((pin) => ({
			designator: info.designator,
			padNumber: pin.padNumber,
			net: pin.net,
			x: round(pin.x, 3),
			y: round(pin.y, 3),
		})),
	}));

	const boardOutline = await loadBoardOutlineBounds();

	return {
		units: 'mil',
		componentCount: components.length,
		totalComponentCount: allRaw.length,
		skippedOverLimit: Math.max(0, allRaw.length - raws.length),
		components,
		boardOutline,
		note: 'Pad coordinates are in mil (component-pin units ×10). Board outline derived from layer-11 (BoardOutline) Line/Arc primitives when present.',
	};
}

// Board outline bbox from layer-11 (BoardOutline) line/arc primitives. These are
// native mil (no ×10 scaling, unlike component pins). Returns lineCount:0 when no
// outline exists so the analyzer can fall back to a component bbox-union.
async function loadBoardOutlineBounds(): Promise<{ bounds?: Bounds; lineCount: number }> {
	try {
		const rawLines = await eda.pcb_PrimitiveLine.getAll();
		const lines = flattenStateArray((Array.isArray(rawLines) ? rawLines : []) as any[]);
		const points: Point[] = [];
		let lineCount = 0;
		for (const l of lines) {
			if (normalizeLayerSafe(l.layer) !== 11) continue;
			lineCount += 1;
			const sx = Number(l.startX);
			const sy = Number(l.startY);
			const ex = Number(l.endX);
			const ey = Number(l.endY);
			if (Number.isFinite(sx) && Number.isFinite(sy)) points.push({ x: sx, y: sy });
			if (Number.isFinite(ex) && Number.isFinite(ey)) points.push({ x: ex, y: ey });
		}
		return { bounds: boundsForPoints(points), lineCount };
	} catch {
		return { lineCount: 0 };
	}
}

async function loadAllRawComponents(): Promise<any[]> {
	const all = await eda.pcb_PrimitiveComponent.getAll();
	return Array.isArray(all) ? all : [];
}

async function resolveComponentRaw(params: Record<string, any>, allRaw?: any[]): Promise<any> {
	const primitiveId = stringOrUndefined(firstDefined(params.primitiveId, params.componentPrimitiveId, params.id));
	const reference = stringOrUndefined(firstDefined(params.reference, params.designator, params.ref));

	if (primitiveId) {
		if (allRaw) {
			const found = allRaw.find((raw) => stringOrUndefined(readField(raw, 'PrimitiveId', 'primitiveId', 'id')) === primitiveId);
			if (found) return found;
		}
		const direct = await eda.pcb_PrimitiveComponent.get(primitiveId);
		const raw = Array.isArray(direct) ? direct[0] : direct;
		if (raw) return raw;
		throw new Error(`Component primitiveId ${primitiveId} not found.`);
	}

	if (!reference) {
		throw new Error('Component target is required. Pass primitiveId or reference/designator.');
	}

	const components = allRaw ?? await loadAllRawComponents();
	const upper = reference.toUpperCase();
	const found = components.find((raw) => {
		const designator = stringOrUndefined(readField(raw, 'Designator', 'designator', 'reference'));
		return designator?.toUpperCase() === upper;
	});
	if (!found) throw new Error(`Component ${reference} not found.`);
	return found;
}

async function buildComponentInfos(raws: any[], params: Record<string, any>): Promise<ComponentInfo[]> {
	const out: ComponentInfo[] = [];
	const concurrency = Math.max(1, Math.min(8, Math.floor(Number(params.pinConcurrency ?? 4))));
	await mapWithConcurrency(raws, concurrency, async (raw) => {
		try {
			const info = await buildComponentInfo(raw);
			out.push(info);
		} catch {
			/* Ignore malformed components in board-level review. Direct lookups still throw. */
		}
	});
	return out;
}

async function buildComponentInfo(raw: any): Promise<ComponentInfo> {
	if (!raw) throw new Error('Component not found.');
	const flat = flattenState(raw);
	const primitiveId = stringOrUndefined(firstDefined(flat.primitiveId, flat.id, readField(raw, 'PrimitiveId', 'primitiveId', 'id')));
	if (!primitiveId) throw new Error('Could not resolve component primitiveId.');

	const designator = stringOrUndefined(firstDefined(flat.designator, readField(raw, 'Designator', 'designator')));
	const name = stringOrUndefined(firstDefined(flat.name, flat.packageName, readField(raw, 'Name', 'name')));
	const layer = firstDefined(flat.layer, readField(raw, 'Layer', 'layer'));
	let origin: Point = {
		x: numberOrNaN(firstDefined(flat.x, readField(raw, 'X', 'x'))),
		y: numberOrNaN(firstDefined(flat.y, readField(raw, 'Y', 'y'))),
	};
	const rotation = normalizeAngle(numberOrDefault(firstDefined(flat.rotation, readField(raw, 'Rotation', 'rotation')), 0));
	const primitiveLock = !!firstDefined(flat.primitiveLock, readField(raw, 'PrimitiveLock', 'primitiveLock'), false);

	let pins = await loadComponentPins(primitiveId, designator);
	if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
		const pinBounds = boundsForPoints(pins);
		origin = pinBounds
			? { x: (pinBounds.minX + pinBounds.maxX) / 2, y: (pinBounds.minY + pinBounds.maxY) / 2 }
			: { x: 0, y: 0 };
	}
	pins = pins.map((pin) => decoratePinLocal(pin, origin));

	return {
		primitiveId,
		designator,
		name,
		layer,
		origin,
		rotation,
		primitiveLock,
		pins,
		bounds: boundsForPins(pins),
		raw,
	};
}

async function loadComponentPins(componentPrimitiveId: string, componentDesignator?: string): Promise<PadInfo[]> {
	const pinScale = await componentPinScale();
	const rawPins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentPrimitiveId);
	return flattenStateArray(rawPins as any[])
		.map((pin) => normalizePinToMil(pin, pinScale))
		.map((flat, index): PadInfo | undefined => {
			const x = firstFinite(flat.x, flat.centerX, flat.startX, flat.endX);
			const y = firstFinite(flat.y, flat.centerY, flat.startY, flat.endY);
			if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
			const layer = normalizeLayerSafe(flat.layer);
			const padNumber = stringOrUndefined(firstDefined(flat.padNumber, flat.pinNumber, flat.number, flat.name, index + 1));
			const net = stringOrUndefined(firstDefined(flat.net, flat.netName));
			const pin: PadInfo = {
				primitiveId: stringOrUndefined(firstDefined(flat.primitiveId, flat.id)),
				padNumber,
				net,
				layer,
				x,
				y,
				localX: 0,
				localY: 0,
				side: 'center' as PinSide,
				quadrant: 'center',
				rotation: Number.isFinite(Number(flat.rotation)) ? Number(flat.rotation) : undefined,
				componentPrimitiveId,
				componentDesignator,
			};
			return pin;
		})
		.filter((pin): pin is PadInfo => pin != null);
}

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

function decoratePinLocal(pin: PadInfo, origin: Point): PadInfo {
	const localX = pin.x - origin.x;
	const localY = pin.y - origin.y;
	return {
		...pin,
		localX,
		localY,
		side: sideForLocal(localX, localY),
		quadrant: quadrantForLocal(localX, localY),
	};
}

function selectContextComponents(allRaw: any[], target: ComponentInfo, params: Record<string, any>): any[] {
	const maxContext = Math.max(0, Math.floor(Number(params.maxContextComponents ?? 120)));
	const radius = Number(params.neighborRadiusMil ?? 2500);
	const scanAll = !!params.scanAll;
	const rows = allRaw
		.map((raw) => {
			const primitiveId = stringOrUndefined(readField(raw, 'PrimitiveId', 'primitiveId', 'id'));
			if (!primitiveId || primitiveId === target.primitiveId) return undefined;
			const x = numberOrNaN(readField(raw, 'X', 'x'));
			const y = numberOrNaN(readField(raw, 'Y', 'y'));
			const d = Number.isFinite(x) && Number.isFinite(y) ? distance(target.origin, { x, y }) : Number.POSITIVE_INFINITY;
			if (!scanAll && Number.isFinite(radius) && radius > 0 && d > radius) return undefined;
			return { raw, d };
		})
		.filter((row): row is { raw: any; d: number } => !!row)
		.sort((a, b) => a.d - b.d);
	return maxContext > 0 ? rows.slice(0, maxContext).map((row) => row.raw) : [];
}

function buildBoardIndex(components: ComponentInfo[]): Map<string, IndexedPad[]> {
	const byNet = new Map<string, IndexedPad[]>();
	for (const component of components) {
		for (const pin of component.pins) {
			const net = cleanNet(pin.net);
			if (!net) continue;
			const list = byNet.get(net) ?? [];
			list.push({
				...pin,
				componentPrimitiveId: component.primitiveId,
				componentDesignator: component.designator,
			});
			byNet.set(net, list);
		}
	}
	return byNet;
}

function buildSuggestionResult(info: ComponentInfo, board: Map<string, IndexedPad[]>, params: Record<string, any>): any {
	const rotations = resolveCandidateRotations(params, info.rotation);
	const scores = rotations.map((rotation) => scoreRotation(info, rotation, board, params));
	const current = scores.find((s) => sameAngle(s.rotation, info.rotation)) ?? scoreRotation(info, info.rotation, board, params);
	const recommended = scores.slice().sort((a, b) => a.score - b.score)[0] ?? current;
	const improvementScoreMil = Math.max(0, current.score - recommended.score);
	const improvementPercent = current.score > 0 ? round((improvementScoreMil / current.score) * 100, 1) : 0;
	const safeToApply = !info.primitiveLock && recommended.collisionCount === 0;

	return {
		component: summarizeComponent(info),
		currentRotation: info.rotation,
		recommendedRotation: recommended.rotation,
		currentIsBest: sameAngle(current.rotation, recommended.rotation),
		safeToApply,
		improvementScoreMil: round(improvementScoreMil, 1),
		improvementPercent,
		reasons: buildReasons(info, current, recommended, improvementPercent),
		currentScore: stripScorePairs(current),
		recommendedScore: stripScorePairs(recommended),
		scoreBreakdown: scores
			.slice()
			.sort((a, b) => a.rotation - b.rotation)
			.map(stripScorePairs),
		targetPairs: recommended.targetPairs.slice(0, Math.max(0, Math.floor(Number(params.targetPairLimit ?? 20)))),
		units: 'mil',
		note: 'Scores combine approximate same-net ratline length, rough crossings, pad-facing direction, and bounding-box collision risk.',
	};
}

function scoreRotation(
	info: ComponentInfo,
	rotation: number,
	board: Map<string, IndexedPad[]>,
	params: Record<string, any>,
): RotationScore {
	const pins = transformPins(info, rotation);
	const bodyPaddingMil = Number(params.bodyPaddingMil ?? 40);
	const clearanceMil = Number(params.clearanceMil ?? 20);
	const bounds = boundsForPins(pins);
	const targetPairs: Array<Record<string, any>> = [];
	const ratlines: Array<{ a: Point; b: Point; net: string }> = [];
	let ratlineLengthMil = 0;
	let targetedPadCount = 0;
	let unmatchedPadCount = 0;
	let facingAwayCount = 0;

	for (const pin of pins) {
		const net = cleanNet(pin.net);
		if (!net) continue;
		const target = nearestSameNetTarget(pin, board, info.primitiveId);
		if (!target) {
			unmatchedPadCount += 1;
			continue;
		}
		const d = distance(pin, target);
		const outward = normalizeVector({ x: pin.localX, y: pin.localY });
		const towardTarget = normalizeVector({ x: target.x - pin.x, y: target.y - pin.y });
		const facingDot = dot(outward, towardTarget);
		if (Math.hypot(pin.localX, pin.localY) > 5 && facingDot < -0.25) facingAwayCount += 1;
		targetedPadCount += 1;
		ratlineLengthMil += d;
		ratlines.push({ a: pin, b: target, net });
		targetPairs.push({
			pad: padLabel(pin),
			target: padLabel(target),
			net,
			distanceMil: round(d, 1),
			facingDot: round(facingDot, 2),
			padSide: pin.side,
			point: { x: round(pin.x, 3), y: round(pin.y, 3) },
			targetPoint: { x: round(target.x, 3), y: round(target.y, 3) },
		});
	}

	const crossingCount = countRatlineCrossings(ratlines);
	const collisionInfo = countCollisions(info, pins, bounds, board, bodyPaddingMil, clearanceMil);
	const score =
		ratlineLengthMil +
		crossingCount * Number(params.crossingPenaltyMil ?? 250) +
		facingAwayCount * Number(params.facingAwayPenaltyMil ?? 120) +
		collisionInfo.count * Number(params.collisionPenaltyMil ?? 5000);

	return {
		rotation: normalizeAngle(rotation),
		score: round(score, 1),
		ratlineLengthMil: round(ratlineLengthMil, 1),
		targetedPadCount,
		unmatchedPadCount,
		crossingCount,
		facingAwayCount,
		collisionCount: collisionInfo.count,
		collisions: collisionInfo.collisions,
		bounds,
		targetPairs,
	};
}

function countCollisions(
	info: ComponentInfo,
	pins: PadInfo[],
	bounds: Bounds | undefined,
	board: Map<string, IndexedPad[]>,
	bodyPaddingMil: number,
	clearanceMil: number,
): { count: number; collisions: Array<Record<string, any>> } {
	if (!bounds) return { count: 0, collisions: [] };
	const candidateBounds = expandBounds(bounds, bodyPaddingMil + clearanceMil);
	const seen = new Map<string, IndexedPad[]>();
	for (const pads of board.values()) {
		for (const pad of pads) {
			if (pad.componentPrimitiveId === info.primitiveId) continue;
			const list = seen.get(pad.componentPrimitiveId) ?? [];
			list.push(pad);
			seen.set(pad.componentPrimitiveId, list);
		}
	}

	const collisions: Array<Record<string, any>> = [];
	for (const [componentPrimitiveId, componentPins] of seen) {
		const otherBounds = boundsForPins(componentPins);
		if (!otherBounds) continue;
		const expandedOther = expandBounds(otherBounds, bodyPaddingMil);
		if (!boundsOverlap(candidateBounds, expandedOther)) continue;
		collisions.push({
			componentPrimitiveId,
			designator: componentPins[0]?.componentDesignator,
			overlapAreaMil2: round(overlapArea(candidateBounds, expandedOther), 1),
		});
	}

	return { count: collisions.length, collisions: collisions.slice(0, 10) };
}

function transformPins(info: ComponentInfo, rotation: number): PadInfo[] {
	const delta = degToRad(normalizeAngle(rotation) - info.rotation);
	return info.pins.map((pin) => {
		const local = rotatePoint({ x: pin.localX, y: pin.localY }, delta);
		return {
			...pin,
			x: info.origin.x + local.x,
			y: info.origin.y + local.y,
			localX: local.x,
			localY: local.y,
			side: sideForLocal(local.x, local.y),
			quadrant: quadrantForLocal(local.x, local.y),
		};
	});
}

function nearestSameNetTarget(pin: PadInfo, board: Map<string, IndexedPad[]>, excludeComponentId: string): IndexedPad | undefined {
	const net = cleanNet(pin.net);
	if (!net) return undefined;
	const candidates = board.get(net) ?? [];
	let best: IndexedPad | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		if (candidate.componentPrimitiveId === excludeComponentId) continue;
		const d = distance(pin, candidate);
		if (d < bestDistance) {
			best = candidate;
			bestDistance = d;
		}
	}
	return best;
}

function resolveCandidateRotations(params: Record<string, any>, currentRotation: number): number[] {
	const raw = Array.isArray(params.candidateRotations) && params.candidateRotations.length > 0
		? params.candidateRotations
		: DEFAULT_CANDIDATE_ROTATIONS;
	const out: number[] = [];
	for (const value of [...raw, currentRotation]) {
		const angle = normalizeAngle(Number(value));
		if (Number.isFinite(angle) && !out.some((existing) => sameAngle(existing, angle))) out.push(angle);
	}
	return out;
}

function buildReasons(info: ComponentInfo, current: RotationScore, recommended: RotationScore, improvementPercent: number): string[] {
	const reasons: string[] = [];
	if (info.primitiveLock) reasons.push('Component is locked; do not rotate unless you explicitly unlock/override.');
	if (recommended.targetedPadCount === 0) reasons.push('No same-net target pads were found in the scanned context, so the rotation score is weak.');
	if (sameAngle(current.rotation, recommended.rotation)) reasons.push('Current rotation is already best among the tested candidates by this heuristic.');
	if (recommended.ratlineLengthMil < current.ratlineLengthMil) {
		reasons.push(`Approximate same-net ratline length improves by ${round(current.ratlineLengthMil - recommended.ratlineLengthMil, 1)} mil (${improvementPercent}%).`);
	}
	if (recommended.crossingCount < current.crossingCount) {
		reasons.push(`Estimated straight-line net crossings drop from ${current.crossingCount} to ${recommended.crossingCount}.`);
	}
	if (recommended.facingAwayCount < current.facingAwayCount) {
		reasons.push(`Fewer pads face away from their nearest same-net target (${current.facingAwayCount} -> ${recommended.facingAwayCount}).`);
	}
	if (recommended.collisionCount > 0) {
		reasons.push(`Recommended rotation has ${recommended.collisionCount} approximate footprint collision(s); inspect before applying.`);
	}
	return reasons;
}

function stripScorePairs(score: RotationScore): Record<string, any> {
	const { targetPairs: _targetPairs, ...rest } = score;
	return rest;
}

function summarizeComponent(info: ComponentInfo): Record<string, any> {
	return {
		primitiveId: info.primitiveId,
		designator: info.designator,
		name: info.name,
		layer: info.layer,
		x: round(info.origin.x, 3),
		y: round(info.origin.y, 3),
		rotation: info.rotation,
		primitiveLock: info.primitiveLock,
		pinCount: info.pins.length,
	};
}

function summarizePin(pin: PadInfo): Record<string, any> {
	return {
		primitiveId: pin.primitiveId,
		reference: pin.componentDesignator,
		padNumber: pin.padNumber,
		label: padLabel(pin),
		net: pin.net,
		layer: pin.layer,
		x: round(pin.x, 3),
		y: round(pin.y, 3),
		localX: round(pin.localX, 3),
		localY: round(pin.localY, 3),
		side: pin.side,
		quadrant: pin.quadrant,
		rotation: pin.rotation,
	};
}

function buildSideSummary(pins: PadInfo[]): Record<string, string[]> {
	const summary: Record<string, string[]> = { left: [], right: [], top: [], bottom: [], center: [] };
	for (const pin of pins) summary[pin.side].push(padLabel(pin));
	return summary;
}

function buildNetSummary(pins: PadInfo[]): Record<string, Record<string, any>> {
	const out: Record<string, Record<string, any>> = {};
	for (const pin of pins) {
		const net = cleanNet(pin.net) || '(no net)';
		const entry = out[net] ?? { count: 0, sides: { left: 0, right: 0, top: 0, bottom: 0, center: 0 }, pads: [] };
		entry.count += 1;
		entry.sides[pin.side] += 1;
		entry.pads.push(padLabel(pin));
		out[net] = entry;
	}
	return out;
}

function countRatlineCrossings(ratlines: Array<{ a: Point; b: Point; net: string }>): number {
	let count = 0;
	for (let i = 0; i < ratlines.length; i++) {
		for (let j = i + 1; j < ratlines.length; j++) {
			if (ratlines[i].net === ratlines[j].net) continue;
			if (sharesEndpoint(ratlines[i], ratlines[j])) continue;
			if (segmentsIntersect(ratlines[i].a, ratlines[i].b, ratlines[j].a, ratlines[j].b)) count += 1;
		}
	}
	return count;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
	const o1 = orient(a, b, c);
	const o2 = orient(a, b, d);
	const o3 = orient(c, d, a);
	const o4 = orient(c, d, b);
	return o1 * o2 < 0 && o3 * o4 < 0;
}

function sharesEndpoint(a: { a: Point; b: Point }, b: { a: Point; b: Point }): boolean {
	return distance(a.a, b.a) < 1e-6 || distance(a.a, b.b) < 1e-6 || distance(a.b, b.a) < 1e-6 || distance(a.b, b.b) < 1e-6;
}

function orient(a: Point, b: Point, c: Point): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function sideForLocal(x: number, y: number): PinSide {
	if (Math.hypot(x, y) <= 1e-6) return 'center';
	if (Math.abs(x) >= Math.abs(y)) return x < 0 ? 'left' : 'right';
	return y < 0 ? 'top' : 'bottom';
}

function quadrantForLocal(x: number, y: number): string {
	if (Math.hypot(x, y) <= 1e-6) return 'center';
	const vertical = y < 0 ? 'top' : 'bottom';
	const horizontal = x < 0 ? 'left' : 'right';
	return `${vertical}_${horizontal}`;
}

function boundsForPins(pins: Array<Pick<PadInfo, 'x' | 'y'>>): Bounds | undefined {
	return boundsForPoints(pins);
}

function boundsForPoints(points: Array<Pick<Point, 'x' | 'y'>>): Bounds | undefined {
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
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function expandBounds(bounds: Bounds, amount: number): Bounds {
	const minX = bounds.minX - amount;
	const minY = bounds.minY - amount;
	const maxX = bounds.maxX + amount;
	const maxY = bounds.maxY + amount;
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function overlapArea(a: Bounds, b: Bounds): number {
	const w = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
	const h = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
	return w * h;
}

function readField(raw: any, stateName: string, ...flatNames: string[]): any {
	try {
		const getter = raw?.[`getState_${stateName}`];
		if (typeof getter === 'function') return getter.call(raw);
	} catch {
		/* ignore */
	}
	const flat = flattenState(raw);
	for (const name of flatNames) {
		if (flat?.[name] != null) return flat[name];
	}
	return undefined;
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

function numberOrNaN(value: any): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : Number.NaN;
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

function cleanNet(value: any): string | undefined {
	const s = stringOrUndefined(value);
	if (!s || s === '(no net)') return undefined;
	return s;
}

function unique<T>(values: T[]): T[] {
	return Array.from(new Set(values));
}

function normalizeLayerSafe(layer: any): any {
	try {
		return layer != null ? normalizeLayer(layer) : undefined;
	} catch {
		return layer;
	}
}

function normalizeAngle(angle: number): number {
	if (!Number.isFinite(angle)) return 0;
	const n = angle % 360;
	return n < 0 ? n + 360 : n;
}

function sameAngle(a: number, b: number): boolean {
	return Math.abs(normalizeAngle(a) - normalizeAngle(b)) < 1e-6;
}

function degToRad(deg: number): number {
	return deg * Math.PI / 180;
}

function rotatePoint(p: Point, radians: number): Point {
	const c = Math.cos(radians);
	const s = Math.sin(radians);
	return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalizeVector(v: Point): Point {
	const len = Math.hypot(v.x, v.y);
	if (!Number.isFinite(len) || len <= 1e-9) return { x: 0, y: 0 };
	return { x: v.x / len, y: v.y / len };
}

function dot(a: Point, b: Point): number {
	return a.x * b.x + a.y * b.y;
}

function padLabel(pin: Pick<PadInfo, 'componentDesignator' | 'padNumber' | 'primitiveId'>): string {
	if (pin.componentDesignator && pin.padNumber != null) return `${pin.componentDesignator}.${pin.padNumber}`;
	return pin.padNumber != null ? String(pin.padNumber) : String(pin.primitiveId ?? '(pad)');
}

function round(value: number, digits = 0): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}
