// Differential-pair routing (pcb_route_pair) and verified length tuning
// (pcb_length_tune), built on the route executor (route-path.ts).
//
// The model plans; this module does the geometry the model should not have to
// do by hand, then proves the result:
//
//   pcb.route.pair — the model gives the pair's CENTERLINE (octilinear, layer
//     changes marked on points). Each net is that centerline offset by
//     ±pitch/2 with miter joins, so every coupled leg is exactly `gap` from its
//     partner through 45° and 90° corners (inner/outer lengths differ by
//     2·pitch·tan(θ/2) per corner — reported as skew). A 45° fan-in joins each
//     pad (and each via) to its offset line; a layer change spreads the pair to
//     via pitch and back. P–N spacing of the WHOLE plan (fan-ins, vias) is
//     measured here — route-path only checks against existing copper — then
//     both nets go through routePath({routes:[P,N]}): one obstacle preflight,
//     one transaction, one connectivity verification, one rollback.
//
//   pcb.route.lengthTune — replaces one straight leg (or a coupled pair of
//     legs) with an accordion meander sized to add exactly the requested
//     length. "Length" is the SHORTEST COPPER PATH between the net's endpoints
//     with contacts found by copper overlap, so a stub, a redundant branch or
//     meander runs that touch add no length — and are refused before commit.
//     Candidates (amplitude × side) are preflighted in one routePath dry-run;
//     the commit is create-meander + delete-leg in one commitBatchOperations
//     transaction (routePath cannot delete, and its point-terminal
//     verification is vacuous); afterwards the measured path length must have
//     grown by the planned amount or the meander is removed and the leg
//     recreated.

import { flattenStateArray, normalizeLayer } from './_utils';
import { commitBatchOperations, getSnapshot, invalidateSnapshot } from './board-context';
import { routePath } from './route-path';
import { clearanceResolverFromRules, fetchDrcRules, layersTouch, padToObstacle, pointToSegmentDistance, polygonHit, segmentDistance, viaSizeForNet } from './trace-obstacles';
import { diffPairRule, normalizeDiffPairs } from '../../shared/drc-rules';
import type { DiffPairDef } from '../../shared/drc-rules';

const MIL_PER_MM = 39.37007874015748;
const MULTI_LAYER = 12;
const MIN_LEG = 0.01; // mil: shorter legs are merged away
const ANGLE_TOL_DEG = 0.5;
const CONTACT_EPS = 0.01; // mil: touching copper, as in net-connectivity
const T225 = Math.tan(Math.PI / 8);
// Length one bump loses to its four 45° chamfers of size m: 4·m·(2 − √2).
const MITER_LOSS = 8 - 4 * Math.SQRT2;
// Keep routePath from merging a fan-in junction into its pad (user units).
const ROUTE_SNAP = 1e-4;
const DEFAULT_VIA = { diameter: 24, holeDiameter: 12 };

type Units = 'mil' | 'mm';
export interface Pt { x: number; y: number }
/** A polyline vertex; `layer` = via here, continue on that layer. */
export interface LPt extends Pt { layer?: number }
interface Issue { severity: 'error' | 'warning'; code: string; message: string }

const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x;
const norm = (a: Pt): number => Math.hypot(a.x, a.y);
const unit = (a: Pt): Pt => { const l = norm(a) || 1; return { x: a.x / l, y: a.y / l }; };
const leftOf = (u: Pt): Pt => ({ x: -u.y, y: u.x });
const dist = (a: Pt, b: Pt): number => norm(sub(a, b));

function round(v: number, places = 4): number {
	const f = 10 ** places;
	return Math.round(v * f) / f;
}

function layerOf(value: unknown): number | undefined {
	try {
		const n = Number(normalizeLayer(value as any));
		return Number.isFinite(n) && n > 0 ? n : undefined;
	} catch { return undefined; }
}

function angleOffDeg(a: Pt, b: Pt): number {
	const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
	return Math.abs(deg - Math.round(deg / 45) * 45);
}

export function polylineLength(pts: Pt[]): number {
	let total = 0;
	for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
	return total;
}

/** Drop duplicate vertices (keeping a layer mark) and collinear interior vertices that carry none. */
export function cleanPolyline(pts: LPt[]): LPt[] {
	const out: LPt[] = [];
	pts.forEach((p, i) => {
		const last = out[out.length - 1];
		if (last && dist(last, p) < MIN_LEG) {
			if (p.layer != null) last.layer = p.layer;
			if (i === pts.length - 1) { last.x = p.x; last.y = p.y; }
			return;
		}
		out.push({ ...p });
	});
	for (let i = out.length - 2; i >= 1; i--) {
		if (out[i].layer != null) continue;
		const a = sub(out[i], out[i - 1]), b = sub(out[i + 1], out[i]);
		if (Math.abs(cross(unit(a), unit(b))) < 1e-9 && dot(a, b) > 0) out.splice(i, 1);
	}
	return out;
}

/**
 * Offset a polyline by `o` (positive = left of travel) with miter joins: every
 * offset leg is parallel to its centerline leg at exactly |o|. `degenerate`
 * names the first leg whose offset collapses or reverses (inner side of a
 * corner on a leg too short for the offset).
 */
export function offsetPolyline(pts: Pt[], o: number): { points: Pt[]; degenerate?: number } {
	const dirs = pts.slice(1).map((p, i) => unit(sub(p, pts[i])));
	const out = pts.map((p, i) => {
		const n1 = leftOf(dirs[Math.max(0, i - 1)]);
		const n2 = leftOf(dirs[Math.min(dirs.length - 1, i)]);
		if (i === 0) return add(p, mul(n2, o));
		if (i === pts.length - 1) return add(p, mul(n1, o));
		return miterPoint(p, n1, n2, o);
	});
	for (let i = 0; i < dirs.length; i++) {
		if (dot(sub(out[i + 1], out[i]), dirs[i]) <= MIN_LEG) return { points: out, degenerate: i };
	}
	return { points: out };
}

function miterPoint(c: Pt, n1: Pt, n2: Pt, o: number): Pt {
	return add(c, mul(add(n1, n2), o / (1 + dot(n1, n2))));
}

/**
 * Join terminal `p` to the path `q` (q[0] = where the offset line starts) with
 * one 45° leg that meets the line moving forward; the junction must land
 * before q's first corner. Returns the path from p onward (q[0] dropped).
 */
export function fanIn(p: Pt, q: Pt[]): { points: Pt[] } | { shortBy: number; along: number; across: number } {
	const u = unit(sub(q[1], q[0])), n = leftOf(u);
	const rel = sub(p, q[0]);
	const a = dot(rel, u), e = dot(rel, n);
	const along = a + Math.abs(e);
	const first = dist(q[1], q[0]);
	if (along > first - MIN_LEG) return { shortBy: along - first + MIN_LEG, along: a, across: e };
	const head: Pt[] = [p];
	if (Math.abs(e) > MIN_LEG) head.push(add(p, sub(mul(u, Math.abs(e)), mul(n, e))));
	return { points: [...head, ...q.slice(1)] };
}

// ---------------------------------------------------------------------------
// Pair geometry (pure, mil)
// ---------------------------------------------------------------------------

export interface PairGeometryInput {
	centerline: LPt[];
	startLayer: number;
	/** centre-to-centre of the coupled tracks (width + gap) */
	pitch: number;
	/** centre-to-centre of the paired vias */
	viaPitch: number;
	/** +1: P runs on the left of the travel direction */
	pSide: 1 | -1;
	pFrom: Pt; pTo: Pt; nFrom: Pt; nTo: Pt;
}

export interface PairGeometry {
	p: LPt[];
	n: LPt[];
	vias: Array<{ at: Pt; p: Pt; n: Pt; toLayer: number }>;
	/** Σ over coupled corners of (P − N) length: −2·(oP − oN)·tan(θ/2), θ signed (left +). */
	cornerSkew: number;
	issues: Issue[];
}

export function planPairGeometry(g: PairGeometryInput): PairGeometry {
	const issues: Issue[] = [];
	const err = (code: string, message: string) => issues.push({ severity: 'error', code, message });
	const result: PairGeometry = { p: [], n: [], vias: [], cornerSkew: 0, issues };
	const c = g.centerline;
	if (c.length < 2) { err('CENTERLINE_SHORT', 'centerline needs at least 2 points (start and end of the coupled run).'); return result; }
	if (c[0].layer != null || c[c.length - 1].layer != null) err('LAYER_CHANGE_AT_END', 'A layer change goes on an interior centerline point, not on its first or last point.');
	const dirs: Pt[] = [];
	for (let i = 0; i + 1 < c.length; i++) {
		const d = sub(c[i + 1], c[i]);
		if (norm(d) < MIN_LEG) { err('ZERO_LENGTH', `centerline leg ${i} has zero length (duplicate point).`); return result; }
		dirs.push(unit(d));
		const off = angleOffDeg(c[i], c[i + 1]);
		if (off > ANGLE_TOL_DEG) err('NOT_OCTILINEAR', `centerline leg ${i} is ${round(off, 2)}° off a multiple of 45°.`);
		if (i > 0 && dot(dirs[i - 1], dirs[i]) < -1e-9) err('ACUTE_ANGLE', `centerline turns back by more than 90° at point ${i}.`);
	}
	if (issues.length) return result;

	// Sections: one per layer; a layered interior point closes one and opens the next.
	const sections: Array<{ pts: Pt[]; layer: number }> = [];
	let cur: Pt[] = [c[0]];
	let layer = g.startLayer;
	for (let i = 1; i < c.length; i++) {
		cur.push(c[i]);
		const next = c[i].layer;
		if (i < c.length - 1 && next != null && next !== layer) { sections.push({ pts: cur, layer }); cur = [c[i]]; layer = next; }
	}
	sections.push({ pts: cur, layer });

	// Paired vias straddle the centerline at ±viaPitch/2 (miter point when the pair turns there).
	result.vias = sections.slice(0, -1).map((s, b) => {
		const at = s.pts[s.pts.length - 1];
		const n1 = leftOf(unit(sub(at, s.pts[s.pts.length - 2])));
		const nx = sections[b + 1].pts;
		const n2 = leftOf(unit(sub(nx[1], nx[0])));
		const o = (g.pSide * g.viaPitch) / 2;
		return { at, p: miterPoint(at, n1, n2, o), n: miterPoint(at, n1, n2, -o), toLayer: sections[b + 1].layer };
	});

	const build = (name: 'P' | 'N', side: number, from: Pt, to: Pt, viaOf: (v: PairGeometry['vias'][number]) => Pt): LPt[] => {
		const o = (side * g.pitch) / 2;
		let out: LPt[] = [];
		for (const [k, s] of sections.entries()) {
			const off = offsetPolyline(s.pts, o);
			if (off.degenerate != null) {
				err('OFFSET_DEGENERATE', `${name}: centerline${sections.length > 1 ? ` section ${k}` : ''} leg ${off.degenerate} is too short for a ${round(Math.abs(o), 3)} mil offset at its corners — the inner track would reverse. Lengthen that leg (≥ ${round(g.pitch * T225 * 2, 2)} mil per 45° turn, ${round(g.pitch, 2)} per 90°).`);
				return [];
			}
			const start = k === 0 ? from : viaOf(result.vias[k - 1]);
			const end = k === sections.length - 1 ? to : viaOf(result.vias[k]);
			const startLabel = k === 0 ? `${name} start terminal` : `${name} via ${k - 1}`;
			const endLabel = k === sections.length - 1 ? `${name} end terminal` : `${name} via ${k}`;
			const a = fanIn(start, off.points);
			if (!('points' in a)) {
				err('FANIN_GEOMETRY', `${startLabel} sits ${round(a.along, 2)} mil along / ${round(a.across, 2)} mil across from where its offset line starts; the 45° fan-in needs ${round(a.shortBy, 2)} mil more straight leg there — start the centerline further back or lengthen its first leg.`);
				return [];
			}
			const b = fanIn(end, [...a.points].reverse());
			if (!('points' in b)) {
				err('FANIN_GEOMETRY', `${endLabel} sits ${round(b.along, 2)} mil along / ${round(b.across, 2)} mil across from where its offset line ends; the 45° fan-in needs ${round(b.shortBy, 2)} mil more straight leg there — extend the centerline end or lengthen its last leg.`);
				return [];
			}
			const seg = b.points.reverse();
			if (k === 0) out = seg.map((p) => ({ x: p.x, y: p.y }));
			else {
				out[out.length - 1] = { ...out[out.length - 1], layer: s.layer };
				out.push(...seg.slice(1).map((p) => ({ x: p.x, y: p.y })));
			}
		}
		return cleanPolyline(out);
	};
	result.p = build('P', g.pSide, g.pFrom, g.pTo, (v) => v.p);
	result.n = build('N', -g.pSide, g.nFrom, g.nTo, (v) => v.n);

	for (const s of sections) {
		for (let i = 1; i + 1 < s.pts.length; i++) {
			const u1 = unit(sub(s.pts[i], s.pts[i - 1])), u2 = unit(sub(s.pts[i + 1], s.pts[i]));
			const theta = Math.atan2(cross(u1, u2), dot(u1, u2));
			result.cornerSkew += -2 * g.pSide * g.pitch * Math.tan(theta / 2);
		}
	}
	return result;
}

interface LayeredSeg { a: Pt; b: Pt; layer: number }

function segmentsOf(pts: LPt[], startLayer: number): { segs: LayeredSeg[]; vias: Pt[] } {
	const segs: LayeredSeg[] = [];
	const vias: Pt[] = [];
	let layer = startLayer;
	for (let i = 0; i + 1 < pts.length; i++) {
		segs.push({ a: pts[i], b: pts[i + 1], layer });
		const next = pts[i + 1].layer;
		if (next != null && next !== layer) { vias.push(pts[i + 1]); layer = next; }
	}
	return { segs, vias };
}

/** Smallest P–N copper gaps of a plan (edge to edge): track–track on a shared layer, and anything involving a via. */
export function pairGaps(p: LPt[], n: LPt[], startLayer: number, width: number, viaDiameter: number): { track: number; trackAt?: Pt; via?: number; viaAt?: Pt } {
	const P = segmentsOf(p, startLayer), N = segmentsOf(n, startLayer);
	const r = viaDiameter / 2, h = width / 2;
	let track = Number.POSITIVE_INFINITY, trackAt: Pt | undefined;
	let via = Number.POSITIVE_INFINITY, viaAt: Pt | undefined;
	for (const s of P.segs) for (const t of N.segs) {
		if (s.layer !== t.layer) continue;
		const g = segmentDistance(s.a, s.b, t.a, t.b) - width;
		if (g < track) { track = g; trackAt = mul(add(s.a, s.b), 0.5); }
	}
	const viaVsSegs = (vs: Pt[], segs: LayeredSeg[]) => {
		for (const v of vs) for (const s of segs) {
			const g = pointToSegmentDistance(v, s.a, s.b) - r - h;
			if (g < via) { via = g; viaAt = v; }
		}
	};
	viaVsSegs(P.vias, N.segs);
	viaVsSegs(N.vias, P.segs);
	for (const a of P.vias) for (const b of N.vias) {
		const g = dist(a, b) - 2 * r;
		if (g < via) { via = g; viaAt = a; }
	}
	return { track, trackAt, via: Number.isFinite(via) ? via : undefined, viaAt };
}

// ---------------------------------------------------------------------------
// Board rules and pair definitions
// ---------------------------------------------------------------------------

export { normalizeDiffPairs, diffPairRule } from '../../shared/drc-rules';
export type { DiffPairDef, DiffPairRule } from '../../shared/drc-rules';

async function readDiffPairs(): Promise<DiffPairDef[]> {
	const raw = await Promise.resolve().then(() => (eda as any).pcb_Drc?.getAllDifferentialPairs?.()).catch(() => undefined);
	return normalizeDiffPairs(raw);
}

function findPairDef(pairs: DiffPairDef[], name: unknown, net?: string): DiffPairDef | undefined {
	if (name != null && name !== '') return pairs.find((p) => p.name.toLowerCase() === String(name).toLowerCase());
	return net ? pairs.find((p) => p.positiveNet === net || p.negativeNet === net) : undefined;
}

// ---------------------------------------------------------------------------
// Copper path length: shortest path along a net's copper between two items
// ---------------------------------------------------------------------------

interface CItem {
	kind: 'pad' | 'via' | 'track';
	id: string;
	label?: string;
	layer?: any;
	a?: Pt; b?: Pt; half?: number; scale?: number;
	c?: Pt; r?: number;
	polygon?: Pt[]; bounds?: any;
}

interface CopperEdit { remove?: Set<string>; add?: Array<{ id: string; net: string; layer: number; startX: number; startY: number; endX: number; endY: number; lineWidth: number }> }

/** Fetch arcs with their angle so arc length (not chord) counts toward path length. */
async function fetchArcsWithAngle(): Promise<any[]> {
	const raw = await Promise.resolve().then(() => eda.pcb_PrimitiveArc.getAll(undefined, undefined, undefined)).catch(() => []);
	return flattenStateArray((raw as any[]) || []).map((a: any) => ({
		primitiveId: a.primitiveId, net: a.net, layer: layerOf(a.layer) ?? a.layer,
		startX: Number(a.startX), startY: Number(a.startY), endX: Number(a.endX), endY: Number(a.endY),
		lineWidth: Number(a.lineWidth), arcAngle: Number(a.arcAngle),
	}));
}

export function netCopper(snapshot: any, arcs: any[], net: string, edit: CopperEdit = {}): CItem[] {
	const items: CItem[] = [];
	const remove = edit.remove ?? new Set<string>();
	const componentPadIds = new Set((snapshot.componentPads ?? []).map((p: any) => p.primitiveId));
	const pads = [...(snapshot.componentPads ?? []).map((p: any) => [p, 'component_pad'] as const), ...(snapshot.standalonePads ?? []).filter((p: any) => !componentPadIds.has(p.primitiveId)).map((p: any) => [p, 'pad'] as const)];
	for (const [pad, type] of pads) {
		if (pad.net !== net) continue;
		const o = padToObstacle(pad, type);
		if (o) items.push({ kind: 'pad', id: String(pad.primitiveId), label: pad.label, layer: o.layer, c: o.center, polygon: o.polygon, bounds: o.bounds });
	}
	const seg = (l: any, scale = 1): CItem => ({ kind: 'track', id: String(l.primitiveId), layer: l.layer, a: { x: Number(l.startX), y: Number(l.startY) }, b: { x: Number(l.endX), y: Number(l.endY) }, half: Number(l.lineWidth ?? 10) / 2, scale });
	for (const l of snapshot.lines ?? []) if (l.net === net && !remove.has(String(l.primitiveId))) items.push(seg(l));
	for (const l of edit.add ?? []) if (l.net === net) items.push(seg({ ...l, primitiveId: l.id }));
	for (const arc of arcs) {
		if (arc.net !== net || remove.has(String(arc.primitiveId))) continue;
		const chord = Math.hypot(arc.endX - arc.startX, arc.endY - arc.startY);
		const th = (Math.abs(Number(arc.arcAngle)) * Math.PI) / 180;
		const scale = Number.isFinite(th) && th > 1e-6 && chord > 0 ? th / 2 / Math.sin(th / 2) : 1;
		items.push(seg(arc, scale));
	}
	for (const v of snapshot.vias ?? []) {
		if (v.net === net && !remove.has(String(v.primitiveId))) items.push({ kind: 'via', id: String(v.primitiveId), c: { x: Number(v.x), y: Number(v.y) }, r: Number(v.diameter ?? 24) / 2 });
	}
	return items.filter((it) => it.kind !== 'track' || [it.a!.x, it.a!.y, it.b!.x, it.b!.y].every(Number.isFinite));
}

function paramOn(it: CItem, p: Pt): number {
	const d = sub(it.b!, it.a!);
	const l2 = dot(d, d);
	return l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(p, it.a!), d) / l2));
}

function pointOn(it: CItem, t: number): Pt {
	return add(it.a!, mul(sub(it.b!, it.a!), t));
}

function intersection(a: Pt, b: Pt, c: Pt, d: Pt): Pt | undefined {
	const r = sub(b, a), s = sub(d, c);
	const den = cross(r, s);
	if (Math.abs(den) < 1e-12) return undefined;
	const t = cross(sub(c, a), s) / den, u = cross(sub(c, a), r) / den;
	return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? add(a, mul(r, t)) : undefined;
}

/**
 * Shortest copper path between two pad/via items of one net. Tracks are
 * centrelines with stations wherever other copper touches them (copper
 * overlap, not just shared endpoints), so touching meander runs, T-junctions
 * and crossings all shorten the path exactly as current would.
 */
export function shortestCopperPath(items: CItem[], fromId: string, toId: string): { length: number; trackIds: string[]; reachedPads: string[] } | undefined {
	let nodes = 0;
	const itemNode = new Map<number, number>();
	const stations = new Map<number, Array<{ t: number; node: number }>>();
	const edges: Array<{ a: number; b: number; w: number; track?: string }> = [];
	const station = (i: number, t: number): number => {
		const list = stations.get(i)!;
		const hit = list.find((s) => Math.abs(s.t - t) < 1e-9);
		if (hit) return hit.node;
		const node = nodes++;
		list.push({ t, node });
		return node;
	};
	items.forEach((it, i) => {
		if (it.kind === 'track') { stations.set(i, []); station(i, 0); station(i, 1); }
		else itemNode.set(i, nodes++);
	});
	const link = (a: number, b: number, w: number) => edges.push({ a, b, w });
	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) {
			const A = items[i], B = items[j];
			if (A.kind === 'track' && B.kind === 'track') {
				if (!layersTouch(A.layer, B.layer)) continue;
				const reach = A.half! + B.half! + CONTACT_EPS;
				if (segmentDistance(A.a!, A.b!, B.a!, B.b!) > reach) continue;
				const tryPair = (ti: number, tj: number) => {
					const w = dist(pointOn(A, ti), pointOn(B, tj));
					if (w <= reach) link(station(i, ti), station(j, tj), w);
				};
				tryPair(paramOn(A, B.a!), 0);
				tryPair(paramOn(A, B.b!), 1);
				tryPair(0, paramOn(B, A.a!));
				tryPair(1, paramOn(B, A.b!));
				const x = intersection(A.a!, A.b!, B.a!, B.b!);
				if (x) tryPair(paramOn(A, x), paramOn(B, x));
				continue;
			}
			if (A.kind === 'track' || B.kind === 'track') {
				const [ti, oi] = A.kind === 'track' ? [i, j] : [j, i];
				const t = items[ti], o = items[oi];
				const touching = o.kind === 'via'
					? pointToSegmentDistance(o.c!, t.a!, t.b!) <= o.r! + t.half! + CONTACT_EPS
					: layersTouch(t.layer, o.layer) && !!polygonHit(t.a!, t.b!, o.polygon, o.bounds, t.half!, CONTACT_EPS);
				if (touching) {
					const s = paramOn(t, o.c!);
					link(station(ti, s), itemNode.get(oi)!, dist(pointOn(t, s), o.c!));
				}
				continue;
			}
			// pad/via ↔ pad/via
			let touching = false;
			if (A.kind === 'via' && B.kind === 'via') touching = dist(A.c!, B.c!) <= A.r! + B.r! + CONTACT_EPS;
			else if (A.kind === 'via' || B.kind === 'via') {
				const [v, pad] = A.kind === 'via' ? [A, B] : [B, A];
				touching = !!polygonHit(v.c!, v.c!, pad.polygon, pad.bounds, v.r!, CONTACT_EPS);
			} else if (layersTouch(A.layer, B.layer)) {
				touching = A.polygon!.some((pt) => !!polygonHit(pt, pt, B.polygon, B.bounds, 0, CONTACT_EPS)) || B.polygon!.some((pt) => !!polygonHit(pt, pt, A.polygon, A.bounds, 0, CONTACT_EPS));
			}
			if (touching) link(itemNode.get(i)!, itemNode.get(j)!, dist(A.c!, B.c!));
		}
	}
	for (const [i, list] of stations) {
		const it = items[i];
		const len = dist(it.a!, it.b!) * (it.scale ?? 1);
		list.sort((x, y) => x.t - y.t);
		for (let s = 1; s < list.length; s++) edges.push({ a: list[s - 1].node, b: list[s].node, w: (list[s].t - list[s - 1].t) * len, track: it.id });
	}
	const fromIdx = items.findIndex((it) => it.kind !== 'track' && it.id === fromId);
	const toIdx = items.findIndex((it) => it.kind !== 'track' && it.id === toId);
	if (fromIdx < 0 || toIdx < 0) return undefined;
	const adj: Array<Array<{ to: number; w: number; e: number }>> = Array.from({ length: nodes }, () => []);
	edges.forEach((e, idx) => { adj[e.a].push({ to: e.b, w: e.w, e: idx }); adj[e.b].push({ to: e.a, w: e.w, e: idx }); });
	const start = itemNode.get(fromIdx)!, goal = itemNode.get(toIdx)!;
	const best = new Array<number>(nodes).fill(Number.POSITIVE_INFINITY);
	const via = new Array<number>(nodes).fill(-1);
	const done = new Array<boolean>(nodes).fill(false);
	best[start] = 0;
	const heap: Array<[number, number]> = [[0, start]];
	const push = (item: [number, number]) => {
		heap.push(item);
		for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
	};
	const pop = (): [number, number] => {
		const top = heap[0], last = heap.pop()!;
		if (heap.length) {
			heap[0] = last;
			for (let i = 0; ;) {
				const l = 2 * i + 1, r = l + 1;
				let m = i;
				if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
				if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
				if (m === i) break;
				[heap[m], heap[i]] = [heap[i], heap[m]];
				i = m;
			}
		}
		return top;
	};
	while (heap.length) {
		const [d, node] = pop();
		if (done[node]) continue;
		done[node] = true;
		for (const { to, w, e } of adj[node]) {
			if (d + w < best[to]) { best[to] = d + w; via[to] = e; push([d + w, to]); }
		}
	}
	if (!Number.isFinite(best[goal])) return undefined;
	const trackIds = new Set<string>();
	for (let node = goal; node !== start;) {
		const e = edges[via[node]];
		if (e.track && e.w > 0) trackIds.add(e.track);
		node = e.a === node ? e.b : e.a;
	}
	const reachedPads = items.flatMap((it, i) => (it.kind === 'pad' && done[itemNode.get(i)!] ? [it.label ?? it.id] : []));
	return { length: best[goal], trackIds: [...trackIds], reachedPads };
}

/** A point where other same-net copper joins `legId` away from both of its ends (a branch a meander would cut off). */
function interiorJunction(items: CItem[], legId: string): Pt | undefined {
	const leg = items.find((it) => it.kind === 'track' && it.id === legId);
	if (!leg) return undefined;
	const inside = (p: Pt, reach: number) => dist(p, leg.a!) > reach && dist(p, leg.b!) > reach;
	for (const it of items) {
		if (it === leg) continue;
		if (it.kind === 'track') {
			if (!layersTouch(leg.layer, it.layer)) continue;
			const reach = leg.half! + it.half! + CONTACT_EPS;
			if (segmentDistance(leg.a!, leg.b!, it.a!, it.b!) > reach) continue;
			const contacts = [it.a!, it.b!].map((e) => ({ e, q: pointOn(leg, paramOn(leg, e)) })).filter(({ e, q }) => dist(e, q) <= reach).map(({ q }) => q);
			const x = intersection(leg.a!, leg.b!, it.a!, it.b!);
			if (x) contacts.push(x);
			const hit = contacts.find((q) => inside(q, reach));
			if (hit) return hit;
			continue;
		}
		const radius = it.kind === 'via' ? it.r! : Math.hypot(it.bounds.maxX - it.bounds.minX, it.bounds.maxY - it.bounds.minY) / 2;
		const touching = it.kind === 'via'
			? pointToSegmentDistance(it.c!, leg.a!, leg.b!) <= it.r! + leg.half! + CONTACT_EPS
			: layersTouch(leg.layer, it.layer) && !!polygonHit(leg.a!, leg.b!, it.polygon, it.bounds, leg.half!, CONTACT_EPS);
		const q = pointOn(leg, paramOn(leg, it.c!));
		if (touching && inside(q, radius + leg.half! + CONTACT_EPS)) return q;
	}
	return undefined;
}

/** Endpoint ids for a path measurement: explicit [a, b] terminals, else the net's only two pads. */
function resolveEnds(spec: any, net: string, snapshot: any): { from: string; to: string; labels: [string, string] } | string {
	const pads = [...(snapshot.componentPads ?? []), ...(snapshot.standalonePads ?? [])].filter((p: any) => p.net === net);
	const one = (t: any): { id: string; label: string } | string => {
		const ref = typeof t === 'string' ? t : t?.pad;
		if (typeof ref === 'string') {
			const want = ref.trim().replace(':', '.').toUpperCase();
			const pad = (snapshot.componentPads ?? []).find((p: any) => String(p.label ?? '').toUpperCase() === want);
			if (!pad) return `pad "${ref}" not found`;
			if (pad.net !== net) return `pad ${pad.label} is on net "${pad.net}", not "${net}"`;
			return { id: String(pad.primitiveId), label: pad.label };
		}
		if (typeof t?.via === 'string') {
			const v = (snapshot.vias ?? []).find((x: any) => x.primitiveId === t.via);
			if (!v) return `via "${t.via}" not found`;
			return { id: String(v.primitiveId), label: `via ${v.primitiveId}` };
		}
		return 'a measurement endpoint must be a pad ref ("U3.12") or {via:id}';
	};
	if (Array.isArray(spec) && spec.length === 2) {
		const a = one(spec[0]), b = one(spec[1]);
		if (typeof a === 'string') return a;
		if (typeof b === 'string') return b;
		return { from: a.id, to: b.id, labels: [a.label, b.label] };
	}
	const unique = [...new Map(pads.map((p: any) => [p.primitiveId, p])).values()] as any[];
	if (unique.length !== 2) return `net "${net}" has ${unique.length} pads (${unique.slice(0, 8).map((p) => p.label ?? p.primitiveId).join(', ')}); pass the two endpoints of the path to measure`;
	return { from: String(unique[0].primitiveId), to: String(unique[1].primitiveId), labels: [unique[0].label ?? unique[0].primitiveId, unique[1].label ?? unique[1].primitiveId] };
}

function resolveTerminalPoint(spec: any, snapshot: any, k: number): { x: number; y: number; layer?: number; net?: string; label: string } | string {
	const padRef = typeof spec === 'string' ? spec : spec?.pad;
	if (typeof padRef === 'string') {
		const want = padRef.trim().replace(':', '.').toUpperCase();
		const pad = (snapshot.componentPads ?? []).find((p: any) => String(p.label ?? '').toUpperCase() === want);
		if (!pad) return `pad "${padRef}" not found (use DESIGNATOR.PAD, e.g. "U3.12")`;
		const o = padToObstacle(pad, 'component_pad');
		return { x: pad.x, y: pad.y, layer: o?.layer === MULTI_LAYER ? undefined : (o?.layer as number | undefined), net: pad.net, label: pad.label };
	}
	if (typeof spec?.via === 'string') {
		const v = (snapshot.vias ?? []).find((x: any) => x.primitiveId === spec.via);
		if (!v) return `via "${spec.via}" not found`;
		return { x: v.x, y: v.y, net: v.net, label: `via ${v.primitiveId}` };
	}
	if (typeof spec?.track === 'string') {
		const t = (snapshot.lines ?? []).find((x: any) => x.primitiveId === spec.track);
		if (!t) return `track "${spec.track}" not found`;
		if (spec.x != null && spec.y != null) return { x: Number(spec.x) * k, y: Number(spec.y) * k, layer: Number(t.layer), net: t.net, label: `track ${t.primitiveId}` };
		const atEnd = spec.end === 'end';
		return { x: atEnd ? t.endX : t.startX, y: atEnd ? t.endY : t.startY, layer: Number(t.layer), net: t.net, label: `track ${t.primitiveId}` };
	}
	const x = Number(spec?.x) * k, y = Number(spec?.y) * k;
	if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, layer: spec.layer != null ? layerOf(spec.layer) : undefined, label: `(${spec.x}, ${spec.y})` };
	return 'a terminal must be a pad ref ("U3.12"), {via:id}, {track:id, end?} or {x,y,layer}';
}

// ---------------------------------------------------------------------------
// pcb.route.pair
// ---------------------------------------------------------------------------

async function routePair(params: Record<string, any>): Promise<any> {
	const units: Units = params.units === 'mm' ? 'mm' : 'mil';
	const k = units === 'mm' ? MIL_PER_MM : 1;
	const u = (v: number) => round(v / k, 4);
	const dryRun = params.dryRun !== false;
	const issues: Issue[] = [];
	const err = (code: string, message: string) => issues.push({ severity: 'error', code, message });
	const warn = (code: string, message: string) => issues.push({ severity: 'warning', code, message });

	const [snapshot, rules, pairs] = await Promise.all([getSnapshot({ forceRefresh: true }), fetchDrcRules().catch(() => undefined), readDiffPairs()]);
	const pSpec = params.p ?? {}, nSpec = params.n ?? {};
	const term = (spec: any, label: string) => {
		if (spec == null) { err('TERMINAL_REQUIRED', `"${label}" is required.`); return undefined; }
		const t = resolveTerminalPoint(spec, snapshot, k);
		if (typeof t === 'string') { err('BAD_TERMINAL', `${label}: ${t}.`); return undefined; }
		return t;
	};
	const pFrom = term(pSpec.from, 'p.from'), pTo = term(pSpec.to, 'p.to'), nFrom = term(nSpec.from, 'n.from'), nTo = term(nSpec.to, 'n.to');

	let def = params.pair ? findPairDef(pairs, params.pair) : undefined;
	if (params.pair && !def) err('PAIR_NOT_FOUND', `No differential pair named "${params.pair}" (defined: ${pairs.map((d) => d.name).join(', ') || 'none'}).`);
	const pNet = String(params.pNet ?? def?.positiveNet ?? pFrom?.net ?? '');
	const nNet = String(params.nNet ?? def?.negativeNet ?? nFrom?.net ?? '');
	if (!pNet || !nNet) err('NETS_REQUIRED', 'Pass pair (an EasyEDA differential-pair name) or pNet/nNet, or use pad terminals that carry their nets.');
	else if (pNet === nNet) err('SAME_NET', `P and N are both "${pNet}".`);
	def ??= pairs.find((d) => (d.positiveNet === pNet && d.negativeNet === nNet) || (d.positiveNet === nNet && d.negativeNet === pNet));
	if (def && def.positiveNet === nNet) warn('PAIR_POLARITY', `EasyEDA defines "${def.name}" with positive net ${def.positiveNet}; it is routed here as N.`);

	const rule = pNet ? diffPairRule(rules?.ruleConfig, rules?.netRules, def?.name, pNet) : { reason: 'no nets' };
	const pr = 'reason' in rule ? undefined : rule;
	let width = Number(params.width) * k, widthSource = 'param';
	if (!(width > 0)) {
		if (pr?.widthMil) { width = pr.widthMil; widthSource = pr.source; }
		else { width = 0; err('WIDTH_REQUIRED', `Pass "width" (${'reason' in rule ? rule.reason : 'the pair rule has no track width'}).`); }
	}
	let gap = Number(params.gap) * k, gapSource = 'param';
	if (!(gap > 0)) {
		if (pr?.gapMil) { gap = pr.gapMil; gapSource = pr.source; }
		else { gap = 0; err('GAP_REQUIRED', `Pass "gap" (edge-to-edge; ${'reason' in rule ? rule.reason : 'the pair rule has no spacing'}).`); }
	}
	if (pr?.widthMinMil && width > 0 && width < pr.widthMinMil - 1e-3) err('WIDTH_BELOW_RULE', `width ${u(width)} is below the pair rule minimum ${u(pr.widthMinMil)} (${pr.source}).`);
	if (pr?.gapMinMil && gap > 0 && gap < pr.gapMinMil - 1e-3) err('GAP_BELOW_RULE', `gap ${u(gap)} is below the pair rule minimum ${u(pr.gapMinMil)} (${pr.source}).`);
	const pitch = width + gap;

	const resolver = clearanceResolverFromRules(rules?.ruleConfig, rules?.netRules, [pNet, nNet]);
	const explicitClr = params.clearanceMil != null && params.clearanceMil !== '' ? Number(params.clearanceMil) : undefined;
	const clrTrack = explicitClr ?? resolver.between(pNet, nNet, 'track').clearanceMil;
	const clrVia = explicitClr ?? resolver.between(pNet, nNet, 'via').clearanceMil;

	const viaRule = rules && pNet ? viaSizeForNet(rules.ruleConfig, rules.netRules, pNet) : undefined;
	const viaD = Number(params.via?.diameter) > 0 ? Number(params.via.diameter) * k : viaRule?.diameterMil ?? DEFAULT_VIA.diameter;
	const viaHole = Number(params.via?.holeDiameter ?? params.via?.hole) > 0 ? Number(params.via.holeDiameter ?? params.via.hole) * k : viaRule?.drillMil ?? DEFAULT_VIA.holeDiameter;
	const viaSource = params.via ? 'param' : viaRule ? viaRule.source : 'default';
	const viaPitch = Number(params.viaPitch) > 0 ? Number(params.viaPitch) * k : Math.max(pitch, viaD + Math.max(gap, clrVia));
	const viaPitchSource = Number(params.viaPitch) > 0 ? 'param' : `via diameter + max(gap, P–N via clearance ${round(clrVia, 3)} mil)`;

	let startLayer = params.layer != null ? layerOf(params.layer) : pFrom?.layer ?? nFrom?.layer;
	if (params.layer != null && startLayer == null) err('BAD_LAYER', `layer "${params.layer}" is not a copper layer.`);
	if (startLayer == null && pFrom && nFrom) err('LAYER_REQUIRED', 'Both start terminals have copper on every layer; pass "layer" for the first section.');

	const centerline: LPt[] = [];
	for (const [i, p] of (Array.isArray(params.centerline) ? params.centerline : []).entries()) {
		const x = Number(p?.x) * k, y = Number(p?.y) * k;
		if (!Number.isFinite(x) || !Number.isFinite(y)) { err('BAD_POINT', `centerline[${i}] needs numeric x and y.`); continue; }
		const l = p.layer != null ? layerOf(p.layer) : undefined;
		if (p.layer != null && l == null) err('BAD_LAYER', `centerline[${i}].layer "${p.layer}" is not a copper layer.`);
		centerline.push(l != null ? { x, y, layer: l } : { x, y });
	}
	if (centerline.length < 2) err('CENTERLINE_REQUIRED', 'Pass centerline: the coupled run\'s centre as ≥2 octilinear points (a point with "layer" = paired vias there).');

	// Which side P runs on, from the start pads; the end pads must agree.
	let pSide: 1 | -1 = 1;
	if (pFrom && nFrom && pTo && nTo && centerline.length >= 2) {
		const n0 = leftOf(unit(sub(centerline[1], centerline[0])));
		const nl = leftOf(unit(sub(centerline[centerline.length - 1], centerline[centerline.length - 2])));
		const startDiff = dot(sub(pFrom, centerline[0]), n0) - dot(sub(nFrom, centerline[0]), n0);
		const endDiff = dot(sub(pTo, centerline[centerline.length - 1]), nl) - dot(sub(nTo, centerline[centerline.length - 1]), nl);
		if (params.pSide === 'left' || params.pSide === 'right') pSide = params.pSide === 'left' ? 1 : -1;
		else if (Math.abs(startDiff) > 1e-6) pSide = startDiff > 0 ? 1 : -1;
		else if (Math.abs(endDiff) > 1e-6) pSide = endDiff > 0 ? 1 : -1;
		else err('PAIR_SIDE_AMBIGUOUS', 'P and N sit on the same side line at both ends; pass pSide:"left"|"right" (relative to the centerline direction).');
		if (endDiff * pSide < -1e-6) err('PAIR_CROSSES', `P is on the ${pSide > 0 ? 'left' : 'right'} at the start but its end pad is on the other side — the tracks would have to cross. Check the pin assignment or route a crossover with a layer change explicitly.`);
	}

	const pairInfo: any = {
		name: def?.name, pNet, nNet, pSide: pSide > 0 ? 'left' : 'right',
		width: u(width), gap: u(gap), pitch: u(pitch), widthSource, gapSource,
		via: { diameter: u(viaD), hole: u(viaHole), source: viaSource, pitch: u(viaPitch), pitchSource: viaPitchSource },
		clearance: { track: u(clrTrack), via: u(clrVia), source: explicitClr != null ? 'param:clearanceMil' : resolver.between(pNet, nNet, 'track').source },
	};
	const invalid = (extra: any = {}) => ({ status: 'invalid', units, dryRun, pair: pairInfo, issues, created: [], ...extra, note: 'Nothing was created. Fix the errors and re-plan the centerline.' });
	if (issues.some((i) => i.severity === 'error')) return invalid();

	const geo = planPairGeometry({ centerline, startLayer: startLayer!, pitch, viaPitch, pSide, pFrom: pFrom!, pTo: pTo!, nFrom: nFrom!, nTo: nTo! });
	issues.push(...geo.issues);
	const pts = (list: LPt[]) => list.map((p) => (p.layer != null ? [u(p.x), u(p.y), p.layer] : [u(p.x), u(p.y)]));
	if (issues.some((i) => i.severity === 'error')) return invalid({ plan: geo.p.length || geo.n.length ? { p: pts(geo.p), n: pts(geo.n) } : undefined });

	const gaps = pairGaps(geo.p, geo.n, startLayer!, width, viaD);
	const needTrack = Math.min(gap, clrTrack);
	if (gaps.track < needTrack - 1e-3) err('PAIR_GAP_VIOLATION', `P and N come within ${u(gaps.track)} of each other near (${u(gaps.trackAt!.x)}, ${u(gaps.trackAt!.y)}) — below ${u(needTrack)} (fan-in or via spread). Move the centerline ends or widen viaPitch.`);
	if (gaps.via != null && gaps.via < clrVia - 1e-3) err('PAIR_VIA_CLEARANCE', `A paired via is ${u(gaps.via)} from the other net near (${u(gaps.viaAt!.x)}, ${u(gaps.viaAt!.y)}) — below the ${u(clrVia)} via clearance. Raise viaPitch.`);
	if (gap < clrTrack - 1e-3) warn('PAIR_GAP_BELOW_CLEARANCE', `The pair gap ${u(gap)} is below the P–N Safe Spacing ${u(clrTrack)}; EasyEDA's DRC may flag the coupled run unless the pair rule governs it.`);
	const lenP = polylineLength(geo.p), lenN = polylineLength(geo.n);
	const skew = lenP - lenN;
	const tolerance = Number(params.maxSkew) > 0 ? Number(params.maxSkew) * k : pr?.lenTolMil;
	if (tolerance != null && Math.abs(skew) > tolerance + 1e-6) warn('SKEW_ABOVE_TOLERANCE', `P−N skew ${u(skew)} exceeds ${u(tolerance)} — balance the turns (pair a left turn with a right one) or tune the short net with pcb_length_tune.`);
	const skewInfo = { p: u(lenP), n: u(lenN), skew: u(skew), corners: u(geo.cornerSkew), tolerance: tolerance != null ? u(tolerance) : undefined };
	const gapInfo = { coupled: u(gap), min: u(gaps.track), required: u(needTrack), viaMin: gaps.via != null ? u(gaps.via) : undefined };
	if (issues.some((i) => i.severity === 'error')) return invalid({ skew: skewInfo, gap: gapInfo, plan: { p: pts(geo.p), n: pts(geo.n) } });

	const interior = (list: LPt[]) => list.slice(1, -1).map((p) => (p.layer != null ? { x: p.x / k, y: p.y / k, layer: p.layer } : { x: p.x / k, y: p.y / k }));
	const rp = await routePath({
		// Lets route-path size its verification to the gate deadline.
		_gateDeadlineAt: params._gateDeadlineAt,
		units,
		dryRun,
		verify: params.verify,
		keepOnVerifyFail: params.keepOnVerifyFail,
		requestId: params.requestId,
		clearanceMil: params.clearanceMil,
		ignorePrimitiveIds: params.ignorePrimitiveIds,
		snap: ROUTE_SNAP,
		via: { diameter: viaD / k, holeDiameter: viaHole / k },
		routes: [
			{ net: pNet, from: pSpec.from, to: pSpec.to, width: width / k, layer: startLayer, points: interior(geo.p) },
			{ net: nNet, from: nSpec.from, to: nSpec.to, width: width / k, layer: startLayer, points: interior(geo.n) },
		],
	});

	// Report the truth: measured pad-to-pad path lengths of what is now on the board.
	let measured: any;
	if (rp.status === 'committed' || rp.status === 'committed-unverified' || rp.status === 'already-present') {
		const after = await getSnapshot({});
		const arcs = await fetchArcsWithAngle();
		const lengthOf = (net: string, from: any, to: any) => {
			const ends = resolveEnds([from, to], net, after);
			if (typeof ends === 'string') return undefined;
			return shortestCopperPath(netCopper(after, arcs, net), ends.from, ends.to)?.length;
		};
		const mp = lengthOf(pNet, pSpec.from, pSpec.to), mn = lengthOf(nNet, nSpec.from, nSpec.to);
		if (mp != null || mn != null) measured = { p: mp != null ? u(mp) : undefined, n: mn != null ? u(mn) : undefined, skew: mp != null && mn != null ? u(mp - mn) : undefined };
	}
	return {
		...rp,
		pair: pairInfo,
		skew: skewInfo,
		gap: gapInfo,
		vias: geo.vias.length ? geo.vias.map((v) => ({ p: [u(v.p.x), u(v.p.y)], n: [u(v.n.x), u(v.n.y)], toLayer: v.toLayer })) : undefined,
		measured,
		issues: issues.length ? issues : undefined,
	};
}

// ---------------------------------------------------------------------------
// pcb.route.lengthTune
// ---------------------------------------------------------------------------

export interface MeanderSolution { bumps: number; amplitude: number; miter: number }

/**
 * Bumps N, amplitude A, chamfer m so that N bumps add exactly `delta`:
 * each bump adds 2A − m·(8 − 4√2). Fewest bumps whose amplitude fits `cap`.
 */
export function solveMeander(delta: number, o: { cap: number; minAmplitude: number; pitch: number; miter: number; usable: number; minMiter?: number }): MeanderSolution | { reason: 'too-small' | 'leg-too-short'; maxByLength: number; bumpsThatFit: number } {
	const s = o.pitch;
	const m0 = Math.min(o.miter, s / 2);
	const fits = (n: number, m: number) => 2 * m + s * (2 * n - 1) <= o.usable + 1e-9;
	const nFit = Math.max(0, Math.floor(((o.usable - 2 * m0) / s + 1) / 2));
	const perBump = (A: number, m: number) => 2 * A - m * MITER_LOSS;
	const maxByLength = nFit * perBump(o.cap, Math.min(m0, o.cap / 2));
	for (let n = 1; n <= Math.max(nFit, 1) && n <= 1000; n++) {
		const d1 = delta / n;
		let m = m0;
		let A = (d1 + MITER_LOSS * m) / 2;
		if (A < 2 * m) { m = d1 / (4 - MITER_LOSS); A = 2 * m; }
		if (o.minMiter != null && m > 0 && m < o.minMiter) { m = 0; A = d1 / 2; }
		if (A < o.minAmplitude - 1e-9) {
			// Raise A with a bigger chamfer (a bump with chamfer m adds 2A − 2.343m).
			const m2 = (2 * o.minAmplitude - d1) / MITER_LOSS;
			if (m2 <= o.minAmplitude / 2 && m2 <= s / 2 && (o.minMiter == null || m2 >= o.minMiter)) { m = m2; A = o.minAmplitude; }
			else return { reason: 'too-small', maxByLength, bumpsThatFit: nFit };
		}
		if (A > o.cap + 1e-9) continue;
		if (!fits(n, m)) return { reason: 'leg-too-short', maxByLength, bumpsThatFit: nFit };
		return { bumps: n, amplitude: A, miter: m };
	}
	return { reason: 'leg-too-short', maxByLength, bumpsThatFit: nFit };
}

/** Meander vertices in a local frame (t along the leg, h toward the bump side), centred on [lo, hi]. */
export function meanderLocal(sol: MeanderSolution, pitch: number, lo: number, hi: number): Array<{ t: number; h: number }> {
	const { bumps: n, amplitude: A, miter: m } = sol;
	const s = pitch;
	const span = 2 * m + s * (2 * n - 1);
	const t0 = (lo + hi) / 2 - span / 2 + m;
	const out: Array<{ t: number; h: number }> = [];
	for (let i = 0; i < n; i++) {
		const t = t0 + 2 * s * i;
		out.push({ t: t - m, h: 0 }, { t, h: m }, { t, h: A - m }, { t: t + m, h: A }, { t: t + s - m, h: A }, { t: t + s, h: A - m }, { t: t + s, h: m }, { t: t + s + m, h: 0 });
	}
	return out;
}

interface TuneNet { net: string; legId: string; layer: number; width: number; legLength: number; path: Pt[]; before: number; reached: string[]; ends: { from: string; to: string; labels: [string, string] } }
interface Candidate { side: 1 | -1; cap: number; sol: MeanderSolution; nets: Array<TuneNet & { added: number; predicted?: number }>; reject?: string }

const host = globalThis as unknown as { __easyedaLengthTuneResultsV1?: Map<string, any> };
const recentTunes: Map<string, any> = host.__easyedaLengthTuneResultsV1 ??= new Map();

async function lengthTune(params: Record<string, any>): Promise<any> {
	const requestId = params.requestId != null ? String(params.requestId) : undefined;
	if (requestId && recentTunes.has(requestId)) return { ...recentTunes.get(requestId), replayed: true };
	const result = await lengthTuneOnce(params);
	if (requestId && params.dryRun === false && (result.status === 'committed' || result.status === 'partial')) {
		recentTunes.set(requestId, { ...result, requestId });
		while (recentTunes.size > 50) recentTunes.delete(recentTunes.keys().next().value!);
	}
	return requestId ? { ...result, requestId } : result;
}

async function lengthTuneOnce(params: Record<string, any>): Promise<any> {
	const units: Units = params.units === 'mm' ? 'mm' : 'mil';
	const k = units === 'mm' ? MIL_PER_MM : 1;
	const u = (v: number) => round(v / k, 4);
	const dryRun = params.dryRun !== false;
	const tol = Number(params.tolerance) > 0 ? Number(params.tolerance) * k : 1;
	const issues: Issue[] = [];
	const warn = (code: string, message: string) => issues.push({ severity: 'warning', code, message });
	const refuse = (status: string, code: string, message: string, extra: any = {}) => ({ status, units, dryRun, ...extra, issues: [...issues, { severity: 'error', code, message }], created: [] });

	const snapshot = await getSnapshot({ forceRefresh: true });
	const arcs = await fetchArcsWithAngle();
	const leg = (snapshot.lines as any[]).find((l) => l.primitiveId === params.track);
	if (!leg) return refuse('invalid', 'TRACK_NOT_FOUND', `Track "${params.track}" not found (pass the id of a straight Line leg).`);
	const net = String(leg.net ?? '');
	if (!net) return refuse('invalid', 'NO_NET', `Track ${leg.primitiveId} has no net.`);
	const A0: Pt = { x: Number(leg.startX), y: Number(leg.startY) }, B0: Pt = { x: Number(leg.endX), y: Number(leg.endY) };
	const L = dist(A0, B0);
	if (L < MIN_LEG) return refuse('invalid', 'ZERO_LENGTH', `Track ${leg.primitiveId} has zero length.`);
	const ax = unit(sub(B0, A0)), n = leftOf(ax);
	const width = Number(leg.lineWidth ?? 10), layer = Number(layerOf(leg.layer) ?? leg.layer);
	const offAngle = angleOffDeg(A0, B0) > ANGLE_TOL_DEG;
	if (offAngle) warn('LEG_NOT_OCTILINEAR', 'The leg is not at a multiple of 45°; the meander follows its angle.');

	const pairs = await readDiffPairs();
	const def = findPairDef(pairs, params.pair, net);
	if (params.pair && !def) return refuse('invalid', 'PAIR_NOT_FOUND', `No differential pair named "${params.pair}".`);
	const coupled = params.coupled === true;
	if (coupled && params.matchPartner) return refuse('invalid', 'COUPLED_MATCH_PARTNER', 'coupled tuning adds the same length to both nets, so it cannot fix intra-pair skew — tune the short net alone (coupled:false, matchPartner:true).');
	const partnerNet = def ? (def.positiveNet === net ? def.negativeNet : def.positiveNet) : params.partnerNet != null ? String(params.partnerNet) : undefined;
	if ((coupled || params.matchPartner) && !partnerNet) return refuse('invalid', 'PAIR_NOT_FOUND', `"${net}" is not in a differential pair EasyEDA knows; pass pair or partnerNet.`);

	// The partner's parallel leg: tuned together (coupled) or kept clear of (single).
	const lines = snapshot.lines as any[];
	const along = (p: Pt) => dot(sub(p, A0), ax), across = (p: Pt) => dot(sub(p, A0), n);
	const partnerLegOf = (l: any) => {
		const a = { x: Number(l.startX), y: Number(l.startY) }, b = { x: Number(l.endX), y: Number(l.endY) };
		if (Number(layerOf(l.layer) ?? l.layer) !== layer || Math.abs(cross(ax, unit(sub(b, a)))) > 1e-3) return undefined;
		const lo = Math.max(0, Math.min(along(a), along(b))), hi = Math.min(L, Math.max(along(a), along(b)));
		return hi - lo > MIN_LEG ? { line: l, a, b, h: across(a), lo, hi } : undefined;
	};
	let partner: ReturnType<typeof partnerLegOf>;
	if (partnerNet) {
		if (params.partnerTrack) {
			const l = lines.find((x) => x.primitiveId === params.partnerTrack);
			if (!l) return refuse('invalid', 'PARTNER_NOT_FOUND', `Partner track "${params.partnerTrack}" not found.`);
			partner = partnerLegOf(l);
			if (!partner && coupled) return refuse('invalid', 'PARTNER_NOT_PARALLEL', `Track ${params.partnerTrack} is not a parallel, overlapping leg on the same layer.`);
		} else {
			partner = lines.filter((l) => l.net === partnerNet).map(partnerLegOf).filter((x): x is NonNullable<typeof x> => !!x).sort((x, y) => Math.abs(x.h) - Math.abs(y.h))[0];
		}
		if (coupled && !partner) return refuse('invalid', 'PARTNER_NOT_FOUND', `No ${partnerNet} leg runs parallel to ${leg.primitiveId} on its layer; pass partnerTrack.`);
	}

	// Measure what is there now.
	const ends = resolveEnds(params.between, net, snapshot);
	if (typeof ends === 'string') return refuse('invalid', 'ENDPOINTS_REQUIRED', `${ends}.`);
	const before = shortestCopperPath(netCopper(snapshot, arcs, net), ends.from, ends.to);
	if (!before) return refuse('invalid', 'NOT_CONNECTED', `The copper of "${net}" does not join ${ends.labels[0]} and ${ends.labels[1]}; route it first.`);
	if (!before.trackIds.includes(String(leg.primitiveId))) return refuse('invalid', 'LEG_NOT_ON_PATH', `Track ${leg.primitiveId} is not on the copper path from ${ends.labels[0]} to ${ends.labels[1]} (a stub or a redundant branch) — a meander there adds copper but no path length. Pick a leg on the path.`, { before: u(before.length) });
	const branch = (n0: string, id: string) => {
		const at = interiorJunction(netCopper(snapshot, arcs, n0), id);
		return at ? refuse('invalid', 'LEG_HAS_JUNCTION', `Other ${n0} copper joins track ${id} at (${u(at.x)}, ${u(at.y)}), away from its ends — a meander would cut that branch off. Tune a leg without junctions.`) : undefined;
	};
	const branched = branch(net, String(leg.primitiveId)) ?? (coupled && partner ? branch(partnerNet!, String(partner.line.primitiveId)) : undefined);
	if (branched) return branched;
	const tuned: TuneNet[] = [{ net, legId: String(leg.primitiveId), layer, width, legLength: L, path: [], before: before.length, reached: before.reachedPads, ends }];
	if (coupled && partner) {
		const pEnds = resolveEnds(params.partnerBetween, partnerNet!, snapshot);
		if (typeof pEnds === 'string') return refuse('invalid', 'ENDPOINTS_REQUIRED', `partner: ${pEnds}.`);
		const pBefore = shortestCopperPath(netCopper(snapshot, arcs, partnerNet!), pEnds.from, pEnds.to);
		if (!pBefore) return refuse('invalid', 'NOT_CONNECTED', `The copper of "${partnerNet}" does not join ${pEnds.labels[0]} and ${pEnds.labels[1]}.`);
		if (!pBefore.trackIds.includes(String(partner.line.primitiveId))) return refuse('invalid', 'LEG_NOT_ON_PATH', `Partner track ${partner.line.primitiveId} is not on the ${partnerNet} path.`);
		tuned.push({ net: partnerNet!, legId: String(partner.line.primitiveId), layer, width: Number(partner.line.lineWidth ?? width), legLength: dist(partner.a, partner.b), path: [], before: pBefore.length, reached: pBefore.reachedPads, ends: pEnds });
	}

	// Target.
	let target: number | undefined, delta: number, targetSource: string;
	const measureNet = (other: string, between: any) => {
		const e = resolveEnds(between, other, snapshot);
		if (typeof e === 'string') return e;
		return shortestCopperPath(netCopper(snapshot, arcs, other), e.from, e.to)?.length ?? `the copper of "${other}" does not join ${e.labels[0]} and ${e.labels[1]}`;
	};
	if (params.addLength != null) { delta = Number(params.addLength) * k; targetSource = 'addLength'; }
	else if (params.targetLength != null) { target = Number(params.targetLength) * k; delta = target - before.length; targetSource = 'targetLength'; }
	else if (params.matchNet || params.matchPartner) {
		const other = params.matchNet ? String(params.matchNet) : partnerNet!;
		const m = measureNet(other, params.matchNet ? params.matchBetween : params.partnerBetween);
		if (typeof m === 'string') return refuse('invalid', 'MATCH_UNMEASURABLE', `${m}.`);
		target = m; delta = m - before.length; targetSource = `path length of ${other}`;
	} else return refuse('invalid', 'TARGET_REQUIRED', 'Pass addLength, targetLength, matchNet or matchPartner:true.');
	if (!Number.isFinite(delta)) return refuse('invalid', 'TARGET_REQUIRED', 'The target is not a number.');
	const head = {
		units, dryRun, net, track: leg.primitiveId,
		partner: tuned[1] ? { net: tuned[1].net, track: tuned[1].legId, before: u(tuned[1].before) } : undefined,
		endpoints: ends.labels, before: u(before.length), target: target != null ? u(target) : undefined, targetSource, delta: u(delta),
	};
	if (delta < -tol) return refuse('invalid', 'ALREADY_LONGER', `"${net}" is already ${u(-delta)} longer than the target; tuning only adds length (shorten another leg or tune the other net).`, head);
	if (delta <= tol) return { status: 'already-met', ...head, issues: issues.length ? issues : undefined, created: [] };

	// Geometry limits.
	const rules = await fetchDrcRules().catch(() => undefined);
	const resolver = clearanceResolverFromRules(rules?.ruleConfig, rules?.netRules, partnerNet ? [net, partnerNet] : [net]);
	const explicitClr = params.clearanceMil != null && params.clearanceMil !== '' ? Number(params.clearanceMil) : undefined;
	const clearance = explicitClr ?? resolver.for(net).clearanceMil;
	// A single-net tune beside its pair partner: the partner leg is checked here with DRC
	// semantics (gap == clearance is legal) — the shared preflight flags gap <= clearance.
	const besidePartner = !coupled && partner ? { line: partner.line, a: partner.a, b: partner.b, required: explicitClr ?? resolver.between(net, partnerNet, 'track').clearanceMil } : undefined;
	const spacing = Number(params.spacing) > 0 ? Number(params.spacing) * k : Math.max(3 * width, clearance);
	const pairPitch = coupled && partner ? Math.abs(partner.h) : 0;
	const wMax = Math.max(...tuned.map((t) => t.width));
	const pitch = coupled ? pairPitch + wMax + spacing : width + spacing;
	const miter = params.miter != null ? Math.max(0, Number(params.miter) * k) : pitch / 4;
	const capMax = Number(params.maxAmplitude) > 0 ? Number(params.maxAmplitude) * k : 5 * pitch;
	const minAmplitude = Number(params.minAmplitude) > 0 ? Number(params.minAmplitude) * k : 1.5 * wMax;
	const margin = params.margin != null && Number(params.margin) >= 0 ? Number(params.margin) * k : Math.max(2 * wMax, spacing);
	const lo = (coupled && partner ? partner.lo : 0) + margin, hi = (coupled && partner ? partner.hi : L) - margin;
	const usable = hi - lo;
	const limits = { spacing: u(spacing), pitch: u(pitch), miter: u(miter), maxAmplitude: u(capMax), minAmplitude: u(minAmplitude), margin: u(margin), usable: u(Math.max(0, usable)), clearance: u(clearance) };

	const preferred: 1 | -1 = !coupled && partner ? (partner.h > 0 ? -1 : 1) : 1;
	const sides: Array<1 | -1> = params.side === 'left' ? [1] : params.side === 'right' ? [-1] : [preferred, (-preferred) as 1 | -1];
	const caps = [...new Set([1, 0.7, 0.5, 0.35, 0.25].map((f) => capMax * f).filter((c) => c >= minAmplitude - 1e-9))];
	if (!caps.length) caps.push(capMax);
	const attempts: any[] = [];
	const candidates: Candidate[] = [];
	const removeIds = new Set(tuned.map((t) => t.legId));
	for (const cap of caps) {
		const sol = solveMeander(delta, { cap, minAmplitude, pitch, miter, usable, minMiter: coupled ? pairPitch * T225 / Math.SQRT2 * 1.02 : undefined });
		if ('reason' in sol) {
			attempts.push({ amplitudeCap: u(cap), outcome: sol.reason, bumpsThatFit: sol.bumpsThatFit, maxByLength: u(sol.maxByLength) });
			if (sol.reason === 'too-small') break;
			continue;
		}
		for (const side of sides) {
			const cand = buildCandidate(sol, side, cap);
			if (cand.reject) { attempts.push({ amplitudeCap: u(cap), side: side > 0 ? 'left' : 'right', bumps: sol.bumps, amplitude: u(sol.amplitude), outcome: cand.reject }); continue; }
			candidates.push(cand);
		}
	}

	function buildCandidate(sol: MeanderSolution, side: 1 | -1, cap: number): Candidate {
		const local = meanderLocal(sol, pitch, lo, hi);
		const hdir = mul(n, side);
		const cand: Candidate = { side, cap, sol, nets: [] };
		if (!coupled) {
			const W = (t: number, h: number) => add(add(A0, mul(ax, t)), mul(hdir, h));
			const path = cleanPolyline([A0, ...local.map((p) => W(p.t, p.h)), B0]);
			cand.nets.push({ ...tuned[0], path, added: polylineLength(path) - L });
			if (besidePartner) {
				const half = (width + Number(besidePartner.line.lineWidth ?? width)) / 2;
				const g = Math.min(...path.slice(1).map((p, i) => segmentDistance(path[i], p, besidePartner.a, besidePartner.b) - half));
				if (g < besidePartner.required - 1e-6) return { ...cand, reject: `blocked by ${partnerNet} leg ${besidePartner.line.primitiveId} (gap ${u(g)} < ${u(besidePartner.required)})` };
			}
		} else {
			const hm = partner!.h / 2;
			const Om = add(A0, mul(n, hm));
			const W = (t: number, h: number) => add(add(Om, mul(ax, t)), mul(hdir, h));
			const center = [W(partner!.lo, 0), ...local.map((p) => W(p.t, p.h)), W(partner!.hi, 0)];
			const offT = offsetPolyline(center, -hm), offP = offsetPolyline(center, hm);
			if (offT.degenerate != null || offP.degenerate != null) return { ...cand, reject: 'offset-degenerate (bump too tight for the pair pitch; raise spacing or miter)' };
			const pEnds = [partner!.a, partner!.b].sort((x, y) => along(x) - along(y));
			const tPath = cleanPolyline([A0, ...offT.points, B0]);
			const pPath = cleanPolyline([pEnds[0], ...offP.points, pEnds[1]]);
			cand.nets.push({ ...tuned[0], path: tPath, added: polylineLength(tPath) - L });
			cand.nets.push({ ...tuned[1], path: pPath, added: polylineLength(pPath) - tuned[1].legLength });
			const g = pairGaps(tPath, pPath, layer, wMax, 0);
			if (g.track < pairPitch - wMax - 1e-3) return { ...cand, reject: `pair gap shrinks to ${u(g.track)}` };
		}
		if (Math.abs(cand.nets[0].added - delta) > tol) return { ...cand, reject: `geometry adds ${u(cand.nets[0].added)}, not ${u(delta)}` };
		// Predict the path length on the edited board: catches same-net copper and touching runs.
		const addSegs = cand.nets.flatMap((nn) => nn.path.slice(1).map((p, i) => ({ id: `new:${nn.net}:${i}`, net: nn.net, layer, startX: nn.path[i].x, startY: nn.path[i].y, endX: p.x, endY: p.y, lineWidth: nn.width })));
		for (const nn of cand.nets) {
			const after = shortestCopperPath(netCopper(snapshot, arcs, nn.net, { remove: removeIds, add: addSegs }), nn.ends.from, nn.ends.to);
			nn.predicted = after?.length;
			if (!after) return { ...cand, reject: `${nn.net} would be disconnected` };
			const lost = nn.reached.filter((pad) => !after.reachedPads.includes(pad));
			if (lost.length) return { ...cand, reject: `${nn.net} would cut off ${lost.slice(0, 4).join(', ')} (copper branches off the leg)` };
			if (Math.abs(after.length - nn.before - nn.added) > tol) return { ...cand, reject: `shortcut: ${nn.net} would gain only ${u(after.length - nn.before)} of ${u(nn.added)} (the meander touches its own or other ${nn.net} copper)` };
		}
		return cand;
	}

	const routeOf = (c: Candidate) => c.nets.map((nn) => ({
		net: nn.net, width: nn.width / k, layer,
		from: { x: nn.path[0].x / k, y: nn.path[0].y / k, layer },
		to: { x: nn.path[nn.path.length - 1].x / k, y: nn.path[nn.path.length - 1].y / k, layer },
		points: nn.path.slice(1, -1).map((p) => ({ x: p.x / k, y: p.y / k })),
	}));
	const preflight = (list: Candidate[], maxObstacles: number) => routePath({
		units, dryRun: true, snap: ROUTE_SNAP, routes: list.flatMap(routeOf), ignorePrimitiveIds: [...removeIds, ...(besidePartner ? [String(besidePartner.line.primitiveId)] : []), ...(params.ignorePrimitiveIds ?? [])],
		clearanceMil: params.clearanceMil, maxObstacles, allowAnyAngle: offAngle || undefined,
	});
	const routeIndex: number[] = candidates.flatMap((c, ci) => c.nets.map(() => ci));
	let chosen: Candidate | undefined, confirm: any;
	if (candidates.length) {
		const batch = await preflight(candidates, 1000);
		if (batch.status === 'invalid') return refuse('invalid', 'PREFLIGHT_INVALID', 'route-path refused the meander geometry.', { ...head, limits, preflight: batch.routes?.flatMap((r: any) => r.issues ?? []).slice(0, 5) });
		const truncated = (batch.obstacles?.blocking?.length ?? 0) + (batch.obstacles?.warnings?.length ?? 0) >= 1000;
		const blockedBy = new Map<number, any>();
		for (const b of batch.obstacles?.blocking ?? []) if (b.route != null && !blockedBy.has(routeIndex[b.route])) blockedBy.set(routeIndex[b.route], b);
		for (const [ci, c] of candidates.entries()) {
			if (blockedBy.has(ci) && !truncated) {
				const b = blockedBy.get(ci);
				attempts.push({ amplitudeCap: u(c.cap), side: c.side > 0 ? 'left' : 'right', bumps: c.sol.bumps, amplitude: u(c.sol.amplitude), outcome: 'blocked', blocker: { type: b.type, net: b.net, primitiveId: b.primitiveId, gap: b.gap, required: b.required, at: b.at } });
				continue;
			}
			const single = candidates.length === 1 && !truncated ? batch : await preflight([c], 200);
			if (single.status === 'dry-run') { chosen = c; confirm = single; break; }
			const b = single.obstacles?.blocking?.[0];
			attempts.push({ amplitudeCap: u(c.cap), side: c.side > 0 ? 'left' : 'right', bumps: c.sol.bumps, amplitude: u(c.sol.amplitude), outcome: single.status, blocker: b ? { type: b.type, net: b.net, primitiveId: b.primitiveId, gap: b.gap, required: b.required, at: b.at } : undefined });
		}
	}
	if (!chosen) {
		return refuse('insufficient-space', 'INSUFFICIENT_SPACE', `No meander on ${leg.primitiveId} adds ${u(delta)}: ${attempts.length ? 'every amplitude/side tried is too long for the leg, blocked, or would short its own copper' : 'the leg has no usable length'} (see attempts). Tune a longer leg, lower spacing/maxAmplitude limits, or split the delta across legs.`, { ...head, limits, attempts });
	}

	const plan = {
		side: chosen.side > 0 ? 'left' : 'right', bumps: chosen.sol.bumps, amplitude: u(chosen.sol.amplitude), miter: u(chosen.sol.miter),
		spacing: u(spacing), pitch: u(pitch), span: u(2 * chosen.sol.miter + pitch * (2 * chosen.sol.bumps - 1)),
	};
	const geometry = chosen.nets.map((nn) => ({ net: nn.net, replaces: nn.legId, points: nn.path.map((p) => [u(p.x), u(p.y)]), added: u(nn.added), predicted: nn.predicted != null ? u(nn.predicted) : undefined }));
	const base = { ...head, limits, plan, geometry, obstacles: confirm?.obstacles?.warnings?.length ? { warnings: confirm.obstacles.warnings } : undefined, clearance: confirm?.clearance, issues: issues.length ? issues : undefined };
	if (dryRun) return { status: 'dry-run', ...base, created: [], note: 'Plan is clear and its predicted path length is exact. Re-run with dryRun:false to commit (meander created, leg deleted, then measured).' };

	// Commit: create the meander(s), delete the leg(s) — one transaction.
	const ops: any[] = [];
	for (const nn of chosen.nets) {
		for (let i = 1; i < nn.path.length; i++) {
			ops.push({ index: ops.length, type: 'create_track', segment: { net: nn.net, layer, startX: nn.path[i - 1].x, startY: nn.path[i - 1].y, endX: nn.path[i].x, endY: nn.path[i].y, lineWidth: nn.width } });
		}
	}
	ops.push({ index: ops.length, type: 'delete', primitiveType: 'track', ids: [...removeIds] });
	const commit = await commitBatchOperations(ops, true);
	invalidateSnapshot();
	const created = commit.created.map((c) => ({ type: c.type, primitiveId: c.primitiveId }));
	if (commit.committed !== true) {
		if (commit.failedAt?.type === 'delete') {
			const undo = await removeTracks(created.map((c) => c.primitiveId));
			invalidateSnapshot();
			return { status: undo.ok ? 'rolled-back' : 'partial', ...base, created: undo.ok ? [] : created, failedAt: commit.failedAt, rollbackErrors: undo.errors.length ? undo.errors : undefined, note: undo.ok ? 'EasyEDA refused to delete the original leg (locked?); the meander was removed again.' : 'The leg could not be deleted and the meander could not be fully removed — the ids in `created` are on the board.' };
		}
		return { status: commit.rolledBack ? 'rolled-back' : 'partial', ...base, created: commit.rolledBack ? [] : created, failedAt: commit.failedAt, rollbackErrors: commit.rollbackErrors, note: commit.rolledBack ? 'EasyEDA refused part of the meander; everything this call created was removed and the leg is untouched.' : 'Rollback was incomplete — the ids in `created` are still on the board.' };
	}

	// Verify: the measured path must have grown by what the plan added.
	const after = await getSnapshot({ forceRefresh: true });
	const arcsAfter = await fetchArcsWithAngle();
	const measured = chosen.nets.map((nn) => {
		const p = shortestCopperPath(netCopper(after, arcsAfter, nn.net), nn.ends.from, nn.ends.to);
		const ok = !!p && Math.abs(p.length - nn.before - nn.added) <= tol;
		return { net: nn.net, before: u(nn.before), after: p ? u(p.length) : undefined, added: p ? u(p.length - nn.before) : undefined, expected: u(nn.added), ok, reason: ok ? undefined : p ? 'measured gain differs from the plan' : 'endpoints no longer connected' };
	});
	const verify = { mode: 'path-length', tolerance: u(tol), ok: measured.every((m) => m.ok), nets: measured };
	if (verify.ok) return { status: 'committed', ...base, created, deleted: [...removeIds], verify };
	const undo = await removeTracks(created.map((c) => c.primitiveId));
	const restored: Array<{ replaces: string; primitiveId?: string; error?: string }> = [];
	for (const nn of chosen.nets) {
		const orig = nn.legId === String(leg.primitiveId) ? leg : partner!.line;
		try {
			const made: any = await eda.pcb_PrimitiveLine.create(nn.net, normalizeLayer(layer), Number(orig.startX), Number(orig.startY), Number(orig.endX), Number(orig.endY), Number(orig.lineWidth ?? nn.width));
			restored.push({ replaces: nn.legId, primitiveId: made?.primitiveId ?? made?.getState_PrimitiveId?.() });
		} catch (e: any) { restored.push({ replaces: nn.legId, error: e?.message ?? String(e) }); }
	}
	invalidateSnapshot();
	const clean = undo.ok && restored.every((r) => !r.error);
	return {
		status: clean ? 'rolled-back' : 'partial', ...base, created: undo.ok ? [] : created, restored, verify,
		rollbackErrors: undo.errors.length ? undo.errors : undefined,
		note: clean ? 'Committed, but the measured path length did not grow as planned; the meander was removed and the original leg recreated (new id in `restored`).' : 'Verification failed and the rollback was incomplete — check `created` / `restored`.',
	};
}

async function removeTracks(ids: string[]): Promise<{ ok: boolean; errors: string[] }> {
	if (!ids.length) return { ok: true, errors: [] };
	try { await eda.pcb_PrimitiveLine.delete(ids); return { ok: true, errors: [] }; }
	catch (e: any) { return { ok: false, errors: [`tracks: ${e?.message ?? e}`] }; }
}

export const routePairHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.route.pair': routePair,
	'pcb.route.lengthTune': lengthTune,
};
