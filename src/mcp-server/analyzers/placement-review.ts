// Placement review analyzer — pure TS, no SDK.
//
// Consumes a placement snapshot produced MCP-side by the `pcb.placement.review`
// extension handler. That handler builds the snapshot from the same loaders the
// rest of placement.ts uses, so EVERY coordinate here is already in **mil**
// (component-pin coordinates are ×10-scaled by `normalizePinToMil`; board-outline
// line coordinates are native mil). Do NOT re-scale.
//
// Findings reuse the EmcFinding shape (so they slot into the same renderers /
// aggregators) extended with a `confidence` field — mirroring pcb-emc.ts.
//
// Rules:
//   PLC-001 courtyard overlap between two components
//   PLC-002 component-to-component edge-to-edge clearance below threshold
//   PLC-003 decoupling cap too far from its IC's nearest power pad (mirrors
//           pcb-emc.ts pcbDecouplingProximity, emits a suggested move)
//   PLC-004 connector/usb_connector not within edgeMargin of the board edge

import type { EmcFinding } from './emc';

export interface PlacementFinding extends EmcFinding {
	confidence: 'high' | 'medium' | 'low';
	/** Suggested move for the *first* designator, in mil. Present on PLC-003. */
	suggestedMove?: { deltaX: number; deltaY: number; deltaRotation: number };
}

// ---- Snapshot shape (what pcb.placement.review returns) ---------------------

export interface PlacementPad {
	designator?: string;
	padNumber?: string;
	net?: string;
	/** Absolute pad center in mil. */
	x: number;
	y: number;
}

export interface PlacementComponent {
	primitiveId: string;
	designator?: string;
	name?: string;
	layer?: string | number;
	/** Component origin in mil. */
	x: number;
	y: number;
	rotation: number;
	primitiveLock?: boolean;
	/** Absolute pad positions (mil). */
	pads: PlacementPad[];
}

export interface PlacementSnapshot {
	units?: string;
	components: PlacementComponent[];
	/** Board outline bbox in mil, if a board-outline layer was present. */
	boardOutline?: {
		bounds?: Bounds;
		lineCount?: number;
	};
}

export interface PlacementReviewOptions {
	/** Padding around the pad-extent bbox to approximate the component body (mil). */
	bodyPaddingMil?: number;
	/** Min edge-to-edge courtyard clearance before PLC-002 fires (mil). */
	clearanceMil?: number;
	/** Max distance from a decoupling cap to its IC power pad before PLC-003 fires (mil). */
	decouplingMaxMil?: number;
	/** How close a connector courtyard center must be to the board edge (mil). */
	edgeMarginMil?: number;
}

export interface PlacementReviewResult {
	findings: PlacementFinding[];
	suggestions: Array<{
		designator?: string;
		primitiveId: string;
		deltaX: number;
		deltaY: number;
		deltaRotation: number;
		score: number;
		reason: string;
		ruleId: string;
	}>;
	courtyardCount: number;
	outlineSource: 'board_outline' | 'component_bbox_union' | 'none';
}

export interface PlacementScoreOptions {
	decouplingMaxMil?: number;
	includeSinglePadNets?: boolean;
	maxRatsnestSegments?: number;
}

export interface PlacementScoreResult {
	units: 'mil';
	componentCount: number;
	netCount: number;
	ratsnestSegmentCount: number;
	totalHpwlMil: number;
	crossingCount: number;
	decoupling: {
		thresholdMil: number;
		rowCount: number;
		withinThreshold: number;
		violations: number;
		rows: DecouplingDistanceRow[];
	};
	topNetsByHpwl: NetPlacementMetric[];
	summary: string;
}

export interface NetPlacementMetric {
	net: string;
	padCount: number;
	componentCount: number;
	hpwlMil: number;
	bounds: Bounds;
}

export interface DecouplingDistanceRow {
	ic: string;
	cap?: string;
	net: string;
	icPad?: string;
	capPad?: string;
	distanceMil?: number;
	thresholdMil: number;
	withinThreshold: boolean;
	status: 'ok' | 'far' | 'missing_cap';
	suggestedMove?: { designator?: string; primitiveId: string; deltaX: number; deltaY: number };
}

export interface PlacementClusterOptions {
	includeLoosePassives?: boolean;
	maxClusters?: number;
	maxMembersPerCluster?: number;
	decouplingMaxMil?: number;
}

export interface PlacementCluster {
	id: string;
	anchor: {
		primitiveId: string;
		designator?: string;
		x: number;
		y: number;
		layer?: string | number;
	};
	members: Array<{
		primitiveId: string;
		designator?: string;
		role: 'anchor' | 'decoupling_cap' | 'immediate_passive';
		net?: string;
		distanceMil?: number;
		x: number;
		y: number;
		layer?: string | number;
	}>;
	pinProximityTargets: Array<{
		component: string;
		targetComponent: string;
		net: string;
		sourcePad?: string;
		targetPad?: string;
		currentDistanceMil: number;
		targetDistanceMil: number;
	}>;
	hpwlMil: number;
	bounds?: Bounds;
}

export interface PlacementClusterResult {
	units: 'mil';
	clusterCount: number;
	clusters: PlacementCluster[];
	looseComponentCount: number;
	summary: string;
}

export interface PlacementClusterPlanOptions {
	anchor?: string;
	primitiveId?: string;
	reference?: string;
	designator?: string;
	includeDecouplingCaps?: boolean;
	includeImmediatePassives?: boolean;
	targetDistanceMil?: number;
	immediatePassiveDistanceMil?: number;
	gridMil?: number;
	maxMoves?: number;
	respectLocked?: boolean;
	avoidCollisions?: boolean;
	clearanceMil?: number;
	bodyPaddingMil?: number;
	decouplingMaxMil?: number;
	maxClusters?: number;
	maxMembersPerCluster?: number;
	maxRatsnestSegments?: number;
}

export interface PlacementClusterMove {
	primitiveId: string;
	designator?: string;
	role: 'decoupling_cap' | 'immediate_passive';
	net?: string;
	layer?: string | number;
	from: { x: number; y: number };
	to: { x: number; y: number };
	dx: number;
	dy: number;
	distanceBeforeMil?: number;
	estimatedDistanceAfterMil?: number;
	targetDistanceMil: number;
	sourcePad?: string;
	targetPad?: string;
	status: 'planned' | 'skipped';
	skipped?: boolean;
	skipReason?: string;
	collision?: {
		withPrimitiveId: string;
		withDesignator?: string;
		gapMil: number;
	};
	reason: string;
}

export interface PlacementClusterPlanResult {
	units: 'mil';
	anchor: PlacementCluster['anchor'];
	cluster: PlacementCluster;
	options: {
		targetDistanceMil: number;
		immediatePassiveDistanceMil: number;
		gridMil: number;
		maxMoves: number;
		respectLocked: boolean;
		avoidCollisions: boolean;
		clearanceMil: number;
		bodyPaddingMil: number;
	};
	moveCount: number;
	skippedCount: number;
	moves: PlacementClusterMove[];
	scoreBefore: PlacementScoreResult;
	scoreAfterEstimate: PlacementScoreResult;
	estimatedDelta: {
		hpwlMil: number;
		crossingCount: number;
		decouplingViolations: number;
	};
	warnings: string[];
	summary: string;
}

export interface PlacementOptimizationOptions {
	groupMode?: 'components' | 'clusters' | 'mixed';
	references?: string[];
	primitiveIds?: string[];
	stepMil?: number;
	gridMil?: number;
	passes?: number;
	limit?: number;
	maxGroups?: number;
	minImprovementMil?: number;
	respectLocked?: boolean;
	skipConnectors?: boolean;
	skipMechanical?: boolean;
	avoidCollisions?: boolean;
	avoidBoardEdge?: boolean;
	clearanceMil?: number;
	boardMarginMil?: number;
	bodyPaddingMil?: number;
	decouplingMaxMil?: number;
	crossingPenaltyMil?: number;
	decouplingPenaltyMil?: number;
	maxRatsnestSegments?: number;
	maxClusters?: number;
	maxMembersPerCluster?: number;
}

export interface PlacementOptimizationMove {
	id: string;
	groupType: 'component' | 'cluster';
	pass: number;
	primitiveIds: string[];
	designators: string[];
	anchor?: PlacementCluster['anchor'];
	fromCenter: { x: number; y: number };
	toCenter: { x: number; y: number };
	dx: number;
	dy: number;
	componentMoves: Array<{
		primitiveId: string;
		designator?: string;
		from: { x: number; y: number };
		to: { x: number; y: number };
	}>;
	objectiveBefore: number;
	objectiveAfter: number;
	objectiveDelta: number;
	hpwlDeltaMil: number;
	crossingDelta: number;
	decouplingViolationDelta: number;
	reason: string;
}

export interface PlacementOptimizationResult {
	units: 'mil';
	groupMode: 'components' | 'clusters' | 'mixed';
	scannedGroupCount: number;
	skippedGroupCount: number;
	moveCount: number;
	moves: PlacementOptimizationMove[];
	skippedGroups: Array<{
		id: string;
		groupType: 'component' | 'cluster';
		primitiveIds: string[];
		designators: string[];
		reason: string;
	}>;
	scoreBefore: PlacementScoreResult;
	scoreAfterEstimate: PlacementScoreResult;
	objectiveBefore: number;
	objectiveAfterEstimate: number;
	estimatedDelta: {
		hpwlMil: number;
		crossingCount: number;
		decouplingViolations: number;
		objective: number;
	};
	options: {
		stepMil: number;
		gridMil: number;
		passes: number;
		limit: number;
		minImprovementMil: number;
		respectLocked: boolean;
		avoidCollisions: boolean;
		avoidBoardEdge: boolean;
		clearanceMil: number;
		bodyPaddingMil: number;
		crossingPenaltyMil: number;
		decouplingPenaltyMil: number;
	};
	warnings: string[];
	summary: string;
}

// ---- Geometry helpers ------------------------------------------------------

export interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
}

interface Courtyard {
	component: PlacementComponent;
	bounds: Bounds;
	center: { x: number; y: number };
}

const CAP_REF_RE = /^C\d/i;
const IC_REF_RE = /^(U|IC|REG)\d/i;
const PASSIVE_REF_RE = /^(R|C|L|FB|D)\d/i;
const CONNECTOR_REF_RE = /^(J|CN|CON|P|USB|X)\d/i;
const POWER_PIN_NET_RE = /VCC|VDD|V\+|VIN|VOUT|3V3|5V|1V8|1V2|2V5|VBUS|VSYS|VBAT|AVDD|DVDD/i;
const POWER_NET_RE = /^[+\-_]*(VCC|VDD|V\+|VIN|VOUT|3V3|5V|1V8|1V2|2V5|VBAT|VBUS|VSYS|VAUX|AVDD|DVDD|VPP)/i;

function boundsFromPoints(points: Array<{ x: number; y: number }>): Bounds | undefined {
	const finite = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
	if (finite.length === 0) return undefined;
	let minX = finite[0].x;
	let maxX = finite[0].x;
	let minY = finite[0].y;
	let maxY = finite[0].y;
	for (const p of finite) {
		if (p.x < minX) minX = p.x;
		if (p.x > maxX) maxX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.y > maxY) maxY = p.y;
	}
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function padBounds(b: Bounds, amount: number): Bounds {
	const minX = b.minX - amount;
	const minY = b.minY - amount;
	const maxX = b.maxX + amount;
	const maxY = b.maxY + amount;
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

/** Edge-to-edge gap between two axis-aligned bboxes. Negative when overlapping. */
function edgeGap(a: Bounds, b: Bounds): number {
	const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX);
	const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY);
	if (dx <= 0 && dy <= 0) return Math.max(dx, dy); // overlapping (negative)
	if (dx <= 0) return dy;
	if (dy <= 0) return dx;
	return Math.hypot(dx, dy);
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function round(value: number, digits = 1): number {
	const f = 10 ** digits;
	return Math.round(value * f) / f;
}

// ---- Public API ------------------------------------------------------------

/** Derive an approximate courtyard bbox from a component's pad extents, padded.
 *  Pads are expected in mil (the placement handler scales them). Falls back to
 *  a small box around the component origin when it has no pads. */
export function deriveCourtyard(component: PlacementComponent, bodyPaddingMil = 40): Bounds {
	const pts = (component.pads ?? []).map((p) => ({ x: p.x, y: p.y }));
	const base = boundsFromPoints(pts);
	if (base) return padBounds(base, bodyPaddingMil);
	// No pads: synthesize a tiny box around the origin so overlap checks still work.
	const x = component.x;
	const y = component.y;
	return padBounds({ minX: x, minY: y, maxX: x, maxY: y, width: 0, height: 0 }, bodyPaddingMil);
}

/** Score a suggested move. Lower distance + simpler move ⇒ higher score (0..1). */
export function scoreSuggestion(args: {
	deltaX: number;
	deltaY: number;
	deltaRotation?: number;
	maxMil?: number;
}): { deltaX: number; deltaY: number; deltaRotation: number; score: number } {
	const deltaRotation = args.deltaRotation ?? 0;
	const moveMil = Math.hypot(args.deltaX, args.deltaY);
	const maxMil = args.maxMil && args.maxMil > 0 ? args.maxMil : 200;
	// Closer moves (relative to the threshold) score higher. Rotations cost a bit.
	const distScore = Math.max(0, 1 - moveMil / (maxMil * 2));
	const rotPenalty = deltaRotation !== 0 ? 0.1 : 0;
	const score = Math.max(0, Math.min(1, distScore - rotPenalty));
	return { deltaX: round(args.deltaX, 2), deltaY: round(args.deltaY, 2), deltaRotation, score: round(score, 3) };
}

function classifyConnector(c: PlacementComponent): 'usb_connector' | 'connector' | null {
	const ref = (c.designator ?? '').toUpperCase();
	const name = `${c.name ?? ''} ${c.designator ?? ''}`.toUpperCase();
	if (/USB|TYPE-?C|TYPEC/.test(name)) return 'usb_connector';
	if (CONNECTOR_REF_RE.test(ref)) return 'connector';
	return null;
}

function isPowerNet(net: string | undefined): boolean {
	if (!net) return false;
	const stripped = net.replace(/^[+\-_]+/, '').replace(/^V_/i, '');
	return POWER_NET_RE.test(net) || POWER_PIN_NET_RE.test(net) || /^\d+(V\d+|V|\.\d+V)/.test(stripped);
}

export function analyzePlacement(
	snapshot: PlacementSnapshot,
	opts: PlacementReviewOptions = {},
): PlacementReviewResult {
	const bodyPaddingMil = opts.bodyPaddingMil ?? 40;
	const clearanceMil = opts.clearanceMil ?? 8;
	const decouplingMaxMil = opts.decouplingMaxMil ?? 150;
	const edgeMarginMil = opts.edgeMarginMil ?? 250;

	const components = Array.isArray(snapshot.components) ? snapshot.components : [];
	const findings: PlacementFinding[] = [];
	const suggestions: PlacementReviewResult['suggestions'] = [];

	// Build courtyards once.
	const courtyards: Courtyard[] = components.map((component) => {
		const bounds = deriveCourtyard(component, bodyPaddingMil);
		return { component, bounds, center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 } };
	});

	// ---- PLC-001 / PLC-002 : pairwise courtyard overlap + clearance ----------
	for (let i = 0; i < courtyards.length; i++) {
		for (let j = i + 1; j < courtyards.length; j++) {
			const a = courtyards[i];
			const b = courtyards[j];
			// Only compare same-layer parts (top vs bottom can legitimately overlap).
			if (a.component.layer != null && b.component.layer != null
				&& String(a.component.layer) !== String(b.component.layer)) continue;

			const refA = a.component.designator ?? a.component.primitiveId;
			const refB = b.component.designator ?? b.component.primitiveId;

			if (boundsOverlap(a.bounds, b.bounds)) {
				const area = overlapArea(a.bounds, b.bounds);
				findings.push({
					ruleId: 'PLC-001',
					category: 'connector_hygiene',
					severity: 'critical',
					title: `Courtyard overlap: ${refA} and ${refB}`,
					detail: `Approximate courtyards (pad extents +${bodyPaddingMil} mil) overlap by ~${round(area, 0)} mil². Components likely physically collide or violate spacing.`,
					designators: [String(refA), String(refB)],
					confidence: 'medium',
					suggestion: 'Separate these components; pad-extent courtyards are approximate, so verify against the real footprint courtyards in the editor.',
					values: { overlapAreaMil2: round(area, 0) },
				});
				continue; // overlap supersedes the clearance check
			}

			const gap = edgeGap(a.bounds, b.bounds);
			if (gap < clearanceMil) {
				findings.push({
					ruleId: 'PLC-002',
					category: 'connector_hygiene',
					severity: 'warning',
					title: `Tight clearance: ${refA}–${refB} ~${round(gap, 1)} mil`,
					detail: `Edge-to-edge courtyard gap (${round(gap, 1)} mil) is below the ${clearanceMil} mil threshold. May fail DFM/assembly spacing.`,
					designators: [String(refA), String(refB)],
					confidence: 'medium',
					suggestion: `Increase spacing to at least ${clearanceMil} mil edge-to-edge.`,
					values: { gapMil: round(gap, 1), threshold: clearanceMil },
				});
			}
		}
	}

	// ---- PLC-003 : decoupling cap far from its IC power pad -------------------
	// Mirror pcb-emc.ts pcbDecouplingProximity, but operate on courtyard/pad
	// geometry and emit a suggested move toward the IC pad.
	const caps = courtyards.filter((c) => CAP_REF_RE.test(c.component.designator ?? ''));
	for (const cyIc of courtyards) {
		const ic = cyIc.component;
		if (!IC_REF_RE.test(ic.designator ?? '')) continue;
		// IC power pads (by net heuristic — same approach as pcb-emc.ts).
		const powerPads = (ic.pads ?? []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && isPowerNet(p.net));
		if (powerPads.length === 0) continue;

		// Group power pads by net so each rail is evaluated independently.
		const railNets = new Set(powerPads.map((p) => p.net ?? ''));
		for (const rail of railNets) {
			if (!rail) continue;
			const railPads = powerPads.filter((p) => (p.net ?? '') === rail);
			// Caps whose pads touch this rail.
			const railCaps = caps.filter((c) => (c.component.pads ?? []).some((p) => (p.net ?? '') === rail));
			if (railCaps.length === 0) continue; // missing-cap case is pcb-emc's PCB-DEC-001, not ours

			// Nearest IC power pad ↔ nearest cap pad on this rail.
			let bestPadDist = Infinity;
			let nearestIcPad: PlacementPad | undefined;
			let nearestCap: Courtyard | undefined;
			let nearestCapPad: PlacementPad | undefined;
			for (const icPad of railPads) {
				for (const cap of railCaps) {
					for (const capPad of cap.component.pads ?? []) {
						if ((capPad.net ?? '') !== rail) continue;
						const d = dist(icPad, capPad);
						if (d < bestPadDist) {
							bestPadDist = d;
							nearestIcPad = icPad;
							nearestCap = cap;
							nearestCapPad = capPad;
						}
					}
				}
			}
			if (!nearestCap || !nearestIcPad || !nearestCapPad || !Number.isFinite(bestPadDist)) continue;
			if (bestPadDist <= decouplingMaxMil) continue;

			const capRef = nearestCap.component.designator ?? nearestCap.component.primitiveId;
			const icRef = ic.designator ?? ic.primitiveId;
			// Suggested move: shift the cap so its rail pad lands ~decouplingMaxMil from the IC pad.
			const vx = nearestIcPad.x - nearestCapPad.x;
			const vy = nearestIcPad.y - nearestCapPad.y;
			const moveLen = Math.max(0, bestPadDist - decouplingMaxMil);
			const ux = bestPadDist > 0 ? vx / bestPadDist : 0;
			const uy = bestPadDist > 0 ? vy / bestPadDist : 0;
			const deltaX = ux * moveLen;
			const deltaY = uy * moveLen;
			const scored = scoreSuggestion({ deltaX, deltaY, maxMil: decouplingMaxMil });

			findings.push({
				ruleId: 'PLC-003',
				category: 'decoupling',
				severity: 'warning',
				title: `Decoupling cap ${capRef} is ${round(bestPadDist, 0)} mil from ${icRef} on ${rail}`,
				detail: `Cap ${capRef} (rail ${rail}) sits ${round(bestPadDist, 0)} mil (${round(bestPadDist * 0.0254, 2)} mm) from the nearest power pad of ${icRef}. Decoupling is most effective < ${decouplingMaxMil} mil from the pin.`,
				designators: [String(icRef), String(capRef)],
				netNames: [rail],
				confidence: 'medium',
				suggestion: `Move ${capRef} ~${round(moveLen, 0)} mil toward ${icRef} (Δx ${scored.deltaX}, Δy ${scored.deltaY} mil) using pcb_set_component_position.`,
				suggestedMove: scored,
				values: { distanceMil: round(bestPadDist, 0), threshold: decouplingMaxMil },
			});
			suggestions.push({
				designator: nearestCap.component.designator,
				primitiveId: nearestCap.component.primitiveId,
				deltaX: scored.deltaX,
				deltaY: scored.deltaY,
				deltaRotation: scored.deltaRotation,
				score: scored.score,
				reason: `Bring decoupling cap within ${decouplingMaxMil} mil of ${icRef} on ${rail}.`,
				ruleId: 'PLC-003',
			});
		}
	}

	// ---- PLC-004 : connectors should sit on the board edge -------------------
	let outlineBounds: Bounds | undefined = snapshot.boardOutline?.bounds;
	let outlineSource: PlacementReviewResult['outlineSource'] = 'none';
	if (outlineBounds && (snapshot.boardOutline?.lineCount ?? 0) > 0) {
		outlineSource = 'board_outline';
	} else {
		// Fallback: bbox-union of all component courtyards.
		outlineBounds = boundsFromPoints(
			courtyards.flatMap((c) => [
				{ x: c.bounds.minX, y: c.bounds.minY },
				{ x: c.bounds.maxX, y: c.bounds.maxY },
			]),
		);
		outlineSource = outlineBounds ? 'component_bbox_union' : 'none';
	}

	if (outlineBounds) {
		for (const cy of courtyards) {
			const kind = classifyConnector(cy.component);
			if (!kind) continue;
			const ref = cy.component.designator ?? cy.component.primitiveId;
			// Distance from courtyard center to the nearest outline edge.
			const dLeft = Math.abs(cy.center.x - outlineBounds.minX);
			const dRight = Math.abs(outlineBounds.maxX - cy.center.x);
			const dTop = Math.abs(cy.center.y - outlineBounds.minY);
			const dBottom = Math.abs(outlineBounds.maxY - cy.center.y);
			const nearestEdge = Math.min(dLeft, dRight, dTop, dBottom);
			if (nearestEdge <= edgeMarginMil) continue;

			findings.push({
				ruleId: 'PLC-004',
				category: 'connector_hygiene',
				severity: 'warning',
				title: `${kind === 'usb_connector' ? 'USB connector' : 'Connector'} ${ref} is not on a board edge`,
				detail: `Courtyard center of ${ref} is ${round(nearestEdge, 0)} mil from the nearest board edge (> ${edgeMarginMil} mil). Connectors usually belong on the board outline so cables/plugs reach them. Outline source: ${outlineSource}.`,
				designators: [String(ref)],
				confidence: outlineSource === 'board_outline' ? 'medium' : 'low',
				suggestion: 'Move this connector to a board edge; verify orientation so the mating face points outward.',
				values: { distanceToEdgeMil: round(nearestEdge, 0), threshold: edgeMarginMil },
			});
		}
	}

	return {
		findings,
		suggestions,
		courtyardCount: courtyards.length,
		outlineSource,
	};
}

export function scorePlacement(snapshot: PlacementSnapshot, opts: PlacementScoreOptions = {}): PlacementScoreResult {
	const components = Array.isArray(snapshot.components) ? snapshot.components : [];
	const byNet = buildNetPadIndex(components, !!opts.includeSinglePadNets);
	const netMetrics = Array.from(byNet.entries())
		.map(([net, pads]) => netPlacementMetric(net, pads))
		.filter((row): row is NetPlacementMetric => !!row)
		.sort((a, b) => b.hpwlMil - a.hpwlMil);
	const totalHpwlMil = round(netMetrics.reduce((sum, row) => sum + row.hpwlMil, 0), 1);
	const ratsnest = buildRatsnestSegments(byNet, Math.max(1, Math.floor(Number(opts.maxRatsnestSegments ?? 2000))));
	const crossingCount = countSegmentCrossings(ratsnest);
	const decouplingRows = buildDecouplingRows(components, opts.decouplingMaxMil ?? 150);
	const withinThreshold = decouplingRows.filter((row) => row.status === 'ok').length;
	const violations = decouplingRows.filter((row) => row.status !== 'ok').length;
	return {
		units: 'mil',
		componentCount: components.length,
		netCount: netMetrics.length,
		ratsnestSegmentCount: ratsnest.length,
		totalHpwlMil,
		crossingCount,
		decoupling: {
			thresholdMil: opts.decouplingMaxMil ?? 150,
			rowCount: decouplingRows.length,
			withinThreshold,
			violations,
			rows: decouplingRows,
		},
		topNetsByHpwl: netMetrics.slice(0, 25),
		summary: `${components.length} components, ${netMetrics.length} multi-pad nets, HPWL ${totalHpwlMil} mil, ${crossingCount} ratsnest crossings, ${violations} decoupling distance issue(s).`,
	};
}

export function extractPlacementClusters(snapshot: PlacementSnapshot, opts: PlacementClusterOptions = {}): PlacementClusterResult {
	const components = Array.isArray(snapshot.components) ? snapshot.components : [];
	const byRef = new Map(components.map((component) => [String(component.designator ?? component.primitiveId), component]));
	const anchors = components.filter((component) => IC_REF_RE.test(component.designator ?? ''));
	const maxClusters = Math.max(1, Math.floor(Number(opts.maxClusters ?? 100)));
	const maxMembers = Math.max(1, Math.floor(Number(opts.maxMembersPerCluster ?? 24)));
	const decouplingMaxMil = opts.decouplingMaxMil ?? 150;
	const clusters: PlacementCluster[] = [];
	const clustered = new Set<string>();

	for (const anchor of anchors.slice(0, maxClusters)) {
		const anchorRef = String(anchor.designator ?? anchor.primitiveId);
		const members = new Map<string, PlacementCluster['members'][number]>();
		members.set(anchor.primitiveId, {
			primitiveId: anchor.primitiveId,
			designator: anchor.designator,
			role: 'anchor',
			x: round(anchor.x, 3),
			y: round(anchor.y, 3),
			layer: anchor.layer,
		});
		const targets: PlacementCluster['pinProximityTargets'] = [];
		const anchorNets = new Set((anchor.pads ?? []).map((pad) => pad.net).filter((net): net is string => !!net));
		const powerPads = (anchor.pads ?? []).filter((pad) => isPowerNet(pad.net));

		for (const icPad of powerPads) {
			const net = icPad.net;
			if (!net) continue;
			const caps = components
				.filter((component) => component.primitiveId !== anchor.primitiveId)
				.filter((component) => CAP_REF_RE.test(component.designator ?? ''))
				.map((component) => nearestPadPair(anchor, icPad, component, net))
				.filter((row): row is NonNullable<ReturnType<typeof nearestPadPair>> => !!row)
				.sort((a, b) => a.distanceMil - b.distanceMil);
			for (const row of caps.slice(0, 4)) {
				members.set(row.component.primitiveId, {
					primitiveId: row.component.primitiveId,
					designator: row.component.designator,
					role: 'decoupling_cap',
					net,
					distanceMil: round(row.distanceMil, 1),
					x: round(row.component.x, 3),
					y: round(row.component.y, 3),
					layer: row.component.layer,
				});
				targets.push({
					component: String(row.component.designator ?? row.component.primitiveId),
					targetComponent: anchorRef,
					net,
					sourcePad: row.componentPad.padNumber,
					targetPad: icPad.padNumber,
					currentDistanceMil: round(row.distanceMil, 1),
					targetDistanceMil: decouplingMaxMil,
				});
			}
		}

		if (opts.includeLoosePassives !== false) {
			const passives = components
				.filter((component) => component.primitiveId !== anchor.primitiveId)
				.filter((component) => PASSIVE_REF_RE.test(component.designator ?? ''))
				.map((component) => {
					const shared = (component.pads ?? []).find((pad) => pad.net && anchorNets.has(pad.net));
					return shared?.net ? { component, net: shared.net, distanceMil: componentDistance(anchor, component) } : undefined;
				})
				.filter((row): row is { component: PlacementComponent; net: string; distanceMil: number } => !!row)
				.sort((a, b) => a.distanceMil - b.distanceMil);
			for (const row of passives) {
				if (members.size >= maxMembers) break;
				if (members.has(row.component.primitiveId)) continue;
				members.set(row.component.primitiveId, {
					primitiveId: row.component.primitiveId,
					designator: row.component.designator,
					role: 'immediate_passive',
					net: row.net,
					distanceMil: round(row.distanceMil, 1),
					x: round(row.component.x, 3),
					y: round(row.component.y, 3),
					layer: row.component.layer,
				});
			}
		}

		for (const member of members.values()) clustered.add(member.primitiveId);
		const memberComponents = Array.from(members.values())
			.map((member) => byRef.get(String(member.designator ?? member.primitiveId)))
			.filter((component): component is PlacementComponent => !!component);
		const memberPads = memberComponents.flatMap((component) => component.pads ?? []);
		const bounds = boundsFromPoints(memberComponents.flatMap((component) => [
			{ x: component.x, y: component.y },
			...(component.pads ?? []).map((pad) => ({ x: pad.x, y: pad.y })),
		]));
		clusters.push({
			id: anchorRef,
			anchor: {
				primitiveId: anchor.primitiveId,
				designator: anchor.designator,
				x: round(anchor.x, 3),
				y: round(anchor.y, 3),
				layer: anchor.layer,
			},
			members: Array.from(members.values()),
			pinProximityTargets: targets,
			hpwlMil: round(clusterHpwl(memberPads), 1),
			bounds,
		});
	}

	const looseComponentCount = components.filter((component) => !clustered.has(component.primitiveId)).length;
	return {
		units: 'mil',
		clusterCount: clusters.length,
		clusters,
		looseComponentCount,
		summary: `${clusters.length} IC/regulator cluster(s), ${looseComponentCount} loose component(s). Cluster members are derived from shared IC nets and decoupling power-pin proximity targets.`,
	};
}

export function planClusterPlacement(snapshot: PlacementSnapshot, opts: PlacementClusterPlanOptions = {}): PlacementClusterPlanResult {
	const components = Array.isArray(snapshot.components) ? snapshot.components : [];
	const decouplingMaxMil = positiveOrDefault(opts.decouplingMaxMil ?? opts.targetDistanceMil, 150);
	const targetDistanceMil = positiveOrDefault(opts.targetDistanceMil ?? opts.decouplingMaxMil, decouplingMaxMil);
	const immediatePassiveDistanceMil = positiveOrDefault(opts.immediatePassiveDistanceMil, targetDistanceMil * 1.8);
	const gridMil = positiveOrDefault(opts.gridMil, 25);
	const maxMoves = Math.max(1, Math.floor(Number(opts.maxMoves ?? 12)));
	const respectLocked = opts.respectLocked !== false;
	const avoidCollisions = opts.avoidCollisions !== false;
	const clearanceMil = Math.max(0, Number(opts.clearanceMil ?? 20));
	const bodyPaddingMil = Math.max(0, Number(opts.bodyPaddingMil ?? 40));
	const scoreOptions: PlacementScoreOptions = {
		decouplingMaxMil,
		maxRatsnestSegments: opts.maxRatsnestSegments,
	};
	const scoreBefore = scorePlacement(snapshot, scoreOptions);
	const clusterResult = extractPlacementClusters(snapshot, {
		includeLoosePassives: opts.includeImmediatePassives !== false,
		maxClusters: opts.maxClusters,
		maxMembersPerCluster: opts.maxMembersPerCluster,
		decouplingMaxMil,
	});
	const cluster = selectPlacementCluster(clusterResult.clusters, opts);
	if (!cluster) {
		throw new Error('No IC/regulator placement cluster found. Pass reference/designator/primitiveId for an anchor component, or ensure U*/IC*/REG* designators exist.');
	}

	const byPrimitive = new Map(components.map((component) => [component.primitiveId, component]));
	const anchor = byPrimitive.get(cluster.anchor.primitiveId);
	if (!anchor) throw new Error(`Cluster anchor ${cluster.anchor.designator ?? cluster.anchor.primitiveId} is not present in the placement snapshot.`);

	const workingComponents = components.map((component) => clonePlacementComponent(component));
	const workingByPrimitive = new Map(workingComponents.map((component) => [component.primitiveId, component]));
	const candidateMembers = cluster.members
		.filter((member) => member.role !== 'anchor')
		.filter((member) => member.role !== 'decoupling_cap' || opts.includeDecouplingCaps !== false)
		.filter((member) => member.role !== 'immediate_passive' || opts.includeImmediatePassives !== false)
		.sort((a, b) => {
			const roleRank = (role: PlacementCluster['members'][number]['role']) => role === 'decoupling_cap' ? 0 : role === 'immediate_passive' ? 1 : 2;
			return roleRank(a.role) - roleRank(b.role) || (b.distanceMil ?? 0) - (a.distanceMil ?? 0);
		})
		.slice(0, maxMoves);
	const moves: PlacementClusterMove[] = [];
	const warnings: string[] = [];

	for (const member of candidateMembers) {
		const component = workingByPrimitive.get(member.primitiveId);
		if (!component) {
			moves.push(skippedClusterMove(member, 'Component is not present in the placement snapshot.', targetDistanceMil));
			continue;
		}
		if (respectLocked && component.primitiveLock) {
			moves.push(skippedClusterMove(member, 'Component is locked.', targetDistanceMil));
			continue;
		}

		const desiredDistance = member.role === 'decoupling_cap' ? targetDistanceMil : immediatePassiveDistanceMil;
		const targetPair = findClusterTargetPair(anchor, component, member.net);
		const candidate = buildClusterMoveCandidate({
			member,
			component,
			targetPair,
			desiredDistance,
			gridMil,
			workingComponents,
			avoidCollisions,
			clearanceMil,
			bodyPaddingMil,
		});
		moves.push(candidate);
		if (candidate.status === 'planned') {
			applyMoveToWorkingComponent(component, candidate.dx, candidate.dy);
		}
	}

	const acceptedMoves = moves.filter((move) => move.status === 'planned');
	const scoreAfterEstimate = scorePlacement(simulatePlacementSnapshot(snapshot, acceptedMoves), scoreOptions);
	const estimatedDelta = {
		hpwlMil: round(scoreAfterEstimate.totalHpwlMil - scoreBefore.totalHpwlMil, 1),
		crossingCount: scoreAfterEstimate.crossingCount - scoreBefore.crossingCount,
		decouplingViolations: scoreAfterEstimate.decoupling.violations - scoreBefore.decoupling.violations,
	};
	if (acceptedMoves.length > 0) {
		warnings.push('Connected routes and pours are not reshaped by component placement moves. Reroute affected nets, rebuild pours, and rerun DRC/connectivity after applying.');
	}
	if (avoidCollisions) {
		const rejected = moves.filter((move) => move.skipReason?.includes('collision')).length;
		if (rejected > 0) warnings.push(`${rejected} candidate move(s) were skipped because the approximate courtyard clearance check failed.`);
	}

	const skippedCount = moves.length - acceptedMoves.length;
	return {
		units: 'mil',
		anchor: cluster.anchor,
		cluster,
		options: {
			targetDistanceMil,
			immediatePassiveDistanceMil,
			gridMil,
			maxMoves,
			respectLocked,
			avoidCollisions,
			clearanceMil,
			bodyPaddingMil,
		},
		moveCount: acceptedMoves.length,
		skippedCount,
		moves,
		scoreBefore,
		scoreAfterEstimate,
		estimatedDelta,
		warnings,
		summary: `Cluster ${cluster.anchor.designator ?? cluster.anchor.primitiveId}: ${acceptedMoves.length} planned move(s), ${skippedCount} skipped. Estimated HPWL delta ${estimatedDelta.hpwlMil} mil, crossing delta ${estimatedDelta.crossingCount}, decoupling issue delta ${estimatedDelta.decouplingViolations}.`,
	};
}

export function optimizePlacement(snapshot: PlacementSnapshot, opts: PlacementOptimizationOptions = {}): PlacementOptimizationResult {
	const groupMode = opts.groupMode ?? 'mixed';
	const stepMil = positiveOrDefault(opts.stepMil, 100);
	const gridMil = positiveOrDefault(opts.gridMil, 25);
	const passes = Math.max(1, Math.floor(Number(opts.passes ?? 2)));
	const limit = Math.max(1, Math.floor(Number(opts.limit ?? 12)));
	const maxGroups = Math.max(1, Math.floor(Number(opts.maxGroups ?? 120)));
	const minImprovementMil = Math.max(0, Number(opts.minImprovementMil ?? 25));
	const respectLocked = opts.respectLocked !== false;
	const avoidCollisions = opts.avoidCollisions !== false;
	const avoidBoardEdge = opts.avoidBoardEdge !== false;
	const clearanceMil = Math.max(0, Number(opts.clearanceMil ?? 20));
	const boardMarginMil = Math.max(0, Number(opts.boardMarginMil ?? 0));
	const bodyPaddingMil = Math.max(0, Number(opts.bodyPaddingMil ?? 40));
	const crossingPenaltyMil = Math.max(0, Number(opts.crossingPenaltyMil ?? 250));
	const decouplingPenaltyMil = Math.max(0, Number(opts.decouplingPenaltyMil ?? 1000));
	const scoreOptions: PlacementScoreOptions = {
		decouplingMaxMil: opts.decouplingMaxMil ?? 150,
		maxRatsnestSegments: opts.maxRatsnestSegments,
	};
	const working = clonePlacementSnapshot(snapshot);
	const scoreBefore = scorePlacement(snapshot, scoreOptions);
	let currentScore = scorePlacement(working, scoreOptions);
	let currentObjective = placementObjective(currentScore, { crossingPenaltyMil, decouplingPenaltyMil });
	const objectiveBefore = placementObjective(scoreBefore, { crossingPenaltyMil, decouplingPenaltyMil });
	const { groups, skippedGroups } = buildOptimizationGroups(working, {
		...opts,
		groupMode,
		maxGroups,
		respectLocked,
	});
	const moves: PlacementOptimizationMove[] = [];

	for (let pass = 0; pass < passes && moves.length < limit; pass++) {
		const passStep = Math.max(gridMil, stepMil / (pass + 1));
		for (const group of groups) {
			if (moves.length >= limit) break;
			const candidate = bestOptimizationMove({
				snapshot: working,
				group,
				pass: pass + 1,
				passStep,
				gridMil,
				clearanceMil,
				boardMarginMil,
				bodyPaddingMil,
				avoidCollisions,
				avoidBoardEdge,
				scoreOptions,
				currentScore,
				currentObjective,
				crossingPenaltyMil,
				decouplingPenaltyMil,
			});
			if (!candidate || candidate.objectiveDelta >= -minImprovementMil) continue;
			applyOptimizationMove(working, candidate);
			moves.push(candidate);
			currentScore = scorePlacement(working, scoreOptions);
			currentObjective = placementObjective(currentScore, { crossingPenaltyMil, decouplingPenaltyMil });
		}
	}

	const scoreAfterEstimate = scorePlacement(working, scoreOptions);
	const objectiveAfterEstimate = placementObjective(scoreAfterEstimate, { crossingPenaltyMil, decouplingPenaltyMil });
	const estimatedDelta = {
		hpwlMil: round(scoreAfterEstimate.totalHpwlMil - scoreBefore.totalHpwlMil, 1),
		crossingCount: scoreAfterEstimate.crossingCount - scoreBefore.crossingCount,
		decouplingViolations: scoreAfterEstimate.decoupling.violations - scoreBefore.decoupling.violations,
		objective: round(objectiveAfterEstimate - objectiveBefore, 1),
	};
	const warnings: string[] = [];
	if (moves.length > 0) {
		warnings.push('Connected routes and pours are not reshaped by placement optimization. Reroute affected nets, rebuild pours, and rerun DRC/connectivity after applying.');
	}
	if (groupMode !== 'components') {
		warnings.push('Cluster moves preserve internal cluster spacing; run pcb_place_cluster on dense anchors before or after global optimization for tighter local decoupling placement.');
	}
	return {
		units: 'mil',
		groupMode,
		scannedGroupCount: groups.length,
		skippedGroupCount: skippedGroups.length,
		moveCount: moves.length,
		moves,
		skippedGroups,
		scoreBefore,
		scoreAfterEstimate,
		objectiveBefore: round(objectiveBefore, 1),
		objectiveAfterEstimate: round(objectiveAfterEstimate, 1),
		estimatedDelta,
		options: {
			stepMil,
			gridMil,
			passes,
			limit,
			minImprovementMil,
			respectLocked,
			avoidCollisions,
			avoidBoardEdge,
			clearanceMil,
			bodyPaddingMil,
			crossingPenaltyMil,
			decouplingPenaltyMil,
		},
		warnings,
		summary: `${moves.length} placement optimization move(s) planned over ${groups.length} group(s). Estimated HPWL delta ${estimatedDelta.hpwlMil} mil, crossing delta ${estimatedDelta.crossingCount}, decoupling issue delta ${estimatedDelta.decouplingViolations}, objective delta ${estimatedDelta.objective}.`,
	};
}

type IndexedPlacementPad = PlacementPad & { component: PlacementComponent };
type RatsnestSegment = { net: string; a: IndexedPlacementPad; b: IndexedPlacementPad };
type ClusterTargetPair = {
	anchorPoint: PlacementPad | { x: number; y: number };
	componentPoint: PlacementPad | { x: number; y: number };
	net?: string;
	sourcePad?: string;
	targetPad?: string;
	source: 'pin' | 'origin';
};
type PlacementOptimizationGroup = {
	id: string;
	groupType: 'component' | 'cluster';
	primitiveIds: string[];
	designators: string[];
	anchor?: PlacementCluster['anchor'];
	sortScore: number;
};

const MECHANICAL_REF_RE = /^(MH|H|FID|TP|LOGO|MOUNT|MTG)\d*$/i;

function selectPlacementCluster(clusters: PlacementCluster[], opts: PlacementClusterPlanOptions): PlacementCluster | undefined {
	const target = normalizeRef(opts.anchor ?? opts.primitiveId ?? opts.reference ?? opts.designator);
	if (target) {
		return clusters.find((cluster) =>
			normalizeRef(cluster.anchor.primitiveId) === target ||
			normalizeRef(cluster.anchor.designator) === target ||
			normalizeRef(cluster.id) === target
		);
	}
	return clusters.slice().sort((a, b) => b.hpwlMil - a.hpwlMil)[0];
}

function buildClusterMoveCandidate(args: {
	member: PlacementCluster['members'][number];
	component: PlacementComponent;
	targetPair: ClusterTargetPair;
	desiredDistance: number;
	gridMil: number;
	workingComponents: PlacementComponent[];
	avoidCollisions: boolean;
	clearanceMil: number;
	bodyPaddingMil: number;
}): PlacementClusterMove {
	const distanceBefore = dist(args.targetPair.anchorPoint, args.targetPair.componentPoint);
	if (!Number.isFinite(distanceBefore) || distanceBefore <= args.desiredDistance) {
		return skippedClusterMove(args.member, `Already within target distance (${round(distanceBefore, 1)} <= ${round(args.desiredDistance, 1)} mil).`, args.desiredDistance, distanceBefore);
	}
	const ref = args.member.designator ?? args.member.primitiveId;
	let lastCollision: PlacementClusterMove['collision'] | undefined;
	for (let attempt = 0; attempt <= 12; attempt++) {
		const desiredDistance = Math.min(distanceBefore, args.desiredDistance + attempt * args.gridMil);
		const moveLen = Math.max(0, distanceBefore - desiredDistance);
		if (moveLen <= 0) break;
		const ux = (args.targetPair.anchorPoint.x - args.targetPair.componentPoint.x) / distanceBefore;
		const uy = (args.targetPair.anchorPoint.y - args.targetPair.componentPoint.y) / distanceBefore;
		const rawTo = {
			x: args.component.x + ux * moveLen,
			y: args.component.y + uy * moveLen,
		};
		const to = {
			x: snapMil(rawTo.x, args.gridMil),
			y: snapMil(rawTo.y, args.gridMil),
		};
		const dx = to.x - args.component.x;
		const dy = to.y - args.component.y;
		if (Math.hypot(dx, dy) < 0.001) {
			return skippedClusterMove(args.member, 'Grid snapping collapsed the candidate move to zero.', args.desiredDistance, distanceBefore);
		}
		const estimatedDistanceAfter = dist(args.targetPair.anchorPoint, {
			x: args.targetPair.componentPoint.x + dx,
			y: args.targetPair.componentPoint.y + dy,
		});
		const collision = args.avoidCollisions
			? findMoveCollision(args.component, dx, dy, args.workingComponents, args.clearanceMil, args.bodyPaddingMil)
			: undefined;
		if (collision) {
			lastCollision = collision;
			continue;
		}
		return {
			primitiveId: args.member.primitiveId,
			designator: args.member.designator,
			role: args.member.role === 'immediate_passive' ? 'immediate_passive' : 'decoupling_cap',
			net: args.member.net ?? args.targetPair.net,
			layer: args.member.layer,
			from: { x: round(args.component.x, 3), y: round(args.component.y, 3) },
			to: { x: round(to.x, 3), y: round(to.y, 3) },
			dx: round(dx, 3),
			dy: round(dy, 3),
			distanceBeforeMil: round(distanceBefore, 1),
			estimatedDistanceAfterMil: round(estimatedDistanceAfter, 1),
			targetDistanceMil: round(args.desiredDistance, 1),
			sourcePad: args.targetPair.sourcePad,
			targetPad: args.targetPair.targetPad,
			status: 'planned',
			reason: args.targetPair.source === 'pin'
				? `Move ${ref} toward the anchor ${args.targetPair.net ?? 'shared-net'} pad while preserving approximate ${round(args.desiredDistance, 1)} mil spacing.`
				: `Move ${ref} toward the anchor origin while preserving approximate ${round(args.desiredDistance, 1)} mil spacing.`,
		};
	}
	return skippedClusterMove(
		args.member,
		lastCollision
			? `No snapped candidate satisfied approximate courtyard clearance; closest collision is with ${lastCollision.withDesignator ?? lastCollision.withPrimitiveId}.`
			: 'No useful candidate move found.',
		args.desiredDistance,
		distanceBefore,
		lastCollision,
	);
}

function findClusterTargetPair(anchor: PlacementComponent, component: PlacementComponent, net?: string): ClusterTargetPair {
	const pinPair = nearestSharedPadPair(anchor, component, net);
	if (pinPair) return pinPair;
	return {
		anchorPoint: { x: anchor.x, y: anchor.y },
		componentPoint: { x: component.x, y: component.y },
		source: 'origin',
	};
}

function nearestSharedPadPair(anchor: PlacementComponent, component: PlacementComponent, net?: string): ClusterTargetPair | undefined {
	let best: ClusterTargetPair | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const anchorPad of anchor.pads ?? []) {
		if (!anchorPad.net || (net && anchorPad.net !== net)) continue;
		const pair = nearestPadPair(anchor, anchorPad, component, anchorPad.net);
		if (!pair) continue;
		if (pair.distanceMil < bestDistance) {
			bestDistance = pair.distanceMil;
			best = {
				anchorPoint: anchorPad,
				componentPoint: pair.componentPad,
				net: anchorPad.net,
				sourcePad: pair.componentPad.padNumber,
				targetPad: anchorPad.padNumber,
				source: 'pin',
			};
		}
	}
	return best;
}

function skippedClusterMove(
	member: PlacementCluster['members'][number],
	reason: string,
	targetDistanceMil: number,
	distanceBeforeMil?: number,
	collision?: PlacementClusterMove['collision'],
): PlacementClusterMove {
	return {
		primitiveId: member.primitiveId,
		designator: member.designator,
		role: member.role === 'immediate_passive' ? 'immediate_passive' : 'decoupling_cap',
		net: member.net,
		layer: member.layer,
		from: { x: round(member.x, 3), y: round(member.y, 3) },
		to: { x: round(member.x, 3), y: round(member.y, 3) },
		dx: 0,
		dy: 0,
		distanceBeforeMil: distanceBeforeMil == null || !Number.isFinite(distanceBeforeMil) ? undefined : round(distanceBeforeMil, 1),
		targetDistanceMil: round(targetDistanceMil, 1),
		status: 'skipped',
		skipped: true,
		skipReason: reason,
		collision,
		reason,
	};
}

function findMoveCollision(
	component: PlacementComponent,
	dx: number,
	dy: number,
	components: PlacementComponent[],
	clearanceMil: number,
	bodyPaddingMil: number,
): PlacementClusterMove['collision'] | undefined {
	const moved = translatePlacementComponent(component, dx, dy);
	const movedBounds = deriveCourtyard(moved, bodyPaddingMil);
	for (const other of components) {
		if (other.primitiveId === component.primitiveId) continue;
		if (component.layer != null && other.layer != null && String(component.layer) !== String(other.layer)) continue;
		const otherBounds = deriveCourtyard(other, bodyPaddingMil);
		const gap = edgeGap(movedBounds, otherBounds);
		if (boundsOverlap(movedBounds, otherBounds) || gap < clearanceMil) {
			return {
				withPrimitiveId: other.primitiveId,
				withDesignator: other.designator,
				gapMil: round(gap, 1),
			};
		}
	}
	return undefined;
}

function simulatePlacementSnapshot(snapshot: PlacementSnapshot, moves: PlacementClusterMove[]): PlacementSnapshot {
	const byPrimitive = new Map(moves.filter((move) => move.status === 'planned').map((move) => [move.primitiveId, move]));
	return {
		...snapshot,
		components: (snapshot.components ?? []).map((component) => {
			const move = byPrimitive.get(component.primitiveId);
			if (!move) return clonePlacementComponent(component);
			return translatePlacementComponent(component, move.dx, move.dy);
		}),
	};
}

function translatePlacementComponent(component: PlacementComponent, dx: number, dy: number): PlacementComponent {
	return {
		...component,
		x: round(component.x + dx, 3),
		y: round(component.y + dy, 3),
		pads: (component.pads ?? []).map((pad) => ({
			...pad,
			x: round(pad.x + dx, 3),
			y: round(pad.y + dy, 3),
		})),
	};
}

function applyMoveToWorkingComponent(component: PlacementComponent, dx: number, dy: number): void {
	component.x = round(component.x + dx, 3);
	component.y = round(component.y + dy, 3);
	component.pads = (component.pads ?? []).map((pad) => ({
		...pad,
		x: round(pad.x + dx, 3),
		y: round(pad.y + dy, 3),
	}));
}

function clonePlacementComponent(component: PlacementComponent): PlacementComponent {
	return {
		...component,
		pads: (component.pads ?? []).map((pad) => ({ ...pad })),
	};
}

function snapMil(value: number, gridMil: number): number {
	if (!Number.isFinite(gridMil) || gridMil <= 0) return round(value, 3);
	return round(Math.round(value / gridMil) * gridMil, 3);
}

function positiveOrDefault(value: unknown, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeRef(value: unknown): string | undefined {
	const s = value == null ? '' : String(value).trim();
	return s ? s.toUpperCase() : undefined;
}

function clonePlacementSnapshot(snapshot: PlacementSnapshot): PlacementSnapshot {
	return {
		...snapshot,
		boardOutline: snapshot.boardOutline ? { ...snapshot.boardOutline, bounds: snapshot.boardOutline.bounds ? { ...snapshot.boardOutline.bounds } : undefined } : undefined,
		components: (snapshot.components ?? []).map((component) => clonePlacementComponent(component)),
	};
}

function placementObjective(
	score: PlacementScoreResult,
	opts: { crossingPenaltyMil: number; decouplingPenaltyMil: number },
): number {
	return score.totalHpwlMil
		+ score.crossingCount * opts.crossingPenaltyMil
		+ score.decoupling.violations * opts.decouplingPenaltyMil;
}

function buildOptimizationGroups(
	snapshot: PlacementSnapshot,
	opts: PlacementOptimizationOptions & { groupMode: 'components' | 'clusters' | 'mixed'; maxGroups: number; respectLocked: boolean },
): {
	groups: PlacementOptimizationGroup[];
	skippedGroups: PlacementOptimizationResult['skippedGroups'];
} {
	const components = Array.isArray(snapshot.components) ? snapshot.components : [];
	const byPrimitive = new Map(components.map((component) => [component.primitiveId, component]));
	const targetRefs = new Set((opts.references ?? []).map(normalizeRef).filter((value): value is string => !!value));
	const targetIds = new Set((opts.primitiveIds ?? []).map(normalizeRef).filter((value): value is string => !!value));
	const hasFilter = targetRefs.size > 0 || targetIds.size > 0;
	const groups: PlacementOptimizationGroup[] = [];
	const skippedGroups: PlacementOptimizationResult['skippedGroups'] = [];
	const groupedPrimitiveIds = new Set<string>();

	const considerGroup = (group: PlacementOptimizationGroup): void => {
		const groupComponents = group.primitiveIds.map((id) => byPrimitive.get(id)).filter((component): component is PlacementComponent => !!component);
		if (hasFilter && !groupComponents.some((component) => targetIds.has(normalizeRef(component.primitiveId) ?? '') || targetRefs.has(normalizeRef(component.designator) ?? ''))) {
			return;
		}
		const skipReason = skipOptimizationGroupReason(group, groupComponents, opts);
		if (skipReason) {
			skippedGroups.push({
				id: group.id,
				groupType: group.groupType,
				primitiveIds: group.primitiveIds,
				designators: group.designators,
				reason: skipReason,
			});
			return;
		}
		groups.push(group);
		for (const id of group.primitiveIds) groupedPrimitiveIds.add(id);
	};

	if (opts.groupMode !== 'components') {
		const clusterResult = extractPlacementClusters(snapshot, {
			includeLoosePassives: true,
			maxClusters: opts.maxClusters,
			maxMembersPerCluster: opts.maxMembersPerCluster,
			decouplingMaxMil: opts.decouplingMaxMil,
		});
		for (const cluster of clusterResult.clusters) {
			const primitiveIds = uniqueStrings(cluster.members.map((member) => member.primitiveId));
			considerGroup({
				id: `cluster:${cluster.id}`,
				groupType: 'cluster',
				primitiveIds,
				designators: cluster.members.map((member) => member.designator).filter((value): value is string => !!value),
				anchor: cluster.anchor,
				sortScore: cluster.hpwlMil,
			});
		}
	}

	if (opts.groupMode !== 'clusters') {
		for (const component of components) {
			if (opts.groupMode === 'mixed' && groupedPrimitiveIds.has(component.primitiveId)) continue;
			considerGroup({
				id: `component:${component.designator ?? component.primitiveId}`,
				groupType: 'component',
				primitiveIds: [component.primitiveId],
				designators: component.designator ? [component.designator] : [],
				sortScore: componentNetSpan(component),
			});
		}
	}

	groups.sort((a, b) => b.sortScore - a.sortScore);
	return { groups: groups.slice(0, opts.maxGroups), skippedGroups };
}

function skipOptimizationGroupReason(
	group: PlacementOptimizationGroup,
	components: PlacementComponent[],
	opts: PlacementOptimizationOptions & { respectLocked: boolean },
): string | undefined {
	if (components.length === 0) return 'No group components are present in the placement snapshot.';
	if (opts.respectLocked && components.some((component) => component.primitiveLock)) return 'Contains a locked component.';
	if (group.groupType === 'component') {
		const component = components[0];
		const ref = component.designator ?? '';
		if (opts.skipMechanical !== false && MECHANICAL_REF_RE.test(ref)) return 'Mechanical/fiducial/test-point component skipped.';
		if (opts.skipConnectors !== false && classifyConnector(component)) return 'Connector skipped by default.';
	}
	return undefined;
}

function bestOptimizationMove(args: {
	snapshot: PlacementSnapshot;
	group: PlacementOptimizationGroup;
	pass: number;
	passStep: number;
	gridMil: number;
	clearanceMil: number;
	boardMarginMil: number;
	bodyPaddingMil: number;
	avoidCollisions: boolean;
	avoidBoardEdge: boolean;
	scoreOptions: PlacementScoreOptions;
	currentScore: PlacementScoreResult;
	currentObjective: number;
	crossingPenaltyMil: number;
	decouplingPenaltyMil: number;
}): PlacementOptimizationMove | undefined {
	const components = componentsForGroup(args.snapshot, args.group);
	if (components.length === 0) return undefined;
	const center = groupCenter(components);
	let best: PlacementOptimizationMove | undefined;
	for (const offset of optimizationOffsets(args.passStep)) {
		const snappedCenter = {
			x: snapMil(center.x + offset.dx, args.gridMil),
			y: snapMil(center.y + offset.dy, args.gridMil),
		};
		const dx = round(snappedCenter.x - center.x, 3);
		const dy = round(snappedCenter.y - center.y, 3);
		if (Math.hypot(dx, dy) < 0.001) continue;
		if (args.avoidBoardEdge && groupWouldEscapeBoard(args.snapshot, args.group, dx, dy, args.bodyPaddingMil, args.boardMarginMil)) continue;
		if (args.avoidCollisions && findGroupCollision(args.snapshot, args.group, dx, dy, args.clearanceMil, args.bodyPaddingMil)) continue;
		const simulated = translateSnapshotGroup(args.snapshot, args.group.primitiveIds, dx, dy);
		const scoreAfter = scorePlacement(simulated, args.scoreOptions);
		const objectiveAfter = placementObjective(scoreAfter, {
			crossingPenaltyMil: args.crossingPenaltyMil,
			decouplingPenaltyMil: args.decouplingPenaltyMil,
		});
		const objectiveDelta = objectiveAfter - args.currentObjective;
		if (!best || objectiveDelta < best.objectiveDelta) {
			best = buildOptimizationMove({
				group: args.group,
				components,
				pass: args.pass,
				dx,
				dy,
				scoreBefore: args.currentScore,
				scoreAfter,
				objectiveBefore: args.currentObjective,
				objectiveAfter,
			});
		}
	}
	return best;
}

function buildOptimizationMove(args: {
	group: PlacementOptimizationGroup;
	components: PlacementComponent[];
	pass: number;
	dx: number;
	dy: number;
	scoreBefore: PlacementScoreResult;
	scoreAfter: PlacementScoreResult;
	objectiveBefore: number;
	objectiveAfter: number;
}): PlacementOptimizationMove {
	const center = groupCenter(args.components);
	const toCenter = { x: round(center.x + args.dx, 3), y: round(center.y + args.dy, 3) };
	return {
		id: args.group.id,
		groupType: args.group.groupType,
		pass: args.pass,
		primitiveIds: args.group.primitiveIds,
		designators: args.group.designators,
		anchor: args.group.anchor,
		fromCenter: { x: round(center.x, 3), y: round(center.y, 3) },
		toCenter,
		dx: round(args.dx, 3),
		dy: round(args.dy, 3),
		componentMoves: args.components.map((component) => ({
			primitiveId: component.primitiveId,
			designator: component.designator,
			from: { x: round(component.x, 3), y: round(component.y, 3) },
			to: { x: round(component.x + args.dx, 3), y: round(component.y + args.dy, 3) },
		})),
		objectiveBefore: round(args.objectiveBefore, 1),
		objectiveAfter: round(args.objectiveAfter, 1),
		objectiveDelta: round(args.objectiveAfter - args.objectiveBefore, 1),
		hpwlDeltaMil: round(args.scoreAfter.totalHpwlMil - args.scoreBefore.totalHpwlMil, 1),
		crossingDelta: args.scoreAfter.crossingCount - args.scoreBefore.crossingCount,
		decouplingViolationDelta: args.scoreAfter.decoupling.violations - args.scoreBefore.decoupling.violations,
		reason: `${args.group.groupType === 'cluster' ? 'Shift cluster' : 'Move component'} by (${round(args.dx, 1)}, ${round(args.dy, 1)}) mil to reduce weighted placement objective.`,
	};
}

function applyOptimizationMove(snapshot: PlacementSnapshot, move: PlacementOptimizationMove): void {
	const moveByPrimitive = new Map(move.componentMoves.map((componentMove) => [componentMove.primitiveId, componentMove]));
	snapshot.components = (snapshot.components ?? []).map((component) => {
		const componentMove = moveByPrimitive.get(component.primitiveId);
		return componentMove ? translatePlacementComponent(component, componentMove.to.x - component.x, componentMove.to.y - component.y) : component;
	});
}

function translateSnapshotGroup(snapshot: PlacementSnapshot, primitiveIds: string[], dx: number, dy: number): PlacementSnapshot {
	const ids = new Set(primitiveIds);
	return {
		...snapshot,
		components: (snapshot.components ?? []).map((component) => ids.has(component.primitiveId)
			? translatePlacementComponent(component, dx, dy)
			: clonePlacementComponent(component)),
	};
}

function componentsForGroup(snapshot: PlacementSnapshot, group: PlacementOptimizationGroup): PlacementComponent[] {
	const byPrimitive = new Map((snapshot.components ?? []).map((component) => [component.primitiveId, component]));
	return group.primitiveIds.map((id) => byPrimitive.get(id)).filter((component): component is PlacementComponent => !!component);
}

function groupCenter(components: PlacementComponent[]): { x: number; y: number } {
	if (components.length === 0) return { x: 0, y: 0 };
	const sum = components.reduce((acc, component) => ({ x: acc.x + component.x, y: acc.y + component.y }), { x: 0, y: 0 });
	return { x: sum.x / components.length, y: sum.y / components.length };
}

function optimizationOffsets(stepMil: number): Array<{ dx: number; dy: number }> {
	const step = positiveOrDefault(stepMil, 100);
	return [
		{ dx: step, dy: 0 },
		{ dx: -step, dy: 0 },
		{ dx: 0, dy: step },
		{ dx: 0, dy: -step },
		{ dx: step, dy: step },
		{ dx: step, dy: -step },
		{ dx: -step, dy: step },
		{ dx: -step, dy: -step },
	];
}

function findGroupCollision(
	snapshot: PlacementSnapshot,
	group: PlacementOptimizationGroup,
	dx: number,
	dy: number,
	clearanceMil: number,
	bodyPaddingMil: number,
): boolean {
	const ids = new Set(group.primitiveIds);
	const components = snapshot.components ?? [];
	const moving = components.filter((component) => ids.has(component.primitiveId));
	const fixed = components.filter((component) => !ids.has(component.primitiveId));
	for (const component of moving) {
		const moved = translatePlacementComponent(component, dx, dy);
		const movedBounds = deriveCourtyard(moved, bodyPaddingMil);
		for (const other of fixed) {
			if (component.layer != null && other.layer != null && String(component.layer) !== String(other.layer)) continue;
			const otherBounds = deriveCourtyard(other, bodyPaddingMil);
			const gap = edgeGap(movedBounds, otherBounds);
			if (boundsOverlap(movedBounds, otherBounds) || gap < clearanceMil) return true;
		}
	}
	return false;
}

function groupWouldEscapeBoard(
	snapshot: PlacementSnapshot,
	group: PlacementOptimizationGroup,
	dx: number,
	dy: number,
	bodyPaddingMil: number,
	boardMarginMil: number,
): boolean {
	const board = snapshot.boardOutline?.bounds;
	if (!board) return false;
	for (const component of componentsForGroup(snapshot, group)) {
		const movedBounds = deriveCourtyard(translatePlacementComponent(component, dx, dy), bodyPaddingMil);
		if (
			movedBounds.minX < board.minX + boardMarginMil ||
			movedBounds.maxX > board.maxX - boardMarginMil ||
			movedBounds.minY < board.minY + boardMarginMil ||
			movedBounds.maxY > board.maxY - boardMarginMil
		) return true;
	}
	return false;
}

function componentNetSpan(component: PlacementComponent): number {
	const b = boundsFromPoints(component.pads ?? []);
	return b ? b.width + b.height : 0;
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values));
}

function buildNetPadIndex(components: PlacementComponent[], includeSinglePadNets: boolean): Map<string, IndexedPlacementPad[]> {
	const byNet = new Map<string, IndexedPlacementPad[]>();
	for (const component of components) {
		for (const pad of component.pads ?? []) {
			if (!pad.net || !Number.isFinite(pad.x) || !Number.isFinite(pad.y)) continue;
			const list = byNet.get(pad.net) ?? [];
			list.push({ ...pad, component });
			byNet.set(pad.net, list);
		}
	}
	for (const [net, pads] of Array.from(byNet.entries())) {
		const componentCount = new Set(pads.map((pad) => pad.component.primitiveId)).size;
		if (!includeSinglePadNets && (pads.length < 2 || componentCount < 2)) byNet.delete(net);
	}
	return byNet;
}

function netPlacementMetric(net: string, pads: IndexedPlacementPad[]): NetPlacementMetric | undefined {
	if (pads.length < 2) return undefined;
	const bounds = boundsFromPoints(pads);
	if (!bounds) return undefined;
	return {
		net,
		padCount: pads.length,
		componentCount: new Set(pads.map((pad) => pad.component.primitiveId)).size,
		hpwlMil: round(bounds.width + bounds.height, 1),
		bounds,
	};
}

function buildRatsnestSegments(byNet: Map<string, IndexedPlacementPad[]>, limit: number): RatsnestSegment[] {
	const out: RatsnestSegment[] = [];
	const seen = new Set<string>();
	for (const [net, pads] of byNet.entries()) {
		for (const pad of pads) {
			let best: IndexedPlacementPad | undefined;
			let bestDistance = Number.POSITIVE_INFINITY;
			for (const candidate of pads) {
				if (candidate === pad || candidate.component.primitiveId === pad.component.primitiveId) continue;
				const d = dist(pad, candidate);
				if (d < bestDistance) {
					best = candidate;
					bestDistance = d;
				}
			}
			if (!best) continue;
			const ids = [pad.component.primitiveId, pad.padNumber ?? '', best.component.primitiveId, best.padNumber ?? ''].sort().join('|');
			const key = `${net}|${ids}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ net, a: pad, b: best });
			if (out.length >= limit) return out;
		}
	}
	return out;
}

function countSegmentCrossings(segments: RatsnestSegment[]): number {
	let count = 0;
	for (let i = 0; i < segments.length; i++) {
		for (let j = i + 1; j < segments.length; j++) {
			const a = segments[i];
			const b = segments[j];
			if (a.net === b.net) continue;
			if (sharesComponent(a, b)) continue;
			if (segmentsIntersect(a.a, a.b, b.a, b.b)) count += 1;
		}
	}
	return count;
}

function sharesComponent(a: RatsnestSegment, b: RatsnestSegment): boolean {
	const ids = new Set([a.a.component.primitiveId, a.b.component.primitiveId]);
	return ids.has(b.a.component.primitiveId) || ids.has(b.b.component.primitiveId);
}

function buildDecouplingRows(components: PlacementComponent[], thresholdMil: number): DecouplingDistanceRow[] {
	const caps = components.filter((component) => CAP_REF_RE.test(component.designator ?? ''));
	const rows: DecouplingDistanceRow[] = [];
	for (const ic of components.filter((component) => IC_REF_RE.test(component.designator ?? ''))) {
		for (const icPad of (ic.pads ?? []).filter((pad) => isPowerNet(pad.net))) {
			const net = icPad.net;
			if (!net) continue;
			const candidates = caps
				.map((cap) => nearestPadPair(ic, icPad, cap, net))
				.filter((row): row is NonNullable<ReturnType<typeof nearestPadPair>> => !!row)
				.sort((a, b) => a.distanceMil - b.distanceMil);
			const best = candidates[0];
			if (!best) {
				rows.push({
					ic: String(ic.designator ?? ic.primitiveId),
					net,
					icPad: icPad.padNumber,
					thresholdMil,
					withinThreshold: false,
					status: 'missing_cap',
				});
				continue;
			}
			const dx = icPad.x - best.componentPad.x;
			const dy = icPad.y - best.componentPad.y;
			const distanceMil = best.distanceMil;
			const moveLen = Math.max(0, distanceMil - thresholdMil);
			rows.push({
				ic: String(ic.designator ?? ic.primitiveId),
				cap: String(best.component.designator ?? best.component.primitiveId),
				net,
				icPad: icPad.padNumber,
				capPad: best.componentPad.padNumber,
				distanceMil: round(distanceMil, 1),
				thresholdMil,
				withinThreshold: distanceMil <= thresholdMil,
				status: distanceMil <= thresholdMil ? 'ok' : 'far',
				suggestedMove: distanceMil > thresholdMil ? {
					designator: best.component.designator,
					primitiveId: best.component.primitiveId,
					deltaX: round((dx / distanceMil) * moveLen, 2),
					deltaY: round((dy / distanceMil) * moveLen, 2),
				} : undefined,
			});
		}
	}
	return rows.sort((a, b) => {
		const sev = (row: DecouplingDistanceRow) => row.status === 'missing_cap' ? 2 : row.status === 'far' ? 1 : 0;
		return sev(b) - sev(a) || (b.distanceMil ?? 0) - (a.distanceMil ?? 0);
	});
}

function nearestPadPair(anchor: PlacementComponent, anchorPad: PlacementPad, component: PlacementComponent, net: string): { component: PlacementComponent; componentPad: PlacementPad; distanceMil: number } | undefined {
	if (component.primitiveId === anchor.primitiveId) return undefined;
	let bestPad: PlacementPad | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const pad of component.pads ?? []) {
		if (pad.net !== net) continue;
		const d = dist(anchorPad, pad);
		if (d < bestDistance) {
			bestDistance = d;
			bestPad = pad;
		}
	}
	return bestPad ? { component, componentPad: bestPad, distanceMil: bestDistance } : undefined;
}

function componentDistance(a: PlacementComponent, b: PlacementComponent): number {
	return dist({ x: a.x, y: a.y }, { x: b.x, y: b.y });
}

function clusterHpwl(pads: PlacementPad[]): number {
	const byNet = new Map<string, PlacementPad[]>();
	for (const pad of pads) {
		if (!pad.net) continue;
		const list = byNet.get(pad.net) ?? [];
		list.push(pad);
		byNet.set(pad.net, list);
	}
	let total = 0;
	for (const netPads of byNet.values()) {
		const b = boundsFromPoints(netPads);
		if (b) total += b.width + b.height;
	}
	return total;
}

function segmentsIntersect(a1: PlacementPad | { x: number; y: number }, a2: PlacementPad | { x: number; y: number }, b1: PlacementPad | { x: number; y: number }, b2: PlacementPad | { x: number; y: number }): boolean {
	const o1 = orient(a1, a2, b1);
	const o2 = orient(a1, a2, b2);
	const o3 = orient(b1, b2, a1);
	const o4 = orient(b1, b2, a2);
	return o1 * o2 < 0 && o3 * o4 < 0;
}

function orient(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
