// Model-planned route executor (pcb_route_path).
//
// The model plans the route; this commits EXACTLY that path — no re-synthesis,
// no pathfinding — or nothing at all, and then proves the result:
//   1. terminals resolve to exact copper (pad centre, via centre, track end or
//      a point on a track) and must belong to the route's net (no shorts);
//   2. the path is checked: octilinear legs, no acute turns, no zero-length
//      legs, layer continuity at both terminals, free ends refused;
//   3. obstacle preflight against different-net copper with the board's DRC
//      clearances (pours are plane-cut warnings, not walls);
//   4. all tracks + vias of every route in the call commit as ONE transaction
//      (commitBatchOperations): any failure removes everything this call made;
//   5. verification: the new copper must join each route's two terminals in
//      the real copper graph (and optionally introduce no DRC violation),
//      otherwise the call rolls itself back.
// Every outcome returns the same shape, so a refusal is the next plan's input.

import { normalizeLayer } from './_utils';
import { commitBatchOperations, getSnapshot, invalidateSnapshot } from './board-context';
import { extractDrcOffenders, flattenDrcTree, normalizeDrcUnits } from './drc';
import { analyzeConnectivity, fetchArcs } from './net-connectivity';
import { checkTraceObstacles, fetchDrcRules, padToObstacle, pointToSegmentDistance, polygonHit, trackWidthForNet, viaSizeForNet } from './trace-obstacles';

const MIL_PER_MM = 39.37007874015748;
const MULTI_LAYER = 12;
const ANGLE_TOLERANCE_DEG = 0.5;
const DEFAULT_SNAP_MIL = 3;
const DEFAULT_VIA = { diameter: 24, holeDiameter: 12 };
// Time a verification stage needs before the caller's deadline (snapshot +
// copper graph; DRC on a large board takes far longer).
const VERIFY_MIN_MS = 8_000;
const DRC_MIN_MS = 25_000;

type Units = 'mil' | 'mm';
interface Pt { x: number; y: number }
interface Issue { severity: 'error' | 'warning'; code: string; message: string; segment?: number; point?: Pt }

interface Terminal {
	kind: 'pad' | 'via' | 'track' | 'point';
	label: string;
	x: number;
	y: number;
	/** undefined = copper on every layer (via, drilled pad). */
	layer?: number;
	net?: string;
	primitiveId?: string;
}

interface Seg { layer: number; startX: number; startY: number; endX: number; endY: number }
interface Via { x: number; y: number; diameter: number; holeDiameter: number }

interface PlannedRoute {
	index: number;
	net: string;
	width: number;
	from: Terminal & { snappedMil?: number };
	to: Terminal & { snappedMil?: number };
	segments: Seg[];
	vias: Via[];
	lengthMil: number;
	issues: Issue[];
	widthSource?: string;
	viaSource?: string;
}

// Outcomes of committed calls by requestId: a client that timed out and
// retries gets the original result instead of a second copy of the copper.
const host = globalThis as unknown as { __easyedaRoutePathResultsV1?: Map<string, any> };
const recentResults: Map<string, any> = host.__easyedaRoutePathResultsV1 ??= new Map();
const MAX_REMEMBERED = 50;
const REPLAYABLE = new Set(['committed', 'committed-unverified', 'partial', 'already-present']);

export async function routePath(params: Record<string, any>): Promise<any> {
	const requestId = params.requestId != null ? String(params.requestId) : undefined;
	if (requestId && recentResults.has(requestId)) return { ...recentResults.get(requestId), replayed: true };
	const result = await routePathOnce(params);
	// Only outcomes that left copper on the board are replayed; a blocked,
	// invalid or rolled-back call must be allowed to run again.
	if (requestId && params.dryRun === false && REPLAYABLE.has(result.status)) {
		recentResults.set(requestId, { ...result, requestId });
		while (recentResults.size > MAX_REMEMBERED) recentResults.delete(recentResults.keys().next().value!);
	}
	return requestId ? { ...result, requestId } : result;
}

async function routePathOnce(params: Record<string, any>): Promise<any> {
	const units: Units = params.units === 'mm' ? 'mm' : 'mil';
	const k = units === 'mm' ? MIL_PER_MM : 1;
	const dryRun = params.dryRun !== false;
	const verify: 'connectivity' | 'drc' | 'none' = params.verify === 'drc' || params.verify === 'none' ? params.verify : 'connectivity';
	const specs: any[] = Array.isArray(params.routes) && params.routes.length ? params.routes : [params];

	const snapshot = await getSnapshot({ forceRefresh: true });
	const rules = await fetchDrcRules().catch(() => undefined);
	const planned = specs.map((spec, index) => planRoute(spec, index, params, snapshot, k, rules));

	// Obstacles: every leg and every via (as a disc on all layers).
	const legs = planned.flatMap((r) => [
		...r.segments.map((s, i) => ({ ...s, net: r.net, lineWidth: r.width, role: `r${r.index}s${i}` })),
		...r.vias.map((v, i) => ({ net: r.net, layer: MULTI_LAYER, startX: v.x, startY: v.y, endX: v.x, endY: v.y, lineWidth: v.diameter, role: `r${r.index}v${i}` })),
	]);
	const obstacleCheck: any = legs.length && planned.every((r) => !r.issues.some((i) => i.severity === 'error'))
		? await checkTraceObstacles({
			segments: legs,
			failOnObstacle: false,
			maxObstacles: params.maxObstacles ?? 60,
			clearanceMil: params.clearanceMil,
			ignorePrimitiveIds: params.ignorePrimitiveIds,
		})
		: undefined;
	const obstacles = summarizeObstacles(obstacleCheck, k);

	const base = () => ({
		units,
		dryRun,
		routes: planned.map((r) => present(r, k)),
		obstacles,
		clearance: obstacleCheck ? {
			mil: obstacleCheck.clearanceMil,
			source: obstacleCheck.clearanceSource,
			byKind: obstacleCheck.clearanceRules?.clearanceByKind,
			fallbackReason: obstacleCheck.clearanceRules?.fallbackReason,
		} : undefined,
	});

	if (planned.some((r) => r.issues.some((i) => i.severity === 'error'))) {
		return { status: 'invalid', ...base(), created: [], note: 'Nothing was created. Fix the errors listed per route and re-plan.' };
	}
	if (obstacles.blocking.length) {
		return { status: 'blocked', ...base(), created: [], note: 'Nothing was created. Each blocker names the leg, the obstacle, the measured gap and the required clearance.' };
	}
	if (dryRun) {
		return { status: 'dry-run', ...base(), created: [], note: 'Plan is valid and clear. Re-run with dryRun:false to commit exactly this geometry.' };
	}

	// Commit every route of the call as one transaction. Copper that already
	// exists identically (a retried call, a re-run plan) is reused, never
	// duplicated.
	const ops: any[] = [];
	const owner: Array<{ route: number }> = [];
	const reused: Array<{ route: number; type: 'track' | 'via'; primitiveId: string }> = [];
	for (const r of planned) {
		for (const s of r.segments) {
			const same = findSameTrack(snapshot, r.net, s, r.width);
			if (same) { reused.push({ route: r.index, type: 'track', primitiveId: same }); continue; }
			ops.push({ index: ops.length, type: 'create_track', segment: { net: r.net, layer: s.layer, startX: s.startX, startY: s.startY, endX: s.endX, endY: s.endY, lineWidth: r.width } });
			owner.push({ route: r.index });
		}
		for (const v of r.vias) {
			const same = findSameVia(snapshot, r.net, v);
			if (same) { reused.push({ route: r.index, type: 'via', primitiveId: same }); continue; }
			ops.push({ index: ops.length, type: 'create_via', net: r.net, x: v.x, y: v.y, diameter: v.diameter, holeDiameter: v.holeDiameter, viaType: 'Through' });
			owner.push({ route: r.index });
		}
	}
	if (ops.length === 0) {
		const verdict = verify === 'none' ? { mode: 'none' } : await verifyRoutes(planned, reused, verify);
		return { status: 'already-present', ...base(), created: [], reused, verify: verdict, note: 'Every leg and via of this plan already exists on the board; nothing was created.' };
	}
	const commit = await commitBatchOperations(ops, true);
	invalidateSnapshot();
	const created = commit.created.map((c) => ({ ...c, route: owner[c.index]?.route }));
	const reusedOut = reused.length ? reused : undefined;
	if (commit.committed !== true) {
		return {
			status: commit.rolledBack ? 'rolled-back' : 'partial',
			...base(),
			created: commit.rolledBack ? [] : created,
			failedAt: commit.failedAt,
			rollbackErrors: commit.rollbackErrors,
			note: commit.rolledBack ? 'EasyEDA refused part of the commit; everything this call created was removed.' : 'Rollback was incomplete — the ids in `created` are still on the board.',
		};
	}

	if (verify === 'none') {
		return { status: 'committed', ...base(), created, reused: reusedOut, verify: { mode: 'none' } };
	}
	// Never let verification run past the caller's deadline: the gate would
	// quarantine the document. Without time to verify, say so — don't roll back
	// copper that may well be correct.
	const deadlineAt = Number(params._gateDeadlineAt) || undefined;
	if (deadlineAt && deadlineAt - Date.now() < VERIFY_MIN_MS) {
		return {
			status: 'committed-unverified', ...base(), created, reused: reusedOut,
			verify: { mode: verify, ok: false, skipped: 'deadline', note: 'Not enough time left in this call to verify. Check with pcb_connectivity_status (and pcb_drc_summarize).' },
		};
	}
	const verdict = await verifyRoutes(planned, [...created, ...reused], verify, new Set(created.map((c) => c.primitiveId)), deadlineAt);
	if (verdict.skipped) {
		return { status: 'committed-unverified', ...base(), created, reused: reusedOut, verify: verdict };
	}
	if (verdict.ok || params.keepOnVerifyFail === true) {
		return { status: verdict.ok ? 'committed' : 'committed-unverified', ...base(), created, reused: reusedOut, verify: verdict };
	}
	const rollback = await removeCreated(created);
	invalidateSnapshot();
	return {
		status: rollback.ok ? 'rolled-back' : 'partial',
		...base(),
		created: rollback.ok ? [] : created,
		verify: verdict,
		rollbackErrors: rollback.errors.length ? rollback.errors : undefined,
		note: rollback.ok ? 'Committed, failed verification, and was removed again (pass keepOnVerifyFail:true to keep it).' : 'Verification failed and rollback was incomplete — the ids in `created` are still on the board.',
	};
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function planRoute(spec: any, index: number, params: Record<string, any>, snapshot: any, k: number, rules?: { ruleConfig: any; netRules: any }): PlannedRoute {
	const issues: Issue[] = [];
	const err = (code: string, message: string, extra: Partial<Issue> = {}) => issues.push({ severity: 'error', code, message, ...extra });
	const warn = (code: string, message: string, extra: Partial<Issue> = {}) => issues.push({ severity: 'warning', code, message, ...extra });

	const from = resolveTerminal(spec.from, 'from', snapshot, k, err);
	const to = resolveTerminal(spec.to, 'to', snapshot, k, err);
	let net = spec.net ?? params.net;
	if (!net) {
		if (from?.net && to?.net && from.net === to.net) net = from.net;
		else err('NET_REQUIRED', 'Pass "net" (it could not be inferred from both terminals).');
	}
	net = net != null ? String(net) : '';
	for (const t of [from, to]) {
		if (t && t.kind !== 'point' && t.net != null && net && t.net !== net) {
			err('NET_MISMATCH', `${t.label} is on net "${t.net}", not "${net}" — committing would short two nets.`);
		}
	}
	// Width: explicit, else the net's OWN Track rule. A board-default rule is
	// quoted but not applied — it is DRC-legal yet often wrong for the net
	// (10 mil VBUS), so the model decides. Never guessed.
	const widthRule = rules && net ? trackWidthForNet(rules.ruleConfig, rules.netRules, net) : undefined;
	let width = Number(spec.width ?? params.width) * k;
	let widthSource = 'param';
	if (!(width > 0)) {
		if (widthRule?.assignedBy) { width = widthRule.widthMil; widthSource = widthRule.source; }
		else {
			width = 0;
			err('WIDTH_REQUIRED', `Pass "width" (per route or for the call). ${widthRule
				? `Board default Track rule: ${round(widthRule.widthMil / k, 4)} (min ${widthRule.minMil != null ? round(widthRule.minMil / k, 4) : '?'}, max ${widthRule.maxMil != null ? round(widthRule.maxMil / k, 4) : '?'}) — pass it explicitly if it suits "${net}".`
				: 'No track-width rule is readable for this net.'}`);
		}
	}
	if (width > 0 && widthRule) {
		if (widthRule.minMil != null && width < widthRule.minMil - 1e-3) err('WIDTH_BELOW_RULE', `width ${round(width / k, 4)} is below the "${net}" rule minimum ${round(widthRule.minMil / k, 4)} (${widthRule.source}) — DRC would flag every leg.`);
		else if (widthRule.maxMil != null && width > widthRule.maxMil + 1e-3) warn('WIDTH_ABOVE_RULE', `width ${round(width / k, 4)} exceeds the "${net}" rule maximum ${round(widthRule.maxMil / k, 4)} (${widthRule.source}).`);
	}
	// Vias: explicit, else the net's Via Size rule, else a flagged default.
	const viaSpec = spec.via ?? params.via;
	const viaRule = rules && net ? viaSizeForNet(rules.ruleConfig, rules.netRules, net) : undefined;
	const via = {
		diameter: Number(viaSpec?.diameter) > 0 ? Number(viaSpec.diameter) * k : viaRule?.diameterMil ?? DEFAULT_VIA.diameter,
		holeDiameter: Number(viaSpec?.holeDiameter ?? viaSpec?.hole) > 0 ? Number(viaSpec.holeDiameter ?? viaSpec.hole) * k : viaRule?.drillMil ?? DEFAULT_VIA.holeDiameter,
	};
	const viaSource = viaSpec ? 'param' : viaRule ? viaRule.source : 'default';

	const empty = (): PlannedRoute => ({ index, net, width: width || 0, from: from ?? ({ kind: 'point', label: 'from', x: NaN, y: NaN } as Terminal), to: to ?? ({ kind: 'point', label: 'to', x: NaN, y: NaN } as Terminal), segments: [], vias: [], lengthMil: 0, issues });
	if (!from || !to) return empty();

	const points: Array<Pt & { layer?: number }> = [];
	for (const [i, p] of (Array.isArray(spec.points) ? spec.points : []).entries()) {
		const x = Number(p?.x) * k, y = Number(p?.y) * k;
		if (!Number.isFinite(x) || !Number.isFinite(y)) { err('BAD_POINT', `points[${i}] needs numeric x and y.`); continue; }
		let layer: number | undefined;
		if (p.layer != null) { layer = layerOf(p.layer); if (layer == null) err('BAD_LAYER', `points[${i}].layer "${p.layer}" is not a copper layer.`); }
		points.push({ x, y, layer });
	}

	// Start layer: explicit, else the starting pad's layer, else the first layer hint.
	let layer = spec.layer != null ? layerOf(spec.layer) : from.layer;
	if (spec.layer != null && layer == null) err('BAD_LAYER', `layer "${spec.layer}" is not a copper layer.`);
	// A layered point means "via here", never "start on this layer": inferring
	// the start layer from it would silently drop the planned via.
	if (layer == null && !points.some((p) => p.layer != null)) layer = to.layer;
	if (layer == null) { err('LAYER_REQUIRED', `${from.label} has copper on every layer; pass "layer" for the first leg.`); return empty(); }
	if (from.layer != null && from.layer !== layer) err('LAYER_MISMATCH', `${from.label} is on layer ${from.layer} but the route starts on layer ${layer}.`);

	const snapMil = Number(spec.snap ?? params.snap) > 0 ? Number(spec.snap ?? params.snap) * k : DEFAULT_SNAP_MIL;
	const result: PlannedRoute = { ...empty(), from: { ...from }, to: { ...to } };
	if (points.length && dist(points[0], from) <= snapMil) {
		result.from.snappedMil = round(dist(points[0], from), 3);
		const first = points.shift()!;
		if (first.layer != null && first.layer !== layer) err('LAYER_CHANGE_AT_TERMINAL', `A layer change at ${from.label} would need a via inside the terminal; change layers after leaving it.`);
	}
	if (points.length && dist(points[points.length - 1], to) <= snapMil) {
		const last = points[points.length - 1];
		result.to.snappedMil = round(dist(last, to), 3);
		points.pop();
		if (last.layer != null) err('LAYER_CHANGE_AT_TERMINAL', `A layer change at ${to.label} would need a via inside the terminal; change layers before reaching it.`);
	}

	let cur: Pt = { x: from.x, y: from.y };
	let curLayer = layer;
	const pushSeg = (a: Pt, b: Pt, l: number) => result.segments.push({ layer: l, startX: a.x, startY: a.y, endX: b.x, endY: b.y });
	for (const p of points) {
		pushSeg(cur, p, curLayer);
		if (p.layer != null && p.layer !== curLayer) {
			result.vias.push({ x: p.x, y: p.y, ...via });
			curLayer = p.layer;
		}
		cur = { x: p.x, y: p.y };
	}
	pushSeg(cur, { x: to.x, y: to.y }, curLayer);
	if (to.layer != null && to.layer !== curLayer) err('LAYER_MISMATCH', `The route arrives on layer ${curLayer} but ${to.label} is on layer ${to.layer} — add a point with "layer" to place a via before it.`);
	if (result.vias.length && viaSource === 'default') warn('VIA_SIZE_DEFAULTED', `No readable Via Size rule; via size defaulted to ${DEFAULT_VIA.diameter}/${DEFAULT_VIA.holeDiameter} mil — pass via:{diameter,holeDiameter}.`);
	result.widthSource = widthSource;
	result.viaSource = result.vias.length ? viaSource : undefined;

	// Geometry: octilinear legs, no acute turns, no zero-length legs.
	const allowAnyAngle = spec.allowAnyAngle ?? params.allowAnyAngle;
	const allowAcute = spec.allowAcute ?? params.allowAcute;
	result.segments.forEach((s, i) => {
		const len = Math.hypot(s.endX - s.startX, s.endY - s.startY);
		if (len < 1e-6) { err('ZERO_LENGTH', `Leg ${i} has zero length (duplicate point).`, { segment: i }); return; }
		result.lengthMil += len;
		const deg = (Math.atan2(s.endY - s.startY, s.endX - s.startX) * 180) / Math.PI;
		const off = Math.abs(deg - Math.round(deg / 45) * 45);
		if (off > ANGLE_TOLERANCE_DEG) {
			(allowAnyAngle ? warn : err)('NOT_OCTILINEAR', `Leg ${i} runs at ${round(deg, 2)}° (not a multiple of 45°).`, { segment: i });
		}
		const prev = result.segments[i - 1];
		if (prev && prev.layer === s.layer) {
			const v1 = { x: prev.startX - prev.endX, y: prev.startY - prev.endY };
			const v2 = { x: s.endX - s.startX, y: s.endY - s.startY };
			const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
			const interior = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
			if (interior < 90 - ANGLE_TOLERANCE_DEG) (allowAcute ? warn : err)('ACUTE_ANGLE', `Legs ${i - 1}→${i} turn back at an acute ${round(interior, 1)}° corner.`, { segment: i, point: { x: s.startX / k, y: s.startY / k } });
		}
	});

	// A point terminal must land on existing copper of the net.
	const allowFreeEnd = spec.allowFreeEnd ?? params.allowFreeEnd;
	for (const t of [from, to]) {
		if (t.kind === 'point' && !allowFreeEnd && net && !touchesNetCopper(t, net, width / 2, snapshot)) {
			err('FREE_END', `${t.label} at (${round(t.x / k, 4)}, ${round(t.y / k, 4)}) touches no copper of "${net}" — it would leave a dangling end. Use a pad/via/track terminal, or allowFreeEnd:true.`);
		}
	}
	return result;
}

function resolveTerminal(spec: any, label: string, snapshot: any, k: number, err: (code: string, message: string) => void): Terminal | undefined {
	if (spec == null) { err('TERMINAL_REQUIRED', `"${label}" is required.`); return undefined; }
	const padRef = typeof spec === 'string' ? spec : spec.pad;
	if (typeof padRef === 'string') {
		const want = padRef.trim().replace(':', '.').toUpperCase();
		const pad = snapshot.componentPads.find((p: any) => String(p.label ?? '').toUpperCase() === want);
		if (!pad) { err('PAD_NOT_FOUND', `${label}: pad "${padRef}" not found (use DESIGNATOR.PAD, e.g. "U3.12").`); return undefined; }
		const o = padToObstacle(pad, 'component_pad');
		return { kind: 'pad', label: pad.label, x: pad.x, y: pad.y, layer: o?.layer === MULTI_LAYER ? undefined : (o?.layer as number | undefined), net: pad.net, primitiveId: pad.primitiveId };
	}
	if (typeof spec.via === 'string') {
		const v = snapshot.vias.find((x: any) => x.primitiveId === spec.via);
		if (!v) { err('VIA_NOT_FOUND', `${label}: via "${spec.via}" not found.`); return undefined; }
		return { kind: 'via', label: `via ${v.primitiveId}`, x: v.x, y: v.y, net: v.net, primitiveId: v.primitiveId };
	}
	if (typeof spec.track === 'string') {
		const t = snapshot.lines.find((x: any) => x.primitiveId === spec.track);
		if (!t) { err('TRACK_NOT_FOUND', `${label}: track "${spec.track}" not found.`); return undefined; }
		if (spec.x != null && spec.y != null) {
			const p = { x: Number(spec.x) * k, y: Number(spec.y) * k };
			const d = pointToSegmentDistance(p, { x: t.startX, y: t.startY }, { x: t.endX, y: t.endY });
			if (d > Number(t.lineWidth ?? 10) / 2) { err('NOT_ON_TRACK', `${label}: (${spec.x}, ${spec.y}) is ${round(d / k, 4)} off track ${t.primitiveId}'s centreline.`); return undefined; }
			return { kind: 'track', label: `track ${t.primitiveId}`, x: p.x, y: p.y, layer: t.layer, net: t.net, primitiveId: t.primitiveId };
		}
		const atEnd = spec.end === 'end';
		return { kind: 'track', label: `track ${t.primitiveId} ${atEnd ? 'end' : 'start'}`, x: atEnd ? t.endX : t.startX, y: atEnd ? t.endY : t.startY, layer: t.layer, net: t.net, primitiveId: t.primitiveId };
	}
	const x = Number(spec.x) * k, y = Number(spec.y) * k;
	if (Number.isFinite(x) && Number.isFinite(y)) {
		const layer = spec.layer != null ? layerOf(spec.layer) : undefined;
		return { kind: 'point', label, x, y, layer };
	}
	err('BAD_TERMINAL', `${label} must be a pad ref ("U3.12"), {pad}, {via:id}, {track:id, end?|x,y}, or {x,y,layer}.`);
	return undefined;
}

function touchesNetCopper(t: Terminal, net: string, half: number, snapshot: any): boolean {
	const p = { x: t.x, y: t.y };
	for (const l of snapshot.lines) {
		if (l.net !== net || (t.layer != null && l.layer != null && Number(l.layer) !== t.layer)) continue;
		if (pointToSegmentDistance(p, { x: l.startX, y: l.startY }, { x: l.endX, y: l.endY }) <= Number(l.lineWidth ?? 10) / 2 + half) return true;
	}
	for (const v of snapshot.vias) if (v.net === net && dist(p, v) <= Number(v.diameter ?? 24) / 2 + half) return true;
	const componentPadIds = new Set(snapshot.componentPads.map((p: any) => p.primitiveId));
	const standalone = snapshot.standalonePads.filter((p: any) => !componentPadIds.has(p.primitiveId));
	for (const pad of [...snapshot.componentPads, ...standalone]) {
		if (pad.net !== net) continue;
		const o = padToObstacle(pad, 'component_pad');
		if (o && (o.layer === MULTI_LAYER || t.layer == null || o.layer === t.layer) && polygonHit(p, p, o.polygon, o.bounds, half, 0.01)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function verifyRoutes(planned: PlannedRoute[], created: Array<{ primitiveId: string; route?: number; type: string }>, mode: 'connectivity' | 'drc', newIds?: Set<string>, deadlineAt?: number): Promise<any> {
	const snapshot = await getSnapshot({ forceRefresh: true });
	const arcs = await fetchArcs();
	const nets = [...new Set(planned.map((r) => r.net))];
	const graph = analyzeConnectivity({ ...snapshot, arcs }, nets, true);
	const perRoute = planned.map((r) => {
		const ids = new Set(created.filter((c) => c.route === r.index).map((c) => c.primitiveId));
		const groups = graph.find((n) => n.net === r.net)?.groups ?? [];
		const mine = groups.filter((g) => g.ids.some((id) => ids.has(id)));
		const holds = (t: Terminal) => mine.some((g) => (t.kind === 'pad' ? g.pads.includes(t.label) : t.primitiveId ? g.ids.includes(t.primitiveId) : true));
		const joined = mine.length === 1 && holds(r.from) && holds(r.to);
		return {
			route: r.index,
			net: r.net,
			joined,
			reason: joined ? undefined : mine.length !== 1 ? `the new copper split into ${mine.length} separate pieces` : `the new copper does not reach ${!holds(r.from) ? r.from.label : r.to.label}`,
			netStatus: graph.find((n) => n.net === r.net)?.status,
		};
	});
	let drc: any;
	if (mode === 'drc' && deadlineAt && deadlineAt - Date.now() < DRC_MIN_MS) {
		const joinedAll = perRoute.every((r) => r.joined);
		return {
			mode, ok: joinedAll, routes: perRoute, skipped: joinedAll ? 'deadline' : undefined,
			drc: { skipped: 'deadline', note: 'Connectivity verified; not enough time left in this call for a DRC run — run pcb_drc_summarize.' },
		};
	}
	if (mode === 'drc') {
		const raw = normalizeDrcUnits(await eda.pcb_Drc.check(true, false, true));
		const leaves = typeof raw === 'boolean' ? [] : flattenDrcTree(raw);
		const ids = newIds ?? new Set(created.map((c) => c.primitiveId));
		// EasyEDA names the offending primitives in `objs` / obj1/obj2 suffixes.
		const touching = leaves.filter((v: any) => extractDrcOffenders(v).primitiveIds.some((id: string) => ids.has(id)));
		// Right after an API commit EasyEDA's connection graph is stale until the
		// document reloads, and pour copper is stale until a repour — neither is
		// evidence against the new copper.
		const text = (v: any) => JSON.stringify([v.errorType, v.errorObjType, v.obj1, v.obj2, v.explanation]);
		const staleConnection = touching.filter((v: any) => /connection error/i.test(String(v.errorType)));
		const stalePour = touching.filter((v: any) => !staleConnection.includes(v) && /copper region|pour/i.test(text(v)));
		const real = touching.filter((v: any) => !staleConnection.includes(v) && !stalePour.includes(v));
		const sample = (list: any[]) => list.slice(0, 5).map((v: any) => ({ errorType: v.errorType, objType: v.errorObjType, net: v.net, rule: v.ruleName, pos: v.pos }));
		drc = {
			newViolations: real.length,
			samples: real.length ? sample(real) : undefined,
			staleConnectionErrors: staleConnection.length || undefined,
			stalePourViolations: stalePour.length || undefined,
			note: staleConnection.length || stalePour.length ? 'Connection errors refresh when EasyEDA reloads the document; pour violations clear after pcb_repour_all. Neither counts against the route.' : undefined,
		};
	}
	const ok = perRoute.every((r) => r.joined) && (!drc || drc.newViolations === 0);
	return { mode, ok, routes: perRoute, drc };
}

async function removeCreated(created: Array<{ primitiveId: string; type: string }>): Promise<{ ok: boolean; errors: string[] }> {
	const errors: string[] = [];
	const tracks = created.filter((c) => c.type === 'track').map((c) => c.primitiveId);
	const vias = created.filter((c) => c.type === 'via').map((c) => c.primitiveId);
	if (tracks.length) { try { await eda.pcb_PrimitiveLine.delete(tracks); } catch (e: any) { errors.push(`tracks: ${e?.message ?? e}`); } }
	if (vias.length) { try { await eda.pcb_PrimitiveVia.delete(vias); } catch (e: any) { errors.push(`vias: ${e?.message ?? e}`); } }
	return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function present(r: PlannedRoute, k: number): any {
	const u = (v: number) => round(v / k, 4);
	const term = (t: Terminal & { snappedMil?: number }) => ({ label: t.label, kind: t.kind, x: u(t.x), y: u(t.y), layer: t.layer ?? 'all', net: t.net, snapped: t.snappedMil != null ? u(t.snappedMil) : undefined });
	return {
		route: r.index,
		net: r.net,
		width: u(r.width),
		widthSource: r.widthSource,
		viaSource: r.viaSource,
		from: term(r.from),
		to: term(r.to),
		legs: r.segments.map((s) => ({ layer: s.layer, from: [u(s.startX), u(s.startY)], to: [u(s.endX), u(s.endY)] })),
		vias: r.vias.map((v) => ({ at: [u(v.x), u(v.y)], diameter: u(v.diameter), hole: u(v.holeDiameter) })),
		length: u(r.lengthMil),
		issues: r.issues.length ? r.issues : undefined,
	};
}

function summarizeObstacles(check: any, k: number): { blocking: any[]; warnings: any[] } {
	const list: any[] = Array.isArray(check?.obstacles) ? check.obstacles : [];
	const u = (v: number) => round(v / k, 4);
	const brief = (o: any) => {
		const m = /^r(\d+)([sv])(\d+)$/.exec(String(o.routeSegment?.role ?? ''));
		return {
			route: m ? Number(m[1]) : undefined,
			[m?.[2] === 'v' ? 'via' : 'leg']: m ? Number(m[3]) : undefined,
			type: o.type,
			net: o.net,
			layer: o.layer,
			primitiveId: o.primitiveId,
			gap: o.distanceMil != null ? u(o.distanceMil) : undefined,
			required: o.clearanceRequiredMil != null ? u(o.clearanceRequiredMil) : undefined,
			clearanceSource: o.clearanceSource,
			at: o.point ? [u(o.point.x), u(o.point.y)] : undefined,
			reason: o.reason,
		};
	};
	// Board-wide planes put a plane-cut warning on every leg; collapse them per
	// (route, pour) so real warnings stay visible.
	const warnings: any[] = [];
	const planeCuts = new Map<string, any>();
	for (const o of list.filter((x) => x.severity !== 'blocker')) {
		const b = brief(o);
		if (o.planeCut) {
			const key = `${b.route}|${o.primitiveId}`;
			const prior = planeCuts.get(key);
			if (prior) { prior.legs += 1; continue; }
			const entry = { route: b.route, type: 'pour', planeCut: true, net: o.net, layer: o.layer, primitiveId: o.primitiveId, legs: 1, reason: o.reason };
			planeCuts.set(key, entry);
			warnings.push(entry);
		} else warnings.push(b);
	}
	return { blocking: list.filter((o) => o.severity === 'blocker').map(brief), warnings };
}

function layerOf(value: unknown): number | undefined {
	const n = Number(normalizeLayer(value as any));
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function dist(a: Pt, b: Pt): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function round(v: number, places: number): number {
	const f = 10 ** places;
	return Math.round(v * f) / f;
}

const SAME_EPS = 0.01; // mil

function findSameTrack(snapshot: any, net: string, s: Seg, width: number): string | undefined {
	for (const l of snapshot.lines) {
		if (l.net !== net || Number(l.layer) !== s.layer || Math.abs(Number(l.lineWidth) - width) > SAME_EPS) continue;
		const fwd = Math.hypot(l.startX - s.startX, l.startY - s.startY) <= SAME_EPS && Math.hypot(l.endX - s.endX, l.endY - s.endY) <= SAME_EPS;
		const rev = Math.hypot(l.startX - s.endX, l.startY - s.endY) <= SAME_EPS && Math.hypot(l.endX - s.startX, l.endY - s.startY) <= SAME_EPS;
		if (fwd || rev) return l.primitiveId;
	}
	return undefined;
}

function findSameVia(snapshot: any, net: string, v: Via): string | undefined {
	for (const x of snapshot.vias) {
		if (x.net === net && Math.hypot(x.x - v.x, x.y - v.y) <= SAME_EPS && Math.abs(Number(x.diameter) - v.diameter) <= SAME_EPS) return x.primitiveId;
	}
	return undefined;
}

export const routePathHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.route.path': routePath,
};
