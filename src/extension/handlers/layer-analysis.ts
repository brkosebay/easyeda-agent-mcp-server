// Layer optimisation: what each copper layer carries, whether reference planes
// are intact under the signals that rely on them, heuristic recommendations,
// and guarded layer edits (copper count, inner layer type, moving tracks to
// another layer).
//
// Geometry conventions: tracks/vias/pads are canvas mil (Y negative below the
// origin). Pour polygon SOURCES are data space (Y positive down, possibly
// offset), so pours are mapped through pour-fill's resolveCanvasTransform and
// the mapping is sanity-checked against the board outline before any
// point-in-pour test (see readPourGeometry).
//
// Moving tracks uses in-place `modify(id, {layer})` rather than re-creating
// them: it keeps primitive ids and is exactly reversible, whereas a re-create
// needs a delete, which the SDK cannot undo.

import { didTimeOut, flattenState, flattenStateArray, normalizeLayer, readWithTimeout } from './_utils';
import { getSnapshot, invalidateSnapshot } from './board-context';
import { analyzeConnectivity, fetchArcs } from './net-connectivity';
import { readCopperSource, resolveNativePcbTab } from './native-copper';
import { ASSUMED_ZERO_ORIGIN_TRANSFORM, readPourSource, resolveCanvasTransform, type PolygonTransform } from './pour-fill';
import { checkTraceObstacles, fetchDrcRules, padToObstacle, pointInPolygon, pointToSegmentDistance, polygonHit, segmentDistance } from './trace-obstacles';
import { clearanceResolverFromRules, resolveViaSize } from '../../shared/drc-rules';
import { boundedNativeOperation as bounded } from '../native-operation-gate';

type Pt = { x: number; y: number };
type Box = { minX: number; minY: number; maxX: number; maxY: number };
type Ring = Pt[];

export interface LayerInfo { id: number; name: string; type: string; status?: number; locked?: boolean }
interface Seg { id: string; kind: 'track' | 'arc'; net?: string; layer: number; a: Pt; b: Pt; w: number; len: number }
interface PourGeo { id: string; net?: string; layer: number; name?: string; priority?: number; rings: Ring[]; box?: Box; area: number }
interface PlaneInfo { pour: PourGeo; net?: string; cuts: Seg[] }

const TOP = 1;
const BOTTOM = 2;
const MULTI = 12;
const EPS = 0.01;
const SAMPLE_STEP_MIL = 25;
const DEFAULT_CLEARANCE_MIL = 6;
const DOMINANT_POUR_FRACTION = 0.5;
/** An outer layer counts as a plane only when it carries at most this share of the board's track length. */
const OUTER_PLANE_MAX_TRACK_SHARE = 0.1;

const HIGH_SPEED = /(USB|^D[+-]$|_D[PMN+-]$|DP$|DM$|CLK|SCK|SCLK|XTAL|XIN|XOUT|OSC|ETH|RGMII|RMII|MDI|SDIO|QSPI|MIPI|HDMI|LVDS|PCIE|SATA|ANT|RF)/i;
/** Name heuristic; _P/_N count only when the partner net exists (RESET_N is not a pair). */
function isHighSpeed(net: string, nets: Set<string>): boolean {
	if (HIGH_SPEED.test(net)) return true;
	const m = /^(.*_)([PNpn])$/.exec(net);
	const partner: Record<string, string> = { P: 'N', N: 'P', p: 'n', n: 'p' };
	return !!m && nets.has(m[1] + partner[m[2]]);
}
const GROUND = /^(A|D|P|S|C)?GND|^VSS|EARTH|CHASSIS/i;
const POWER = /^(\+?\d+V\d*|VCC|VDD|VBUS|VBAT|VIN|VSYS|VREF|AVDD|DVDD|PWR|\d+V\d+)/i;

export const isCopperId = (id: number): boolean => id === TOP || id === BOTTOM || (id >= 15 && id <= 46);
const isInner = (id: number): boolean => id >= 15 && id <= 46;
const defaultName = (id: number): string => (id === TOP ? 'Top' : id === BOTTOM ? 'Bottom' : isInner(id) ? `Inner${id - 14}` : `L${id}`);
const stackRank = (id: number): number => (id === TOP ? 0 : id === BOTTOM ? 1000 : id);
const r0 = (n: number): number => Math.round(n);
const r1 = (n: number): number => Math.round(n * 10) / 10;
const pct = (part: number, whole: number): number => (whole > 0 ? r1((100 * part) / whole) : 0);

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** Active copper layers in physical stack order (Top, Inner1.., Bottom). Inner layers with layerStatus 0 are not part of the board. */
export function copperStack(rows: any[], seen: Iterable<number> = []): LayerInfo[] {
	const byId = new Map<number, LayerInfo>();
	for (const row of Array.isArray(rows) ? rows : []) {
		const id = Number(row?.id);
		if (!isCopperId(id)) continue;
		const status = row?.layerStatus == null ? undefined : Number(row.layerStatus);
		if (status === 0) continue;
		byId.set(id, { id, name: String(row?.name ?? defaultName(id)), type: String(row?.type ?? ''), status, locked: !!row?.locked });
	}
	const fallback = (id: number): LayerInfo => ({ id, name: defaultName(id), type: id === TOP ? 'TOP' : id === BOTTOM ? 'BOTTOM' : 'SIGNAL' });
	if (!byId.size) for (const id of seen) if (isCopperId(id) && !byId.has(id)) byId.set(id, fallback(id));
	for (const id of [TOP, BOTTOM]) if (!byId.has(id)) byId.set(id, fallback(id));
	return [...byId.values()].sort((a, b) => stackRank(a.id) - stackRank(b.id));
}

async function readLayerRows(): Promise<any[]> {
	const rows = await eda.pcb_Layer.getAllLayers().catch(() => []);
	return Array.isArray(rows) ? rows : [];
}

/** The host's own copper-layer count (alpha API) — undefined when unavailable. */
async function reportedCopperCount(): Promise<number | undefined> {
	const api = eda.pcb_Layer as any;
	if (typeof api.getTheNumberOfCopperLayers !== 'function') return undefined;
	const v = await readWithTimeout(() => api.getTheNumberOfCopperLayers(), 3_000).catch(() => undefined);
	if (v == null || didTimeOut(v)) return undefined;
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Resolve a layer reference: the board's own layer name ("L2_GND"), a numeric id, or an alias ("Inner1", "BottomLayer"). */
export function resolveLayerRef(input: any, stack: LayerInfo[]): number | undefined {
	if (input == null || input === '') return undefined;
	if (typeof input === 'string') {
		const key = input.trim().toLowerCase();
		const named = stack.find((l) => l.name.trim().toLowerCase() === key);
		if (named) return named.id;
	}
	const id = Number(normalizeLayer(input));
	return Number.isFinite(id) ? id : undefined;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

function boxOf(points: Pt[]): Box | undefined {
	if (!points.length) return undefined;
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
	return { minX, minY, maxX, maxY };
}

const boxArea = (b?: Box): number => (b ? Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY) : 0);

function overlapArea(a?: Box, b?: Box): number {
	if (!a || !b) return 0;
	return Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
}

function ringArea(ring: Ring): number {
	let s = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
	return Math.abs(s) / 2;
}

/** Even-odd across every ring, so complex-polygon holes count as outside. */
function inRings(p: Pt, rings: Ring[]): boolean {
	let inside = false;
	for (const ring of rings) if (ring.length >= 3 && pointInPolygon(p, ring)) inside = !inside;
	return inside;
}

function samples(s: Seg): Pt[] {
	const n = Math.min(200, Math.max(1, Math.ceil(s.len / SAMPLE_STEP_MIL)));
	const out: Pt[] = [];
	for (let i = 0; i <= n; i++) out.push({ x: s.a.x + ((s.b.x - s.a.x) * i) / n, y: s.a.y + ((s.b.y - s.a.y) * i) / n });
	return out;
}

/** Polygon source (data space) → rings of raw points. Arc bulges are approximated by their end points. */
function parseRings(src: any): Ring[] {
	if (!Array.isArray(src) || !src.length) return [];
	if (Array.isArray(src[0])) return src.flatMap(parseRings);
	const head = typeof src[0] === 'string' ? String(src[0]).toUpperCase() : undefined;
	if (head === 'R') {
		const [, x, y, w, h, rot] = src.map(Number);
		if (![x, y, w, h].every(Number.isFinite)) return [];
		let ring: Ring = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
		if (Number.isFinite(rot) && rot % 360 !== 0) {
			const c = { x: x + w / 2, y: y + h / 2 };
			const t = (rot * Math.PI) / 180;
			ring = ring.map((p) => ({ x: c.x + (p.x - c.x) * Math.cos(t) - (p.y - c.y) * Math.sin(t), y: c.y + (p.x - c.x) * Math.sin(t) + (p.y - c.y) * Math.cos(t) }));
		}
		return [ring];
	}
	if (head === 'CIRCLE') {
		const [, cx, cy, r] = src.map(Number);
		if (![cx, cy, r].every(Number.isFinite)) return [];
		return [Array.from({ length: 24 }, (_, i) => ({ x: cx + r * Math.cos((i * Math.PI) / 12), y: cy + r * Math.sin((i * Math.PI) / 12) }))];
	}
	const pts: Pt[] = [];
	let cmd = head ?? 'L';
	let i = head ? 1 : 0;
	while (i < src.length) {
		const v = src[i];
		if (typeof v === 'string') { cmd = v.toUpperCase(); i++; continue; }
		if (cmd === 'ARC' || cmd === 'CARC') { pushPoint(pts, src[i + 1], src[i + 2]); i += 3; continue; }
		pushPoint(pts, src[i], src[i + 1]);
		i += 2;
	}
	return pts.length >= 3 ? [pts] : [];
}

function pushPoint(pts: Pt[], x: unknown, y: unknown): void {
	const nx = Number(x), ny = Number(y);
	if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(nx) && Number.isFinite(ny)) pts.push({ x: nx, y: ny });
}

const IDENTITY: PolygonTransform = { coordinateSpace: 'data-space-untransformed', resolved: false, x: (v) => v, y: (v) => v };

/**
 * Pour polygons in canvas space. The runtime affine is preferred; when it
 * cannot be read (or lands the pours off the board) the Y-flip and raw
 * candidates are tried and the one overlapping the board most wins.
 */
async function readPourGeometry(reference?: Box): Promise<{ pours: PourGeo[]; space: string }> {
	const raw = await eda.pcb_PrimitivePour.getAll(undefined, undefined, undefined).catch(() => []);
	const items = (Array.isArray(raw) ? raw : []).map((p: any) => {
		const flat = flattenState(p) ?? {};
		return { flat, rings: parseRings(readPourSource(p) ?? readPourSource(flat)) };
	});
	const resolved = await resolveCanvasTransform().catch(() => IDENTITY);
	const candidates: Array<[string, PolygonTransform]> = resolved.resolved
		? [['canvas', resolved]]
		: [['assumed-y-flip', ASSUMED_ZERO_ORIGIN_TRANSFORM], ['raw', IDENTITY]];
	const map = (t: PolygonTransform) => items.map(({ flat, rings }) => {
		const mapped = rings.map((ring) => ring.map((p) => ({ x: t.x(p.x), y: t.y(p.y) })));
		const areas = mapped.map(ringArea).sort((a, b) => b - a);
		const area = areas.length ? Math.max(0, areas[0] - areas.slice(1).reduce((s, a) => s + a, 0)) : 0;
		const layer = Number(normalizeLayerSafe(flat.layer));
		return {
			id: String(flat.primitiveId ?? flat.id ?? ''),
			net: flat.net ? String(flat.net) : undefined,
			layer,
			name: flat.pourName ? String(flat.pourName) : undefined,
			priority: Number.isFinite(Number(flat.pourPriority)) ? Number(flat.pourPriority) : undefined,
			rings: mapped,
			box: boxOf(mapped.flat()),
			area,
		} as PourGeo;
	});
	let best = { space: candidates[0][0], pours: map(candidates[0][1]), score: -1 };
	if (reference && candidates.length > 1) {
		for (const [space, t] of candidates) {
			const pours = map(t);
			const score = pours.reduce((s, p) => s + overlapArea(p.box, reference), 0);
			if (score > best.score) best = { space, pours, score };
		}
	}
	return { pours: best.pours.filter((p) => isCopperId(p.layer)), space: best.space };
}

function normalizeLayerSafe(v: any): any {
	try { return normalizeLayer(v); } catch { return v; }
}

function toSeg(l: any, kind: 'track' | 'arc'): Seg | undefined {
	const a = { x: Number(l.startX), y: Number(l.startY) };
	const b = { x: Number(l.endX), y: Number(l.endY) };
	const layer = Number(normalizeLayerSafe(l.layer));
	if (![a.x, a.y, b.x, b.y].every(Number.isFinite) || !isCopperId(layer)) return undefined;
	const w = Number(l.lineWidth);
	return { id: String(l.primitiveId ?? ''), kind, net: l.net ? String(l.net) : undefined, layer, a, b, w: Number.isFinite(w) && w > 0 ? w : 10, len: dist(a, b) };
}

const segTouchesSeg = (p: Seg, q: Seg, gap = 0): boolean => segmentDistance(p.a, p.b, q.a, q.b) <= (p.w + q.w) / 2 + gap + EPS;

async function boardClearanceMil(): Promise<number> {
	try {
		const { ruleConfig, netRules } = await fetchDrcRules();
		const c = clearanceResolverFromRules(ruleConfig, netRules).summary.clearanceMil;
		return Number.isFinite(c) && c > 0 ? c : DEFAULT_CLEARANCE_MIL;
	} catch { return DEFAULT_CLEARANCE_MIL; }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface Rec { code: string; sev: 'high' | 'medium' | 'low' | 'info'; conf: 'high' | 'medium' | 'low'; msg: string; why: string; fix?: string }

async function readIslands(documentUuid: string | undefined, enabled: boolean): Promise<{ byPour?: Map<string, { islands: number }>; reason?: string }> {
	if (!enabled) return { reason: 'skipped (nativeCopper:false)' };
	try {
		const { tab, error } = await resolveNativePcbTab(documentUuid);
		if (!tab) return { reason: error ?? 'editor not reachable' };
		const res = await readCopperSource(tab);
		if ('error' in res) return { reason: res.error };
		return { byPour: res.byPour };
	} catch (e: any) {
		return { reason: String(e?.message ?? e) };
	}
}

export async function buildLayerReport(params: Record<string, any> = {}): Promise<any> {
	const detail: 'summary' | 'nets' | 'full' = params.detail === 'nets' || params.detail === 'full' ? params.detail : 'summary';
	const netFilter: string[] | undefined = Array.isArray(params.nets) && params.nets.length ? params.nets.map(String) : undefined;
	const maxNets = Math.max(1, Math.min(500, Math.floor(Number(params.maxNets ?? 20)) || 20));

	const snapshot = await getSnapshot({ forceRefresh: params.forceRefresh === true });
	const arcs = await fetchArcs().catch(() => []);
	const segs = [
		...snapshot.lines.map((l: any) => toSeg(l, 'track')),
		...arcs.map((a: any) => toSeg(a, 'arc')),
	].filter((s): s is Seg => !!s);

	const seen = new Set<number>(segs.map((s) => s.layer));
	const stack = copperStack(snapshot.layers, seen);
	const activeIds = new Set(stack.map((l) => l.id));
	const reported = await reportedCopperCount();
	const boardBox: Box | undefined = snapshot.boardOutline?.bounds ?? snapshot.bounds;
	const boardArea = boxArea(boardBox);
	const [{ pours, space }, clearance, islands] = await Promise.all([
		readPourGeometry(boardBox),
		boardClearanceMil(),
		readIslands(snapshot.document?.uuid, params.nativeCopper !== false),
	]);

	const activeSegs = segs.filter((s) => activeIds.has(s.layer));
	const inactiveSegs = segs.filter((s) => !activeIds.has(s.layer));
	const totalLen = activeSegs.reduce((s, x) => s + x.len, 0);
	const vias = snapshot.vias.filter((v: any) => Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y)));
	const allPads = dedupePads([...snapshot.componentPads, ...snapshot.standalonePads]);
	const padCount = new Map<string, number>();
	for (const p of allPads) if (p?.net) padCount.set(String(p.net), (padCount.get(String(p.net)) ?? 0) + 1);
	const pourNets = new Set(pours.map((p) => p.net).filter((n): n is string => !!n));

	// segments indexed by net → layer
	const byNetLayer = new Map<string, Map<number, Seg[]>>();
	for (const s of activeSegs) {
		if (!s.net) continue;
		const m = byNetLayer.get(s.net) ?? new Map<number, Seg[]>();
		m.set(s.layer, [...(m.get(s.layer) ?? []), s]);
		byNetLayer.set(s.net, m);
	}

	// --- layer stats + roles -------------------------------------------------
	const stats = new Map<number, { tracks: number; arcs: number; len: number; area: number; nets: Map<string, number>; viaTransitions: number }>();
	for (const l of stack) stats.set(l.id, { tracks: 0, arcs: 0, len: 0, area: 0, nets: new Map(), viaTransitions: 0 });
	for (const s of activeSegs) {
		const st = stats.get(s.layer)!;
		if (s.kind === 'arc') st.arcs++; else st.tracks++;
		st.len += s.len;
		st.area += s.len * s.w;
		if (s.net) st.nets.set(s.net, (st.nets.get(s.net) ?? 0) + s.len);
	}

	// vias: which layers each via actually joins
	const netVias = new Map<string, { vias: number; transitions: number; stubs: string[] }>();
	for (const v of vias) {
		const net = v.net ? String(v.net) : undefined;
		const c = { x: Number(v.x), y: Number(v.y) };
		const r = Number(v.diameter ?? 24) / 2;
		const touched = new Set<number>();
		for (const [layer, list] of byNetLayer.get(net ?? '') ?? []) {
			if (list.some((s) => pointToSegmentDistance(c, s.a, s.b) <= r + s.w / 2 + EPS)) touched.add(layer);
		}
		if (touched.size >= 2) for (const layer of touched) stats.get(layer)!.viaTransitions++;
		if (!net) continue;
		const nv = netVias.get(net) ?? { vias: 0, transitions: 0, stubs: [] };
		nv.vias++;
		if (touched.size >= 2) nv.transitions++;
		else if (!pourNets.has(net) && !padAt(c, r, net, allPads)) nv.stubs.push(String(v.primitiveId ?? ''));
		netVias.set(net, nv);
	}

	const planeOf = new Map<number, PlaneInfo>();
	const role = new Map<number, string>();
	for (const l of stack) {
		const st = stats.get(l.id)!;
		const layerPours = pours.filter((p) => p.layer === l.id).sort((a, b) => b.area - a.area);
		const big = layerPours[0];
		const dominant = big && (boardArea > 0 ? big.area >= DOMINANT_POUR_FRACTION * boardArea : big.area > 0) ? big : undefined;
		if (dominant) {
			const cuts = activeSegs.filter((s) => s.layer === l.id && s.net !== dominant.net && samples(s).some((p) => inRings(p, dominant.rings)));
			planeOf.set(l.id, { pour: dominant, net: dominant.net, cuts });
		}
		const outer = l.id === TOP || l.id === BOTTOM;
		const light = st.len <= OUTER_PLANE_MAX_TRACK_SHARE * totalLen;
		let r: string;
		if (!st.tracks && !st.arcs && !layerPours.length) r = 'unused';
		else if (l.type.toUpperCase() === 'PLANE') r = 'plane';
		else if (dominant && !outer) r = 'plane';
		// An outer flood is THE reference only on a 2-layer board; with inner
		// planes it is shielding/thermal copper, so its cuts are not analysed.
		else if (dominant && light) r = stack.length <= 2 ? 'plane' : 'flood';
		else if (dominant) r = 'signal+flood';
		else r = 'signal';
		role.set(l.id, r);
	}

	// --- per layer output ----------------------------------------------------
	const layerName = new Map<number, string>(stack.map((l): [number, string] => [l.id, l.name]));
	const nameOf = (id: number) => layerName.get(id) ?? defaultName(id);
	const layersOut = stack.map((l) => {
		const st = stats.get(l.id)!;
		const layerPours = pours.filter((p) => p.layer === l.id).sort((a, b) => b.area - a.area);
		const out: any = {
			id: l.id,
			name: l.name,
			type: l.type || undefined,
			role: role.get(l.id),
			tracks: st.tracks,
			...(st.arcs ? { arcs: st.arcs } : {}),
			lenMil: r0(st.len),
			nets: st.nets.size,
			viaTransitions: st.viaTransitions,
			pourPct: Math.min(100, pct(layerPours.reduce((s, p) => s + p.area, 0), boardArea)),
			tracePct: pct(st.area, boardArea),
			pours: layerPours.map((p) => ({
				id: p.id, net: p.net, name: p.name, prio: p.priority, areaPct: pct(p.area, boardArea),
				...(islands.byPour ? { islands: islands.byPour.get(p.id)?.islands ?? 0 } : {}),
			})),
		};
		if (detail === 'full') out.netLen = Object.fromEntries([...st.nets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([n, len]) => [n, r0(len)]));
		const plane = planeOf.get(l.id);
		if (plane && role.get(l.id) === 'plane') out.plane = planeIntegrity(plane, vias, clearance, islands.byPour, detail);
		return out;
	});

	// --- per net -------------------------------------------------------------
	const stackIndex = new Map<number, number>(stack.map((l, i): [number, number] => [l.id, i]));
	const planeNets = new Set([...planeOf.values()].map((p) => p.net).filter((n): n is string => !!n));
	const allNets = new Set<string>(snapshot.nets);
	const netRows: any[] = [];
	for (const [net, perLayer] of byNetLayer) {
		if (netFilter && !netFilter.includes(net)) continue;
		if (!netFilter && planeNets.has(net)) continue;
		const len: Record<string, number> = {};
		const refs: any[] = [];
		let total = 0;
		let unreferenced = 0;
		let inPlane = 0;
		for (const [layer, list] of [...perLayer.entries()].sort((a, b) => stackRank(a[0]) - stackRank(b[0]))) {
			const layerLen = list.reduce((s, x) => s + x.len, 0);
			len[nameOf(layer)] = r0(layerLen);
			total += layerLen;
			// Routed inside another net's plane: already a PLANE_CUT finding.
			if (role.get(layer) === 'plane' && planeOf.get(layer)?.net !== net) { inPlane += layerLen; continue; }
			const idx = stackIndex.get(layer) ?? -1;
			const neighbours = [stack[idx - 1], stack[idx + 1]].filter((x): x is LayerInfo => !!x && planeOf.has(x.id));
			if (!neighbours.length) { unreferenced += layerLen; continue; }
			for (const ref of neighbours) {
				const plane = planeOf.get(ref.id)!;
				const pts = list.flatMap(samples);
				const covered = pts.filter((p) => inRings(p, plane.pour.rings)).length;
				const by = new Set<string>();
				let cross = 0;
				for (const s of list) for (const c of plane.cuts) {
					if (c.net === net) continue;
					if (segTouchesSeg(s, c)) { cross++; if (c.net) by.add(c.net); }
				}
				refs.push({ on: nameOf(layer), ref: ref.name, refNet: plane.net, cov: pct(covered, pts.length), cross, ...(by.size ? { by: [...by].slice(0, 6) } : {}) });
			}
		}
		const nv = netVias.get(net);
		netRows.push({
			net,
			pads: padCount.get(net) ?? 0,
			vias: nv?.vias ?? 0,
			lenMil: r0(total),
			len,
			...(isHighSpeed(net, allNets) ? { hs: true } : {}),
			...(unreferenced > 0 ? { noRefMil: r0(unreferenced) } : {}),
			...(inPlane > 0 ? { inPlaneMil: r0(inPlane) } : {}),
			ref: refs,
		});
	}
	const netIssue = (n: any) => n.ref.some((r: any) => r.cross > 0 || r.cov < 90) || (n.hs && n.noRefMil > 0);

	// --- recommendations -----------------------------------------------------
	const recs = recommendations({
		stack, role, stats, planeOf, netRows, netVias, padCount, pourNets, totalLen, boardArea, clearance, layerOut: layersOut, nameOf, allPadCount: allPads.length,
	});

	const nets = netFilter || detail !== 'summary'
		? netRows.sort((a, b) => b.lenMil - a.lenMil).slice(0, netFilter ? netFilter.length : maxNets)
		: undefined;
	const issues = netRows.filter(netIssue).sort((a, b) => Number(!!b.hs) - Number(!!a.hs) || b.lenMil - a.lenMil);
	return {
		board: {
			copperLayers: stack.length,
			...(reported != null && reported !== stack.length ? { hostReportedCopperLayers: reported } : {}),
			stack: stack.map((l) => `${l.name}:${role.get(l.id)}`),
			sizeMil: boardBox ? [r0(boardBox.maxX - boardBox.minX), r0(boardBox.maxY - boardBox.minY)] : undefined,
			areaIn2: r1(boardArea / 1e6),
			pads: allPads.length,
			padsPerIn2: boardArea > 0 ? r1(allPads.length / (boardArea / 1e6)) : undefined,
			tracks: activeSegs.length,
			lenMil: r0(totalLen),
			vias: vias.length,
			clearanceMil: clearance,
			pourSpace: space,
			...(inactiveSegs.length ? { inactiveLayerTracks: inactiveSegs.length } : {}),
		},
		layers: layersOut,
		...(nets ? { nets } : {}),
		netIssues: issues.slice(0, maxNets).map((n) => ({ net: n.net, ...(n.hs ? { hs: true } : {}), lenMil: n.lenMil, ref: n.ref.filter((r: any) => r.cross > 0 || r.cov < 90), ...(n.noRefMil ? { noRefMil: n.noRefMil } : {}) })),
		...(issues.length > maxNets ? { netIssuesTotal: issues.length } : {}),
		recommendations: recs,
		copperIslands: islands.byPour ? { available: true } : { available: false, reason: islands.reason },
		notes: [
			'Recommendations are heuristics (sev/conf), not rules — verify before acting.',
			'Areas are pour OUTLINES (board bbox for the board), not poured copper; ref = adjacent copper layer with a pour covering >=50% of the board; cov = % of the route over that pour; cross = cutting tracks of other nets under the route.',
			'hs = net name looks high-speed/clock/RF (name heuristic only).',
		],
	};
}

function dedupePads(pads: any[]): any[] {
	const seen = new Set<string>();
	return pads.filter((p) => {
		const key = p?.primitiveId ? String(p.primitiveId) : `${p?.x},${p?.y},${p?.net}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function padAt(c: Pt, r: number, net: string, pads: any[]): boolean {
	for (const pad of pads) {
		if (String(pad?.net ?? '') !== net) continue;
		const o = padToObstacle(pad, 'pad');
		if (o && polygonHit(c, c, o.polygon, o.bounds, r, EPS)) return true;
	}
	return false;
}

function planeIntegrity(plane: PlaneInfo, vias: any[], clearance: number, islands: Map<string, { islands: number }> | undefined, detail: string): any {
	const byNet = new Map<string, { tracks: number; len: number; ids: string[] }>();
	for (const c of plane.cuts) {
		const key = c.net ?? '(no net)';
		const e = byNet.get(key) ?? { tracks: 0, len: 0, ids: [] };
		e.tracks++;
		e.len += c.len;
		e.ids.push(c.id);
		byNet.set(key, e);
	}
	// Antipads: other-net vias inside the plane. Chains of cuts + antipads
	// closer than two clearances leave no copper between them: a wall.
	const antipadVias = vias.filter((v) => String(v.net ?? '') !== String(plane.net ?? '') && inRings({ x: Number(v.x), y: Number(v.y) }, plane.pour.rings));
	const walls: Seg[] = [
		...plane.cuts,
		...antipadVias.map((v): Seg => ({ id: String(v.primitiveId ?? ''), kind: 'track', net: v.net, layer: plane.pour.layer, a: { x: Number(v.x), y: Number(v.y) }, b: { x: Number(v.x), y: Number(v.y) }, w: Number(v.diameter ?? 24), len: 0 })),
	];
	const parent = walls.map((_, i) => i);
	const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
	const reach = walls.map((s) => {
		const m = s.w / 2 + clearance;
		return { minX: Math.min(s.a.x, s.b.x) - m, minY: Math.min(s.a.y, s.b.y) - m, maxX: Math.max(s.a.x, s.b.x) + m, maxY: Math.max(s.a.y, s.b.y) + m };
	});
	for (let i = 0; i < walls.length; i++) for (let j = i + 1; j < walls.length; j++) {
		const p = reach[i], q = reach[j];
		if (p.maxX < q.minX || q.maxX < p.minX || p.maxY < q.minY || q.maxY < p.minY) continue;
		if (find(i) !== find(j) && segTouchesSeg(walls[i], walls[j], 2 * clearance)) parent[find(i)] = find(j);
	}
	const chains = new Map<number, Seg[]>();
	walls.forEach((w, i) => chains.set(find(i), [...(chains.get(find(i)) ?? []), w]));
	let longest = 0;
	let likelySplit = false;
	const pb = plane.pour.box;
	const tol = 2 * clearance + 25;
	for (const chain of chains.values()) {
		if (!chain.some((s) => s.len > 0)) continue; // via-only clusters are reported as antipads
		const box = boxOf(chain.flatMap((s) => [
			{ x: Math.min(s.a.x, s.b.x) - s.w / 2, y: Math.min(s.a.y, s.b.y) - s.w / 2 },
			{ x: Math.max(s.a.x, s.b.x) + s.w / 2, y: Math.max(s.a.y, s.b.y) + s.w / 2 },
		]))!;
		longest = Math.max(longest, box.maxX - box.minX, box.maxY - box.minY);
		if (pb && ((box.minX - pb.minX <= tol && pb.maxX - box.maxX <= tol) || (box.minY - pb.minY <= tol && pb.maxY - box.maxY <= tol))) likelySplit = true;
	}
	const islandCount = islands?.get(plane.pour.id)?.islands;
	return {
		net: plane.net,
		pour: plane.pour.id,
		cutTracks: plane.cuts.length,
		cutLenMil: r0(plane.cuts.reduce((s, c) => s + c.len, 0)),
		cutNets: [...byNet.entries()].sort((a, b) => b[1].len - a[1].len).slice(0, detail === 'summary' ? 6 : 50)
			.map(([net, e]) => ({ net, tracks: e.tracks, lenMil: r0(e.len), ...(detail === 'full' ? { ids: e.ids.slice(0, 20) } : {}) })),
		antipads: antipadVias.length,
		longestCutMil: r0(longest),
		likelySplit: likelySplit || (islandCount != null && islandCount > 1),
		...(islandCount != null ? { islands: islandCount } : {}),
	};
}

function recommendations(ctx: {
	stack: LayerInfo[]; role: Map<number, string>; stats: Map<number, any>; planeOf: Map<number, PlaneInfo>; netRows: any[];
	netVias: Map<string, { vias: number; transitions: number; stubs: string[] }>; padCount: Map<string, number>; pourNets: Set<string>;
	totalLen: number; boardArea: number; clearance: number; layerOut: any[]; nameOf: (id: number) => string; allPadCount: number;
}): Rec[] {
	const { stack, role, stats, planeOf, netRows, netVias, padCount, pourNets, totalLen, boardArea, clearance, nameOf } = ctx;
	const recs: Rec[] = [];
	const n = stack.length;
	const idx = (id: number) => stack.findIndex((l) => l.id === id);
	// Where a plane's intruders should go: the nearest signal layer, else the nearest other outer layer.
	const moveTarget = (id: number): LayerInfo => {
		const i = idx(id);
		const byDistance = stack.filter((l) => l.id !== id).sort((a, b) => Math.abs(idx(a.id) - i) - Math.abs(idx(b.id) - i));
		return byDistance.find((l) => role.get(l.id) === 'signal' || role.get(l.id) === 'signal+flood')
			?? byDistance.find((l) => l.id === TOP || l.id === BOTTOM)
			?? byDistance[0];
	};

	// 1. Plane cuts
	for (const [id, plane] of planeOf) {
		if (role.get(id) !== 'plane' || !plane.cuts.length) continue;
		const byNet = new Map<string, number>();
		for (const c of plane.cuts) byNet.set(c.net ?? '(no net)', (byNet.get(c.net ?? '(no net)') ?? 0) + c.len);
		const top = [...byNet.entries()].sort((a, b) => b[1] - a[1]);
		const target = moveTarget(id);
		const ground = GROUND.test(plane.net ?? '');
		recs.push({
			code: 'PLANE_CUT',
			sev: ground ? 'high' : 'medium',
			conf: 'high',
			msg: `${nameOf(id)} is a ${plane.net ?? '?'} reference plane but ${plane.cuts.length} track(s) of ${top.length} other net(s) run through it (${r0(top.reduce((s, x) => s + x[1], 0))} mil): ${top.slice(0, 6).map(([k, v]) => `${k} ${r0(v)}`).join(', ')}.`,
			why: 'Each track in a plane opens a slot; return currents of signals on the adjacent layer detour around it (loop area, EMI, crosstalk).',
			fix: `Move them off the plane, e.g. pcb_move_tracks_to_layer {net:"${top[0][0]}", fromLayer:${id}, toLayer:${target.id}} (dry-run first; pad layers and obstacles are checked).`,
		});
	}

	// 2. References under signals
	const crossing = netRows.filter((r) => r.ref.some((x: any) => x.cross > 0));
	const hsCross = crossing.filter((r) => r.hs);
	if (crossing.length) {
		recs.push({
			code: 'SPLIT_REFERENCE',
			sev: hsCross.length ? 'high' : 'medium',
			conf: 'medium',
			msg: `${crossing.length} net(s) cross a cut in their reference plane${hsCross.length ? ` (high-speed by name: ${hsCross.slice(0, 6).map((r) => r.net).join(', ')})` : ''}: ${crossing.slice(0, 8).map((r) => `${r.net}×${r.ref.reduce((s: number, x: any) => s + x.cross, 0)}`).join(', ')}.`,
			why: 'Crossing a slot breaks the return path directly under the trace.',
			fix: 'Remove the cut (move the cutting tracks off the plane) or reroute the signal so it does not cross it.',
		});
	}
	const hsWeak = netRows.filter((r) => r.hs && (r.noRefMil > 0 || r.ref.some((x: any) => x.cov < 90)));
	if (hsWeak.length) {
		recs.push({
			code: 'WEAK_REFERENCE',
			sev: 'medium',
			conf: 'medium',
			msg: `High-speed-looking nets with route length not over a solid adjacent plane: ${hsWeak.slice(0, 8).map((r) => `${r.net}${r.noRefMil ? ` (${r.noRefMil} mil no ref)` : ''}`).join(', ')}.`,
			why: 'Fast edges need a continuous plane on the adjacent layer for a controlled return path and impedance.',
			fix: 'Route them on a layer adjacent to a solid GND plane, inside the plane outline.',
		});
	}
	for (const l of stack) {
		const st = stats.get(l.id);
		if (!st || st.len <= 0 || role.get(l.id) === 'plane') continue;
		const i = idx(l.id);
		if (![stack[i - 1], stack[i + 1]].some((x) => x && planeOf.has(x.id)) && n >= 4) {
			recs.push({ code: 'NO_ADJACENT_PLANE', sev: 'medium', conf: 'medium', msg: `Signal layer ${l.name} (${r0(st.len)} mil of tracks) has no adjacent plane layer.`, why: 'Signals without an adjacent reference plane radiate more and have uncontrolled impedance.', fix: 'Reassign the stack so every signal layer sits next to a GND plane.' });
		}
	}

	// 3. Layer utilisation
	for (const l of stack) {
		const st = stats.get(l.id);
		const out = ctx.layerOut.find((x) => x.id === l.id);
		if (role.get(l.id) === 'unused') {
			recs.push({ code: 'EMPTY_LAYER', sev: 'low', conf: 'high', msg: `${l.name} carries no copper.`, why: 'An empty copper layer adds cost and gives nothing back.', fix: 'Pour a GND plane on it, or reduce the layer count (pcb_set_copper_layer_count, dry-run first).' });
		} else if (role.get(l.id) !== 'plane' && st && totalLen > 0 && st.len < 0.03 * totalLen && !(out?.pours?.length)) {
			recs.push({ code: 'NEARLY_EMPTY_LAYER', sev: 'info', conf: 'medium', msg: `${l.name} carries only ${pct(st.len, totalLen)}% of the track length (${st.tracks + st.arcs} segment(s)) and no pour.`, why: 'A lightly used layer could become a plane or be dropped.', fix: `Move its few tracks (pcb_move_tracks_to_layer) and pour it as GND.` });
		}
	}

	// 4. Vias
	const bouncing = [...netVias.entries()]
		.filter(([net, v]) => !pourNets.has(net) && (padCount.get(net) ?? 0) >= 2 && v.vias >= 3 && v.vias > 2 * ((padCount.get(net) ?? 0) - 1))
		.sort((a, b) => b[1].vias - a[1].vias);
	if (bouncing.length) {
		recs.push({ code: 'VIA_BOUNCE', sev: 'low', conf: 'medium', msg: `Nets using more vias than their pad count suggests (layer bouncing): ${bouncing.slice(0, 8).map(([k, v]) => `${k} ${v.vias} vias/${padCount.get(k)} pads`).join(', ')}.`, why: 'Every via adds inductance, a stub and a plane antipad.', fix: 'Reroute those nets with fewer layer changes; check pcb_layer_report detail:"nets" for their per-layer split.' });
	}
	const stubs = [...netVias.entries()].filter(([, v]) => v.stubs.length);
	const stubCount = stubs.reduce((s, [, v]) => s + v.stubs.length, 0);
	if (stubCount) {
		recs.push({ code: 'STUB_VIA', sev: 'low', conf: 'medium', msg: `${stubCount} via(s) on non-pour nets join tracks on at most one layer and no pad: ${stubs.slice(0, 6).map(([k, v]) => `${k} [${v.stubs.slice(0, 3).join(',')}]`).join('; ')}.`, why: 'A via that changes no layer is usually leftover copper.', fix: 'Delete it if pcb_connectivity_status stays the same without it.' });
	}

	// 5. Layer count (density heuristic)
	const signalLayers = stack.filter((l) => role.get(l.id) === 'signal' || role.get(l.id) === 'signal+flood').length || 1;
	const segCount = [...stats.values()].reduce((s, x) => s + x.tracks + x.arcs, 0) || 1;
	const avgWidth = [...stats.values()].reduce((s, x) => s + x.area, 0) / Math.max(1, totalLen) || 10;
	const utilisation = boardArea > 0 ? (totalLen * (avgWidth + clearance)) / (boardArea * signalLayers) : 0;
	const hsNets = netRows.filter((r) => r.hs).map((r) => r.net);
	const density = boardArea > 0 ? ctx.allPadCount / (boardArea / 1e6) : 0;
	const numbers = `routing utilisation ≈${pct(utilisation, 1)}% of ${signalLayers} signal layer(s) (length × (avg width ${r1(avgWidth)} + clearance ${clearance}) / area), ${r1(density)} pads/in², ${segCount} segments`;
	if (boardArea > 0 && totalLen > 0) {
		if (n >= 4 && utilisation < 0.08) {
			recs.push(hsNets.length
				? { code: 'LAYER_COUNT', sev: 'info', conf: 'low', msg: `Routing density is low (${numbers}); ${n} layers look driven by signal integrity (high-speed-looking nets: ${hsNets.slice(0, 5).join(', ')}), which is a sound reason to keep them.`, why: 'Density alone would fit fewer layers, but solid planes under fast nets matter more than layer cost.' }
				: { code: 'LAYER_COUNT', sev: 'info', conf: 'low', msg: `Routing density is low (${numbers}); the design might route on ${n - 2} layers.`, why: 'Uncertain: fewer layers lose solid reference planes (EMC, impedance); only worth it if cost matters more than margin.' });
		} else if (utilisation > 0.35) {
			recs.push({ code: 'LAYER_COUNT', sev: 'medium', conf: 'low', msg: `Routing is dense (${numbers}); more signal layers (or a larger board) may be needed to keep planes unbroken.`, why: 'Dense routing forces tracks into planes and adds vias.' });
		} else {
			recs.push({ code: 'LAYER_COUNT', sev: 'info', conf: 'low', msg: `Layer count looks proportionate (${numbers}).`, why: 'Neither sparse nor congested by this rough measure.' });
		}
		if (n === 2 && hsNets.length) {
			recs.push({ code: 'LAYER_COUNT_HS', sev: 'medium', conf: 'low', msg: `2-layer board with high-speed-looking nets (${hsNets.slice(0, 5).join(', ')}).`, why: 'Without an inner GND plane, their return paths depend on the bottom flood staying unbroken.', fix: 'Keep the bottom GND flood continuous under them, or consider 4 layers (SIG/GND/PWR/SIG).' });
		}
	}

	// 6. Stack-up assignment vs classic
	const roles = stack.map((l) => {
		const plane = planeOf.get(l.id);
		const r = role.get(l.id);
		return r === 'plane' ? (plane?.net && GROUND.test(plane.net) ? 'GND' : plane?.net && POWER.test(plane.net) ? 'PWR' : `PLANE(${plane?.net ?? '?'})`)
			: r === 'signal+flood' ? `SIG+${plane?.net ?? 'pour'}` : r === 'flood' ? `${plane?.net ?? 'pour'} flood` : r === 'unused' ? 'EMPTY' : 'SIG';
	});
	const classic: Record<number, string> = {
		2: 'SIG+GND / GND+SIG (keep one side an unbroken GND flood)',
		4: 'SIG / GND / PWR / SIG, or SIG / GND / GND / SIG with power on outer pours (better EMC)',
		6: 'SIG / GND / SIG / PWR / GND / SIG',
		8: 'SIG / GND / SIG / GND / PWR / SIG / GND / SIG',
	};
	const advice: string[] = [];
	if (n >= 4) {
		if (!roles[1].startsWith('GND')) advice.push(`${stack[1].name} (under Top, where most parts sit) should be a solid GND plane`);
		if (!roles[n - 2].startsWith('GND') && !roles[n - 2].startsWith('PWR')) advice.push(`${stack[n - 2].name} (above Bottom) should be a plane`);
		if (n === 4 && roles[1].startsWith('GND') && roles[2].startsWith('GND')) {
			const powerOuter = netRows.filter((r) => POWER.test(r.net)).reduce((s, r) => s + r.lenMil, 0);
			advice.push(`GND/GND inner pair is a valid choice; power then travels on outer layers (${powerOuter} mil of power-net tracks) — use pours/wide tracks for it, or turn ${stack[2].name} into a PWR plane if power routing is crowding signals`);
		}
	}
	recs.push({
		code: 'STACKUP',
		sev: 'info',
		conf: 'medium',
		msg: `Current: ${roles.join(' / ')}. Classic ${n}-layer: ${classic[n] ?? 'every signal layer adjacent to a GND plane'}.${advice.length ? ` ${advice.join('; ')}.` : ''}`,
		why: 'Signals reference the adjacent plane; GND next to the busiest signal layer gives the shortest return paths.',
	});
	const planeTyped = stack.filter((l) => isInner(l.id) && role.get(l.id) === 'plane' && l.type.toUpperCase() !== 'PLANE');
	if (planeTyped.length) {
		recs.push({ code: 'INNER_TYPE', sev: 'info', conf: 'low', msg: `${planeTyped.map((l) => l.name).join(', ')} act as planes but are typed SIGNAL with a pour — that works; switching to PLANE (negative plane) is optional.`, why: 'A SIGNAL layer with a pour reflows around tracks visibly; PLANE layers change how drawn copper is interpreted (not verified here).' });
	}
	const order = { high: 0, medium: 1, low: 2, info: 3 } as const;
	return recs.sort((a, b) => order[a.sev] - order[b.sev]);
}

// ---------------------------------------------------------------------------
// Copper inventory on given layers (used by the guards)
// ---------------------------------------------------------------------------

async function copperOnLayers(ids: number[], stack: LayerInfo[]): Promise<any[]> {
	if (!ids.length) return [];
	const want = new Set(ids);
	const layerOf = (x: any) => Number(normalizeLayerSafe(x?.layer));
	const [lines, arcs, pours, fills, regions, pads] = await Promise.all([
		eda.pcb_PrimitiveLine.getAll(undefined, undefined, undefined).catch(() => []),
		fetchArcs().catch(() => []),
		eda.pcb_PrimitivePour.getAll(undefined, undefined, undefined).catch(() => []),
		((eda as any).pcb_PrimitiveFill?.getAll?.() ?? Promise.resolve([])).catch(() => []),
		((eda as any).pcb_PrimitiveRegion?.getAll?.() ?? Promise.resolve([])).catch(() => []),
		eda.pcb_PrimitivePad.getAll(undefined, undefined, undefined).catch(() => []),
	]);
	const out: any[] = [];
	for (const id of ids) {
		const tracks = flattenStateArray(lines as any[]).filter((l) => layerOf(l) === id);
		const arcList = (arcs as any[]).filter((a) => layerOf(a) === id);
		const pourList = flattenStateArray(pours as any[]).filter((p) => layerOf(p) === id);
		const fillList = flattenStateArray(fills as any[]).filter((f) => layerOf(f) === id);
		const regionList = flattenStateArray(regions as any[]).filter((r) => layerOf(r) === id);
		const padList = flattenStateArray(pads as any[]).filter((p) => layerOf(p) === id);
		const count = tracks.length + arcList.length + pourList.length + fillList.length + regionList.length + padList.length;
		if (!count || !want.has(id)) continue;
		const nets = new Set<string>([...tracks, ...arcList, ...pourList, ...fillList, ...padList].map((x) => x?.net).filter(Boolean).map(String));
		out.push({
			layer: id,
			name: stack.find((l) => l.id === id)?.name ?? defaultName(id),
			...(tracks.length ? { tracks: tracks.length, lenMil: r0(tracks.reduce((s, l) => s + Math.hypot(Number(l.endX) - Number(l.startX), Number(l.endY) - Number(l.startY)), 0)) } : {}),
			...(arcList.length ? { arcs: arcList.length } : {}),
			...(pourList.length ? { pours: pourList.map((p) => ({ id: p.primitiveId, net: p.net, name: p.pourName })) } : {}),
			...(fillList.length ? { fills: fillList.length } : {}),
			...(regionList.length ? { regions: regionList.length } : {}),
			...(padList.length ? { pads: padList.length } : {}),
			nets: [...nets].slice(0, 12),
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Copper layer count (guarded)
// ---------------------------------------------------------------------------

const VALID_COUNTS = new Set([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]);

export async function setCopperLayerCount(params: Record<string, any>): Promise<any> {
	const count = Number(params.count);
	if (!VALID_COUNTS.has(count)) throw new Error(`count must be an even number 2..32 (got ${params.count}).`);
	const dryRun = params.dryRun !== false;
	const force = params.force === true;
	const stack = copperStack(await readLayerRows());
	const reported = await reportedCopperCount();
	const current = reported ?? stack.length;
	const inner = stack.filter((l) => isInner(l.id)).map((l) => l.id);
	if (count === current) return { status: 'unchanged', count, stack: stack.map((l) => l.name) };

	const removed = count < current ? inner.slice(Math.max(0, count - 2)) : [];
	const occupied = await copperOnLayers(removed, stack);
	const plan = {
		from: current,
		to: count,
		...(removed.length ? { removes: removed.map((id) => stack.find((l) => l.id === id)?.name ?? defaultName(id)) } : {}),
		...(count > current ? { adds: Array.from({ length: count - current }, (_, i) => defaultName(15 + inner.length + i)) } : {}),
		assumption: removed.length ? 'EasyEDA drops the highest-numbered inner layers when the count is reduced.' : undefined,
	};
	if (occupied.length && !force) {
		return {
			status: 'refused',
			plan,
			occupied,
			note: 'Nothing changed: the layers that would be removed still carry copper. Move it (pcb_move_tracks_to_layer) or delete it first, or pass force:true to accept losing it.',
		};
	}
	if (dryRun) return { status: 'dry-run', plan, ...(occupied.length ? { occupied, warning: 'force:true — this copper is expected to be lost.' } : {}), note: 'Re-run with dryRun:false to apply.' };

	const ok = await bounded('Set copper layer count', () => eda.pcb_Layer.setTheNumberOfCopperLayers(count as any), 15_000);
	invalidateSnapshot();
	const after = copperStack(await readLayerRows());
	const afterReported = await reportedCopperCount();
	const verified = after.length === count && (afterReported == null || afterReported === count);
	const leftover = removed.length ? await copperOnLayers(removed, stack) : [];
	return {
		status: verified ? 'applied' : 'not-verified',
		hostResult: ok,
		plan,
		after: { copperLayers: after.length, ...(afterReported != null ? { hostReported: afterReported } : {}), stack: after.map((l) => l.name) },
		...(leftover.length ? { leftoverOnRemovedLayers: leftover } : {}),
		note: verified
			? 'Layer count changed and re-read. Re-check the physical stack (pcb_manage_physical_stack get), repour and run DRC.'
			: 'The re-read layer count does not match the request — inspect pcb_get_layer_status before continuing.',
	};
}

// ---------------------------------------------------------------------------
// Inner layer type (guarded)
// ---------------------------------------------------------------------------

export async function setInnerLayerType(params: Record<string, any>): Promise<any> {
	const type = String(params.type ?? '').toUpperCase();
	if (type !== 'SIGNAL' && type !== 'PLANE') throw new Error('type must be SIGNAL or PLANE.');
	const dryRun = params.dryRun !== false;
	const rows = await readLayerRows();
	const stack = copperStack(rows);
	const id = resolveLayerRef(params.layer, stack);
	if (id == null || !isInner(id)) throw new Error(`Layer "${params.layer}" is not an inner copper layer; only inner layers can change type.`);
	const before = stack.find((l) => l.id === id);
	if (!before) throw new Error(`Inner layer ${defaultName(id)} is not active on this board (copper layers: ${stack.map((l) => l.name).join(', ')}).`);
	const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : undefined;
	if (before.type.toUpperCase() === type && (!name || name === before.name)) return { status: 'unchanged', layer: id, name: before.name, type };

	const warnings: string[] = [];
	if (type === 'PLANE' && before.type.toUpperCase() !== 'PLANE') {
		const [copper] = await copperOnLayers([id], stack);
		if (copper?.tracks || copper?.arcs) {
			if (params.force !== true) {
				return {
					status: 'refused',
					layer: id,
					name: before.name,
					copper,
					note: 'Nothing changed: the layer carries tracks. On a PLANE (negative) layer drawn copper may be interpreted as plane splits rather than conductors (not verified on this host). Move the tracks first, or pass force:true.',
				};
			}
			warnings.push('force: tracks on a PLANE layer may become plane splits — verify connectivity and DRC.');
		}
		warnings.push('PLANE layers use negative-plane semantics in EasyEDA; existing pours on the layer may behave differently — repour and inspect.');
	}
	if (type === 'SIGNAL' && before.type.toUpperCase() === 'PLANE') warnings.push('Leaving PLANE type: plane areas/splits drawn for the negative plane may no longer produce copper — repour and inspect.');
	const property: Record<string, any> = { type };
	if (name) property.name = name;
	const plan = { layer: id, from: { name: before.name, type: before.type }, to: property };
	if (dryRun) return { status: 'dry-run', plan, ...(warnings.length ? { warnings } : {}), note: 'Re-run with dryRun:false to apply.' };

	const hostResult = await bounded('Modify layer', () => eda.pcb_Layer.modifyLayer(id as any, property as any), 10_000);
	const after = copperStack(await readLayerRows()).find((l) => l.id === id);
	const verified = !!after && after.type.toUpperCase() === type && (!name || after.name === name);
	return {
		status: verified ? 'applied' : 'not-verified',
		hostResult,
		plan,
		after: after ? { name: after.name, type: after.type } : undefined,
		...(warnings.length ? { warnings } : {}),
	};
}

// ---------------------------------------------------------------------------
// Move tracks to another layer (transactional, verified)
// ---------------------------------------------------------------------------

type Issue = { code: string; level: 'error' | 'warning'; msg: string; id?: string; at?: [number, number] };
type Step = { kind: 'track' | 'arc'; id: string; prior: number; next: number };
const CONNECTIVITY_MIN_MS = 4_000;

async function modifyLayerOf(step: Step, layer: number): Promise<boolean> {
	const api: any = step.kind === 'arc' ? eda.pcb_PrimitiveArc : eda.pcb_PrimitiveLine;
	return !!(await api.modify(step.id, { layer }));
}

async function readLayerOf(step: Step): Promise<number | undefined> {
	const api: any = step.kind === 'arc' ? eda.pcb_PrimitiveArc : eda.pcb_PrimitiveLine;
	const one = await api.get(step.id).catch(() => undefined);
	const flat = Array.isArray(one) ? flattenStateArray(one)[0] : flattenState(one);
	const layer = Number(normalizeLayerSafe(flat?.layer));
	return Number.isFinite(layer) ? layer : undefined;
}

async function restoreSteps(touched: Step[], viaIds: string[]): Promise<{ ok: boolean; errors?: string[] }> {
	const errors: string[] = [];
	for (const step of [...touched].reverse()) {
		try {
			if ((await readLayerOf(step)) === step.prior) continue;
			await modifyLayerOf(step, step.prior);
			if ((await readLayerOf(step)) !== step.prior) errors.push(`${step.kind} ${step.id}: still not on layer ${step.prior}`);
		} catch (e: any) {
			errors.push(`${step.kind} ${step.id}: ${e?.message ?? e}`);
		}
	}
	if (viaIds.length) {
		try { if (!(await eda.pcb_PrimitiveVia.delete(viaIds))) errors.push(`vias ${viaIds.join(',')}: delete returned false`); }
		catch (e: any) { errors.push(`vias ${viaIds.join(',')}: ${e?.message ?? e}`); }
	}
	invalidateSnapshot();
	return errors.length ? { ok: false, errors } : { ok: true };
}

async function padGroupsByNet(nets: string[]): Promise<Record<string, number>> {
	const snapshot = await getSnapshot({ forceRefresh: true });
	const arcs = await fetchArcs().catch(() => []);
	const out: Record<string, number> = {};
	for (const n of analyzeConnectivity({ ...snapshot, arcs }, nets)) out[n.net] = n.padGroups?.length ?? (n.pads > 0 ? 1 : 0);
	return out;
}

function inRegion(s: Seg, region: Box | undefined): boolean {
	if (!region) return true;
	const inside = (p: Pt) => p.x >= region.minX && p.x <= region.maxX && p.y >= region.minY && p.y <= region.maxY;
	return inside(s.a) && inside(s.b);
}

function regionOf(value: any): Box | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const v = [value.minX, value.minY, value.maxX, value.maxY].map(Number);
	if (!v.every(Number.isFinite)) throw new Error('region needs numeric minX, minY, maxX, maxY (canvas mil).');
	return { minX: Math.min(v[0], v[2]), minY: Math.min(v[1], v[3]), maxX: Math.max(v[0], v[2]), maxY: Math.max(v[1], v[3]) };
}

export async function moveTracksToLayer(params: Record<string, any>): Promise<any> {
	const issues: Issue[] = [];
	const issue = (level: Issue['level'], code: string, msg: string, extra: Partial<Issue> = {}) => issues.push({ code, level, msg, ...extra });
	const dryRun = params.dryRun !== false;
	const snapshot = await getSnapshot({ forceRefresh: true });
	const stack = copperStack(snapshot.layers, snapshot.lines.map((l: any) => Number(normalizeLayerSafe(l.layer))));
	const toLayer = resolveLayerRef(params.toLayer, stack);
	if (toLayer == null || !stack.some((l) => l.id === toLayer)) throw new Error(`toLayer "${params.toLayer}" is not an active copper layer (copper layers: ${stack.map((l) => `${l.id}=${l.name}`).join(', ')}).`);
	const fromLayer = params.fromLayer != null ? resolveLayerRef(params.fromLayer, stack) : undefined;
	const region = regionOf(params.region);
	const arcs = await fetchArcs().catch(() => []);
	const all = [...snapshot.lines.map((l: any) => toSeg(l, 'track')), ...arcs.map((a: any) => toSeg(a, 'arc'))].filter((s): s is Seg => !!s);

	let selected: Seg[];
	if (Array.isArray(params.trackIds) && params.trackIds.length) {
		const ids = params.trackIds.map(String);
		selected = all.filter((s) => ids.includes(s.id));
		const missing = ids.filter((id: string) => !selected.some((s) => s.id === id));
		if (missing.length) issue('error', 'TRACK_NOT_FOUND', `Not copper tracks/arcs on this board: ${missing.slice(0, 10).join(', ')}.`);
	} else if (params.net) {
		const net = String(params.net);
		selected = all.filter((s) => s.net === net && (fromLayer == null || s.layer === fromLayer) && inRegion(s, region));
	} else {
		throw new Error('Pass trackIds:[...] or net (optionally with fromLayer and region).');
	}
	const already = selected.filter((s) => s.layer === toLayer).length;
	selected = selected.filter((s) => s.layer !== toLayer);
	const toName = stack.find((l) => l.id === toLayer)?.name ?? defaultName(toLayer);
	const plan = {
		toLayer: toLayer,
		toName,
		tracks: selected.length,
		lenMil: r0(selected.reduce((s, x) => s + x.len, 0)),
		nets: [...new Set(selected.map((s) => s.net ?? '(no net)'))],
		fromLayers: [...new Set(selected.map((s) => s.layer))],
		...(already ? { alreadyOnTarget: already } : {}),
		ids: selected.slice(0, 40).map((s) => s.id),
	};
	if (!selected.length) return { status: 'nothing-to-move', plan, issues };

	const movedIds = new Set(selected.map((s) => s.id));
	const pads = dedupePads([...snapshot.componentPads, ...snapshot.standalonePads]);
	const rulesP = fetchDrcRules().catch(() => ({ ruleConfig: undefined, netRules: undefined }));

	// Supplied vias: each must sit on a moved endpoint; the net comes from that track.
	const vias: Array<{ x: number; y: number; net: string; diameter: number; holeDiameter: number }> = [];
	for (const raw of Array.isArray(params.vias) ? params.vias : []) {
		const c = { x: Number(raw?.x), y: Number(raw?.y) };
		if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) { issue('error', 'VIA_INVALID', 'Each via needs numeric x and y (mil).'); continue; }
		const { ruleConfig, netRules } = await rulesP;
		const host = selected.find((s) => [s.a, s.b].some((p) => dist(p, c) <= s.w / 2 + EPS));
		if (!host) { issue('error', 'VIA_NOT_AT_ENDPOINT', `Via at (${c.x}, ${c.y}) is not on an endpoint of a track being moved.`, { at: [c.x, c.y] }); continue; }
		const rule = resolveViaSize(ruleConfig, netRules, host.net).rule;
		const diameter = Number(raw.diameter ?? rule?.diameterMil ?? 24);
		const holeDiameter = Number(raw.holeDiameter ?? rule?.drillMil ?? 12);
		vias.push({ ...c, net: host.net ?? '', diameter, holeDiameter });
	}
	const viaAt = (p: Pt, net?: string) =>
		snapshot.vias.some((v: any) => String(v.net ?? '') === String(net ?? '') && dist(p, { x: Number(v.x), y: Number(v.y) }) <= Number(v.diameter ?? 24) / 2 + EPS)
		|| vias.some((v) => v.net === (net ?? '') && dist(p, v) <= v.diameter / 2 + EPS);

	// --- endpoint check --------------------------------------------------------
	if (params.endpointCheck !== false) {
		const unmoved = all.filter((s) => !movedIds.has(s.id));
		for (const s of selected) {
			for (const p of [s.a, s.b]) {
				const at: [number, number] = [r1(p.x), r1(p.y)];
				const via = viaAt(p, s.net);
				let anchored = via; // a via or drilled pad keeps every layer joined at this point
				for (const pad of pads) {
					if (String(pad?.net ?? '') !== String(s.net ?? '')) continue;
					const o = padToObstacle(pad, 'pad');
					if (!o || !polygonHit(p, p, o.polygon, o.bounds, s.w / 2, EPS)) continue;
					// A pad with no readable layer is NOT assumed to be on the target.
					const padLayer = Number(normalizeLayerSafe(pad.layer));
					if (o.drilled || padLayer === MULTI) { anchored = true; continue; }
					if (padLayer === toLayer) continue;
					const label = pad.label ?? pad.primitiveId;
					if (via) issue('warning', 'VIA_IN_PAD', `${s.id}: via placed inside pad ${label} (layer ${Number.isFinite(padLayer) ? padLayer : '?'}).`, { id: s.id, at });
					else issue('error', 'PAD_LAYER', `${s.id} ends on SMD pad ${label} on layer ${Number.isFinite(padLayer) ? padLayer : 'unknown'}, not ${toName}. Keep a stub on the pad layer and supply a via where the moved part starts, or leave this track out.`, { id: s.id, at });
				}
				if (anchored) continue;
				// Same-layer copper that stays behind loses this joint.
				const behind = unmoved.filter((u) => u.net === s.net && u.layer === s.layer && pointToSegmentDistance(p, u.a, u.b) <= (u.w + s.w) / 2 + EPS);
				if (behind.length) {
					issue('error', 'ORPHANED', `${s.id} connects at (${at.join(', ')}) to ${behind.map((u) => u.id).slice(0, 3).join(',')} on layer ${s.layer}, which stays behind. Include it, or supply a via there.`, { id: s.id, at });
				}
			}
		}
		// Branches of unmoved copper that land on the body of a moved track.
		for (const u of unmoved) {
			if (u.layer === toLayer) continue;
			for (const q of [u.a, u.b]) {
				const host = selected.find((s) => s.net === u.net && s.layer === u.layer && pointToSegmentDistance(q, s.a, s.b) <= (u.w + s.w) / 2 + EPS && dist(q, s.a) > EPS && dist(q, s.b) > EPS);
				if (host && !viaAt(q, u.net) && !issues.some((i) => i.code === 'ORPHANED' && i.id === host.id)) {
					issue('error', 'ORPHANED', `${u.id} branches off ${host.id} at (${r1(q.x)}, ${r1(q.y)}) on layer ${u.layer} and would be cut off. Include it or supply a via there.`, { id: host.id, at: [r1(q.x), r1(q.y)] });
				}
			}
		}
	}

	// --- obstacle + plane-cut check on the target layer -------------------------
	const segments = [
		...selected.map((s) => ({ net: s.net, layer: toLayer, startX: s.a.x, startY: s.a.y, endX: s.b.x, endY: s.b.y, lineWidth: s.w, role: `track:${s.id}` })),
		...vias.flatMap((v) => stack.map((l) => ({ net: v.net, layer: l.id, startX: v.x, startY: v.y, endX: v.x, endY: v.y, lineWidth: v.diameter, role: 'via' }))),
	];
	let blocking: any[] = [];
	try {
		const check = await checkTraceObstacles({ segments, failOnObstacle: false, maxObstacles: params.maxObstacles ?? 100, ignorePrimitiveIds: [...movedIds], obstacleCheckTimeoutMs: params.obstacleCheckTimeoutMs });
		blocking = (Array.isArray(check?.obstacles) ? check.obstacles : []).filter((o: any) => o.severity === 'blocker' && o.type !== 'pour').map((o: any) => ({
			on: String(o.routeSegment?.role ?? '').replace(/^track:/, ''), type: o.type, net: o.net, id: o.primitiveId, ref: o.reference ? `${o.reference}.${o.padNumber ?? ''}` : undefined, gapMil: o.distanceMil, needMil: o.clearanceRequiredMil,
		}));
	} catch (e: any) {
		issue('error', 'PREFLIGHT_FAILED', `Obstacle check failed: ${e?.message ?? e}`);
	}
	const { pours } = await readPourGeometry(snapshot.boardOutline?.bounds ?? snapshot.bounds);
	const targetPours = pours.filter((p) => p.layer === toLayer).sort((a, b) => b.area - a.area);
	for (const pour of targetPours.slice(0, 3)) {
		const cutting = selected.filter((s) => s.net !== pour.net && samples(s).some((p) => inRings(p, pour.rings)));
		if (cutting.length) issue('warning', 'PLANE_CUT', `${cutting.length} moved track(s) (${r0(cutting.reduce((s, x) => s + x.len, 0))} mil) would run through ${pour.net ?? '?'} pour ${pour.name ?? pour.id} on ${toName}, cutting it.`);
	}

	const errors = issues.filter((i) => i.level === 'error');
	const shape = (status: string, extra: Record<string, any> = {}) => ({
		status,
		plan,
		...(vias.length ? { vias: vias.map((v) => ({ at: [v.x, v.y], net: v.net, diameter: v.diameter, hole: v.holeDiameter })) } : {}),
		...(issues.length ? { issues: issues.slice(0, 30), ...(issues.length > 30 ? { issuesTotal: issues.length } : {}) } : {}),
		...(blocking.length ? { blocking: blocking.slice(0, 20), ...(blocking.length > 20 ? { blockingTotal: blocking.length } : {}) } : {}),
		...extra,
	});
	if (errors.length) return shape('refused', { note: 'Nothing changed. Fix the errors (each names the track and point) or narrow the selection.' });
	if (blocking.length) return shape('blocked', { note: 'Nothing changed: the moved copper would violate clearance on the target layer.' });
	if (dryRun) return shape('dry-run', { note: 'Checks passed. Re-run with dryRun:false to move.' });

	// --- commit -----------------------------------------------------------------
	const deadlineAt = Number(params._gateDeadlineAt) || undefined;
	const timeLeft = () => (deadlineAt ? deadlineAt - Date.now() : Number.POSITIVE_INFINITY);
	const nets = [...new Set(selected.map((s) => s.net).filter((n): n is string => !!n))];
	const before = nets.length && timeLeft() > CONNECTIVITY_MIN_MS * 2 ? await padGroupsByNet(nets) : undefined;
	const steps: Step[] = selected.map((s) => ({ kind: s.kind, id: s.id, prior: s.layer, next: toLayer }));
	const touched: Step[] = [];
	const createdVias: string[] = [];
	let failedAt: any;
	for (const step of steps) {
		touched.push(step); // before the call: a throwing modify may still have applied
		try {
			if (!(await modifyLayerOf(step, step.next))) failedAt = { id: step.id, error: 'EasyEDA returned no result for modify' };
		} catch (e: any) { failedAt = { id: step.id, error: String(e?.message ?? e) }; }
		if (failedAt) break;
	}
	if (!failedAt) {
		for (const v of vias) {
			try {
				const made = flattenState(await eda.pcb_PrimitiveVia.create(v.net, v.x, v.y, v.holeDiameter, v.diameter));
				if (!made?.primitiveId) { failedAt = { via: [v.x, v.y], error: 'EasyEDA returned no via' }; break; }
				createdVias.push(String(made.primitiveId));
			} catch (e: any) { failedAt = { via: [v.x, v.y], error: String(e?.message ?? e) }; break; }
		}
	}
	invalidateSnapshot();
	if (failedAt) {
		const rollback = await restoreSteps(touched, createdVias);
		return shape(rollback.ok ? 'rolled-back' : 'partial', { failedAt, rollback, note: rollback.ok ? 'EasyEDA refused part of the move; everything was restored.' : 'Restore incomplete — see rollback.errors.' });
	}
	const mismatches: string[] = [];
	for (const step of steps) if ((await readLayerOf(step)) !== step.next) mismatches.push(step.id);
	if (mismatches.length) {
		const rollback = await restoreSteps(touched, createdVias);
		return shape(rollback.ok ? 'rolled-back' : 'partial', { verify: { readBack: { ok: false, notMoved: mismatches.slice(0, 20) } }, rollback, note: 'EasyEDA did not persist the layer change (read-back); everything was restored.' });
	}
	let connectivity: any = { skipped: nets.length ? 'not enough time left in this call — check pcb_connectivity_status' : 'moved copper has no net' };
	if (before && timeLeft() > CONNECTIVITY_MIN_MS) {
		const after = await padGroupsByNet(nets);
		const worse = nets.filter((n) => (after[n] ?? 0) > (before[n] ?? 0));
		connectivity = { ok: !worse.length, before, after, ...(worse.length ? { worse } : {}) };
	}
	const verify = { readBack: { ok: true }, connectivity };
	if (connectivity.ok === false && params.keepOnVerifyFail !== true) {
		const rollback = await restoreSteps(touched, createdVias);
		return shape(rollback.ok ? 'rolled-back' : 'partial', { verify, rollback, note: rollback.ok ? `Moved, but ${connectivity.worse.join(', ')} lost connections; everything was restored (keepOnVerifyFail:true keeps it).` : 'Connectivity got worse and the restore was incomplete — see rollback.errors.' });
	}
	return shape('moved', { verify, ...(createdVias.length ? { createdVias } : {}), note: 'Repour (pcb_repour_all) and run DRC when this batch of edits is done.' });
}

// ---------------------------------------------------------------------------

export const layerAnalysisHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.layer.report': (params) => buildLayerReport(params),
	'pcb.layer.copperCount.set': (params) => setCopperLayerCount(params),
	'pcb.layer.innerType.set': (params) => setInnerLayerType(params),
	'pcb.layer.moveTracks': (params) => moveTracksToLayer(params),
};
