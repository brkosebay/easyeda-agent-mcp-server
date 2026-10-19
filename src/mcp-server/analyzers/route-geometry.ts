// Pure-TS route geometry brain for the PCB "route cleanup" feature.
//
// NO external deps, NO EasyEDA SDK imports — this file must remain trivially
// unit-testable and reusable from BOTH the MCP-side report tool and the
// extension-side write handler. Every coordinate is in **mil** throughout.
//
// The job: take the raw line/arc primitives of a single net (or selection),
// chain them into ordered polylines, classify the geometric problems an
// agent would otherwise have to eyeball (acute angles, off-grid corners,
// right-angle jogs, micro-segments, collinear-redundant vertices, dangling
// stubs), and emit a *geometry-preserving* cleaned polyline plus the line/arc
// specs needed to recreate it.
//
// Geometry preservation rule: the FIRST and LAST point of each polyline are
// terminal (pad-/via-connected) and must never move. Interior vertices may be
// dropped, snapped, or split, but the endpoints are anchored.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single routed primitive: a straight line, or an arc when `arcAngle` is set. */
export interface Segment {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	width?: number;
	layer?: number | string;
	net?: string;
	id?: string;
	/** Sweep angle in degrees. SIGN is meaningful (CW vs CCW) and must be preserved. Absent ⇒ straight line. */
	arcAngle?: number;
	/** Optional arc center (derived if omitted). */
	center?: { x: number; y: number };
}

/** An ordered vertex chain. `arcAngles[i]` (if present) describes the curve from vertex i → i+1. */
export interface Polyline {
	points: Array<{ x: number; y: number }>;
	/** Per-segment sweep angle in degrees, index-aligned with the gap points[i]→points[i+1]. 0/undefined ⇒ straight. */
	arcAngles: Array<number | undefined>;
	width?: number;
	layer?: number | string;
	net?: string;
	/** Original primitive ids that composed this polyline (so callers can delete them). */
	sourceIds: string[];
	/** True when the chain has a free (non-shared) endpoint i.e. a stub/dangling tail. */
	dangling?: boolean;
}

export type RouteIssueType =
	| 'acute_angle'
	| 'non_45_corner'
	| 'right_angle_corner'
	| 'micro_segment'
	| 'collinear_redundant'
	| 'dangling_stub';

export interface RouteIssue {
	type: RouteIssueType;
	/** Vertex index in the polyline the issue is anchored at. */
	atVertexIndex: number;
	detail: string;
}

export interface CleanOptions {
	snap45?: boolean;
	miter90?: boolean;
	fillet?: boolean;
	minSegMil?: number;
	trimStubs?: boolean;
}

/** Recreation spec — a line when `arcAngle` is absent, an arc (with signed angle) otherwise. */
export interface LineSpec {
	net?: string;
	layer?: number | string;
	startX: number;
	startY: number;
	endX: number;
	endY: number;
	lineWidth?: number;
	arcAngle?: number;
	role: string;
}

const DEFAULT_CHAIN_TOL_MIL = 0.5;
const DEFAULT_MIN_SEG_MIL = 2;
const COLLINEAR_ANGLE_TOL_DEG = 1.0; // corners within 1° of straight are redundant
const ANGLE_GRID_TOL_DEG = 2.0; // how close to a 45° multiple a direction must be to count as "on grid"

// ---------------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------------

type Pt = { x: number; y: number };

function dist(a: Pt, b: Pt): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function near(a: Pt, b: Pt, tol: number): boolean {
	return dist(a, b) <= tol;
}

/** Interior angle at vertex `b` (the turn vertex) for polyline a→b→c, in degrees [0,180]. */
function interiorAngleDeg(a: Pt, b: Pt, c: Pt): number {
	const v1x = a.x - b.x;
	const v1y = a.y - b.y;
	const v2x = c.x - b.x;
	const v2y = c.y - b.y;
	const m1 = Math.hypot(v1x, v1y);
	const m2 = Math.hypot(v2x, v2y);
	if (m1 < 1e-9 || m2 < 1e-9) return 180;
	let cos = (v1x * v2x + v1y * v2y) / (m1 * m2);
	cos = Math.max(-1, Math.min(1, cos));
	return (Math.acos(cos) * 180) / Math.PI;
}

/** Direction of segment a→b in degrees [0,360). */
function dirDeg(a: Pt, b: Pt): number {
	const d = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
	return (d + 360) % 360;
}

/** Smallest distance from a 45° multiple, in degrees. */
function offGrid45(angle: number): number {
	const m = ((angle % 45) + 45) % 45;
	return Math.min(m, 45 - m);
}

function snapDirTo45(angle: number): number {
	return (Math.round(angle / 45) * 45 + 360) % 360;
}

// ---------------------------------------------------------------------------
// chainSegments — join line/arc primitives sharing endpoints into polylines
// ---------------------------------------------------------------------------

/**
 * Join line/arc primitives that share endpoints (within `tol`, default 0.5 mil)
 * into ordered polylines. Segments are grouped by (net, layer, rounded width)
 * first, then walked endpoint-to-endpoint. Chains with a free endpoint are
 * flagged `dangling`. Branch points (3+ segments meeting) terminate a chain so
 * we never silently merge a T into a single line.
 *
 * Worked example (a 90° corner made of two perpendicular lines):
 *   A = {x1:0,y1:0,  x2:100,y2:0}      // east
 *   B = {x1:100,y1:0,x2:100,y2:100}    // north, shares (100,0) with A
 *   chainSegments([A,B]) ⇒ one Polyline points=[(0,0),(100,0),(100,100)]
 *   (the shared (100,0) becomes the single interior vertex).
 */
export function chainSegments(segments: Segment[], tol: number = DEFAULT_CHAIN_TOL_MIL): Polyline[] {
	const valid = segments.filter(
		(s) =>
			Number.isFinite(s.x1) &&
			Number.isFinite(s.y1) &&
			Number.isFinite(s.x2) &&
			Number.isFinite(s.y2) &&
			!(near({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }, 1e-9) && !s.arcAngle),
	);

	// Group by routing identity so we never chain across nets/layers/widths.
	const groups = new Map<string, Segment[]>();
	for (const s of valid) {
		const wKey = s.width != null ? Math.round(s.width * 100) / 100 : 'na';
		const key = `${s.net ?? ''}|${s.layer ?? ''}|${wKey}`;
		const g = groups.get(key);
		if (g) g.push(s);
		else groups.set(key, [s]);
	}

	const polylines: Polyline[] = [];
	for (const group of groups.values()) {
		polylines.push(...chainGroup(group, tol));
	}
	return polylines;
}

function chainGroup(segments: Segment[], tol: number): Polyline[] {
	const remaining = new Set(segments.map((_, i) => i));

	// Endpoint adjacency: how many segments touch each endpoint (to detect branches).
	const endpointKey = (p: Pt): string => `${Math.round(p.x / tol)},${Math.round(p.y / tol)}`;
	const touchCount = new Map<string, number>();
	for (const s of segments) {
		for (const p of [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }]) {
			const k = endpointKey(p);
			touchCount.set(k, (touchCount.get(k) ?? 0) + 1);
		}
	}
	const isBranch = (p: Pt): boolean => (touchCount.get(endpointKey(p)) ?? 0) > 2;

	const out: Polyline[] = [];

	while (remaining.size > 0) {
		const seedIdx = remaining.values().next().value as number;
		remaining.delete(seedIdx);
		const seed = segments[seedIdx];

		const pts: Pt[] = [{ x: seed.x1, y: seed.y1 }, { x: seed.x2, y: seed.y2 }];
		const arcAngles: Array<number | undefined> = [seed.arcAngle && Math.abs(seed.arcAngle) > 1e-9 ? seed.arcAngle : undefined];
		const sourceIds: string[] = [];
		if (seed.id) sourceIds.push(seed.id);

		// Extend forward from the tail, then backward from the head.
		let extended = true;
		while (extended) {
			extended = false;
			const tail = pts[pts.length - 1];
			if (!isBranch(tail)) {
				for (const idx of remaining) {
					const s = segments[idx];
					const a = { x: s.x1, y: s.y1 };
					const b = { x: s.x2, y: s.y2 };
					if (near(tail, a, tol)) {
						pts.push(b);
						arcAngles.push(s.arcAngle && Math.abs(s.arcAngle) > 1e-9 ? s.arcAngle : undefined);
						if (s.id) sourceIds.push(s.id);
						remaining.delete(idx);
						extended = true;
						break;
					}
					if (near(tail, b, tol)) {
						pts.push(a);
						// Reversed direction ⇒ arc sweep flips sign.
						arcAngles.push(s.arcAngle && Math.abs(s.arcAngle) > 1e-9 ? -s.arcAngle : undefined);
						if (s.id) sourceIds.push(s.id);
						remaining.delete(idx);
						extended = true;
						break;
					}
				}
			}
			if (extended) continue;

			const head = pts[0];
			if (!isBranch(head)) {
				for (const idx of remaining) {
					const s = segments[idx];
					const a = { x: s.x1, y: s.y1 };
					const b = { x: s.x2, y: s.y2 };
					if (near(head, b, tol)) {
						pts.unshift(a);
						arcAngles.unshift(s.arcAngle && Math.abs(s.arcAngle) > 1e-9 ? s.arcAngle : undefined);
						if (s.id) sourceIds.unshift(s.id);
						remaining.delete(idx);
						extended = true;
						break;
					}
					if (near(head, a, tol)) {
						pts.unshift(b);
						arcAngles.unshift(s.arcAngle && Math.abs(s.arcAngle) > 1e-9 ? -s.arcAngle : undefined);
						if (s.id) sourceIds.unshift(s.id);
						remaining.delete(idx);
						extended = true;
						break;
					}
				}
			}
		}

		const headFree = (touchCount.get(endpointKey(pts[0])) ?? 0) <= 1;
		const tailFree = (touchCount.get(endpointKey(pts[pts.length - 1])) ?? 0) <= 1;
		out.push({
			points: pts,
			arcAngles,
			width: seed.width,
			layer: seed.layer,
			net: seed.net,
			sourceIds,
			dangling: headFree || tailFree,
		});
	}

	return out;
}

// ---------------------------------------------------------------------------
// detectIssues — classify geometric problems on a polyline
// ---------------------------------------------------------------------------

/**
 * Classify the per-vertex geometric issues. Straight (line) corners are
 * evaluated; arc segments are skipped for corner classification (their
 * curvature is intentional). A single short polyline that is `dangling` AND
 * shorter than the micro threshold is reported as a `dangling_stub`.
 */
export function detectIssues(poly: Polyline, opts: { minSegMil?: number } = {}): RouteIssue[] {
	const issues: RouteIssue[] = [];
	const minSeg = opts.minSegMil != null && opts.minSegMil > 0 ? opts.minSegMil : DEFAULT_MIN_SEG_MIL;
	const pts = poly.points;
	if (pts.length < 2) return issues;

	// Micro-segments: any sub-threshold gap.
	for (let i = 0; i < pts.length - 1; i++) {
		const d = dist(pts[i], pts[i + 1]);
		if (d > 1e-9 && d < minSeg) {
			issues.push({
				type: 'micro_segment',
				atVertexIndex: i,
				detail: `segment ${i}->${i + 1} is ${d.toFixed(3)} mil (< ${minSeg} mil min)`,
			});
		}
	}

	// Interior-vertex corner classification (straight segments only).
	for (let i = 1; i < pts.length - 1; i++) {
		const arcIn = poly.arcAngles[i - 1];
		const arcOut = poly.arcAngles[i];
		if ((arcIn && Math.abs(arcIn) > 1e-9) || (arcOut && Math.abs(arcOut) > 1e-9)) continue;

		const a = pts[i - 1];
		const b = pts[i];
		const c = pts[i + 1];
		const ang = interiorAngleDeg(a, b, c);

		// Collinear-redundant: interior angle ~180°, vertex adds nothing.
		if (Math.abs(180 - ang) <= COLLINEAR_ANGLE_TOL_DEG) {
			issues.push({
				type: 'collinear_redundant',
				atVertexIndex: i,
				detail: `vertex ${i} interior angle ${ang.toFixed(1)}° — collinear, removable`,
			});
			continue;
		}

		if (ang < 90 - 1e-6) {
			issues.push({
				type: 'acute_angle',
				atVertexIndex: i,
				detail: `vertex ${i} interior angle ${ang.toFixed(1)}° (<90°) — acute, hard to fab/etch`,
			});
			continue;
		}

		// Right angle: interior angle ~90°, a candidate for mitering.
		if (Math.abs(90 - ang) <= 1.0) {
			issues.push({
				type: 'right_angle_corner',
				atVertexIndex: i,
				detail: `vertex ${i} interior angle ${ang.toFixed(1)}° — right-angle jog, miter to 45°`,
			});
			continue;
		}

		// Non-45/non-90 corner: turn direction isn't on the 45° grid.
		const turn = Math.abs(180 - ang); // deviation from straight
		if (offGrid45(turn) > ANGLE_GRID_TOL_DEG) {
			issues.push({
				type: 'non_45_corner',
				atVertexIndex: i,
				detail: `vertex ${i} interior angle ${ang.toFixed(1)}° — off the 45° grid`,
			});
		}
	}

	// Dangling stub: short free-ended chain.
	if (poly.dangling) {
		const total = polylineLength(poly);
		if (total < Math.max(minSeg * 4, 20)) {
			issues.push({
				type: 'dangling_stub',
				atVertexIndex: 0,
				detail: `dangling chain, total length ${total.toFixed(2)} mil — likely a leftover stub`,
			});
		}
	}

	return issues;
}

// ---------------------------------------------------------------------------
// cleanPolyline — produce a geometry-preserving cleaned chain
// ---------------------------------------------------------------------------

/**
 * Clean a polyline. Endpoints (index 0 and last) are anchored and never moved.
 *
 * Steps:
 *   1. Drop collinear and micro interior vertices.
 *   2. (snap45) rotate interior vertices so each leg lands on a 45° direction,
 *      keeping the first leg's start and last leg's end fixed.
 *   3. (miter90/fillet) replace ~90° corners with either two 45° segments
 *      (miter) sized by the shorter adjacent leg, or a quarter arc (fillet).
 *   4. (trimStubs) if the whole chain is a dangling micro-stub, collapse it.
 *
 * Worked 90°-corner example:
 *   points=[(0,0),(100,0),(100,100)], a clean right angle at (100,0).
 *   cleanPolyline(p, {miter90:true}) with legs of 100 mil each chooses a
 *   miter leg of min(100,100)/2 = 50 mil, replacing vertex (100,0) with
 *   (50,0) and (100,50): points become
 *   [(0,0),(50,0),(100,50),(100,100)] — the 90° jog is now two 45° bends.
 *   Endpoints (0,0) and (100,100) are unchanged ⇒ net length preserved at pads.
 */
export function cleanPolyline(poly: Polyline, opts: CleanOptions = {}): Polyline {
	const minSeg = opts.minSegMil != null && opts.minSegMil > 0 ? opts.minSegMil : DEFAULT_MIN_SEG_MIL;

	// trimStubs: a free-ended micro chain → collapse to its anchored endpoint.
	if (opts.trimStubs && poly.dangling && polylineLength(poly) < Math.max(minSeg * 4, 20)) {
		return { ...poly, points: [poly.points[0]], arcAngles: [] };
	}

	// Work on a mutable copy preserving arc associations.
	let pts = poly.points.map((p) => ({ x: p.x, y: p.y }));
	let arcs = poly.arcAngles.slice();
	if (pts.length < 3) return { ...poly, points: pts, arcAngles: arcs };

	// 1. Drop collinear + micro interior vertices (endpoints protected).
	({ pts, arcs } = dropRedundantVertices(pts, arcs, minSeg));

	// 2. snap45 — rotate interior legs onto the 45° grid (endpoints fixed).
	if (opts.snap45) {
		({ pts, arcs } = snapPolyTo45(pts, arcs));
	}

	// 3. miter90 / fillet — replace right-angle straight corners.
	if (opts.miter90 || opts.fillet) {
		({ pts, arcs } = miterRightAngles(pts, arcs, !!opts.fillet));
	}

	return { ...poly, points: pts, arcAngles: arcs };
}

function dropRedundantVertices(
	pts: Pt[],
	arcs: Array<number | undefined>,
	minSeg: number,
): { pts: Pt[]; arcs: Array<number | undefined> } {
	const outPts: Pt[] = [pts[0]];
	const outArcs: Array<number | undefined> = [];
	for (let i = 1; i < pts.length - 1; i++) {
		const prev = outPts[outPts.length - 1];
		const cur = pts[i];
		const next = pts[i + 1];
		const arcIn = arcs[i - 1];
		const arcOut = arcs[i];
		const isArc = (arcIn && Math.abs(arcIn) > 1e-9) || (arcOut && Math.abs(arcOut) > 1e-9);

		// Never drop a vertex adjacent to an arc (would lose curvature).
		if (!isArc) {
			const ang = interiorAngleDeg(prev, cur, next);
			const collinear = Math.abs(180 - ang) <= COLLINEAR_ANGLE_TOL_DEG;
			const micro = dist(prev, cur) < minSeg;
			if (collinear || micro) {
				// Skip `cur`: merge the in-arc forward (both straight here ⇒ undefined).
				continue;
			}
		}
		outPts.push(cur);
		outArcs.push(arcIn);
	}
	outPts.push(pts[pts.length - 1]);
	outArcs.push(arcs[arcs.length - 1]);
	return { pts: outPts, arcs: outArcs };
}

function snapPolyTo45(
	pts: Pt[],
	arcs: Array<number | undefined>,
): { pts: Pt[]; arcs: Array<number | undefined> } {
	if (pts.length < 2) return { pts, arcs };
	const out = pts.map((p) => ({ x: p.x, y: p.y }));
	// Anchor the first point; reproject each subsequent straight leg onto the
	// nearest 45° direction while preserving its length. Endpoints of arcs and
	// the final terminal point are left untouched (we rebuild forward then pin
	// the last point back to its original location to stay pad-accurate).
	const finalPoint = { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
	for (let i = 0; i < out.length - 1; i++) {
		const arc = arcs[i];
		if (arc && Math.abs(arc) > 1e-9) continue; // don't snap arc legs
		const a = out[i];
		const b = pts[i + 1];
		const len = dist(a, b);
		if (len < 1e-9) continue;
		const snapped = (snapDirTo45(dirDeg(a, b)) * Math.PI) / 180;
		out[i + 1] = { x: a.x + Math.cos(snapped) * len, y: a.y + Math.sin(snapped) * len };
	}
	// Re-pin terminal endpoint so the net stays connected to its pad/via.
	out[out.length - 1] = finalPoint;
	return { pts: out, arcs };
}

function miterRightAngles(
	pts: Pt[],
	arcs: Array<number | undefined>,
	fillet: boolean,
): { pts: Pt[]; arcs: Array<number | undefined> } {
	const outPts: Pt[] = [pts[0]];
	const outArcs: Array<number | undefined> = [];
	for (let i = 1; i < pts.length - 1; i++) {
		const a = pts[i - 1];
		const b = pts[i];
		const c = pts[i + 1];
		const arcIn = arcs[i - 1];
		const arcOut = arcs[i];
		const isArc = (arcIn && Math.abs(arcIn) > 1e-9) || (arcOut && Math.abs(arcOut) > 1e-9);
		const ang = interiorAngleDeg(a, b, c);

		if (isArc || Math.abs(90 - ang) > 1.0) {
			outPts.push(b);
			outArcs.push(arcIn);
			continue;
		}

		// Right angle: size the miter leg by the shorter adjacent half-leg.
		const legIn = dist(a, b);
		const legOut = dist(b, c);
		const leg = Math.min(legIn, legOut) / 2;
		if (leg < 1e-6) {
			outPts.push(b);
			outArcs.push(arcIn);
			continue;
		}
		const uIn = { x: (a.x - b.x) / legIn, y: (a.y - b.y) / legIn }; // b→a unit
		const uOut = { x: (c.x - b.x) / legOut, y: (c.y - b.y) / legOut }; // b→c unit
		const p1 = { x: b.x + uIn.x * leg, y: b.y + uIn.y * leg };
		const p2 = { x: b.x + uOut.x * leg, y: b.y + uOut.y * leg };

		// Invariant: each point push (after the first seed point) is matched by
		// exactly one arc push describing the leg INTO that point.
		if (fillet) {
			// Quarter-arc fillet between p1 and p2. Sign: cross product of the
			// incoming (b→a) and outgoing (b→c) directions gives turn
			// handedness; a 90° corner becomes a signed 90° sweep.
			const cross = uIn.x * uOut.y - uIn.y * uOut.x;
			const sweep = cross >= 0 ? 90 : -90;
			outPts.push(p1);
			outArcs.push(undefined); // straight lead-in (prev→p1)
			outPts.push(p2);
			outArcs.push(sweep); // arc p1→p2 (the rounded corner)
			// The straight p2→c leg is emitted when the next iteration (or the
			// terminal push) appends c with an `undefined` arc.
		} else {
			// Two 45° straight segments.
			outPts.push(p1);
			outArcs.push(undefined); // straight lead-in (prev→p1)
			outPts.push(p2);
			outArcs.push(undefined); // the 45° diagonal p1→p2
		}
	}
	outPts.push(pts[pts.length - 1]);
	outArcs.push(arcs[arcs.length - 1]);
	return { pts: outPts, arcs: outArcs };
}

// ---------------------------------------------------------------------------
// polylineToLineSpecs — emit recreation specs
// ---------------------------------------------------------------------------

export function polylineToLineSpecs(poly: Polyline, role = 'route_cleanup'): LineSpec[] {
	const specs: LineSpec[] = [];
	const pts = poly.points;
	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i];
		const b = pts[i + 1];
		if (near(a, b, 1e-9)) continue;
		const arc = poly.arcAngles[i];
		specs.push({
			net: poly.net,
			layer: poly.layer,
			startX: a.x,
			startY: a.y,
			endX: b.x,
			endY: b.y,
			lineWidth: poly.width,
			arcAngle: arc && Math.abs(arc) > 1e-9 ? arc : undefined, // SIGN preserved
			role,
		});
	}
	return specs;
}

// ---------------------------------------------------------------------------
// length helpers
// ---------------------------------------------------------------------------

/** Length of one segment, accounting for arc sweep when present. */
function segLength(a: Pt, b: Pt, arcAngleDeg?: number): number {
	const chord = dist(a, b);
	if (!arcAngleDeg || Math.abs(arcAngleDeg) <= 1e-9) return chord;
	const theta = (Math.abs(arcAngleDeg) * Math.PI) / 180;
	if (theta < 1e-9 || theta >= 2 * Math.PI) return chord;
	// chord = 2 R sin(theta/2) ⇒ R = chord / (2 sin(theta/2)); arc = R*theta.
	const r = chord / (2 * Math.sin(theta / 2));
	return r * theta;
}

export function polylineLength(poly: Polyline): number {
	let total = 0;
	for (let i = 0; i < poly.points.length - 1; i++) {
		total += segLength(poly.points[i], poly.points[i + 1], poly.arcAngles[i]);
	}
	return total;
}

// ---------------------------------------------------------------------------
// analyzeRouteGeometry — the read-only brain used by report + handler
// ---------------------------------------------------------------------------

export interface AnalyzeResult {
	issues: Array<RouteIssue & { polylineIndex: number; sourceIds: string[] }>;
	cleanedSpecs: LineSpec[];
	lengthBeforeMil: number;
	lengthAfterMil: number;
	polylineCount: number;
	removedSourceIds: string[];
}

export function analyzeRouteGeometry(segments: Segment[], opts: CleanOptions = {}): AnalyzeResult {
	const polylines = chainSegments(segments);
	const issues: AnalyzeResult['issues'] = [];
	const cleanedSpecs: LineSpec[] = [];
	const removedSourceIds: string[] = [];
	let lengthBeforeMil = 0;
	let lengthAfterMil = 0;

	polylines.forEach((poly, pi) => {
		lengthBeforeMil += polylineLength(poly);
		for (const issue of detectIssues(poly, opts)) {
			issues.push({ ...issue, polylineIndex: pi, sourceIds: poly.sourceIds });
		}
		const cleaned = cleanPolyline(poly, opts);
		lengthAfterMil += polylineLength(cleaned);
		const specs = polylineToLineSpecs(cleaned);
		// Only count this polyline as "to be recreated" if it actually changed
		// or produced specs; trimmed stubs produce zero specs.
		cleanedSpecs.push(...specs);
		removedSourceIds.push(...poly.sourceIds);
	});

	return {
		issues,
		cleanedSpecs,
		lengthBeforeMil: round2(lengthBeforeMil),
		lengthAfterMil: round2(lengthAfterMil),
		polylineCount: polylines.length,
		removedSourceIds,
	};
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
