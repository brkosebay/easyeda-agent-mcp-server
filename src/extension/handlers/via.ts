import { envelopeStateArray, flattenState, flattenStateArray, mmToMil, normalizeLayer, normalizeViaType } from './_utils';
import { getSnapshot, invalidateSnapshot } from './board-context';
import { analyzeConnectivity, fetchArcs } from './net-connectivity';
import { checkTraceObstacles, pointToSegmentDistance } from './trace-obstacles';

export const viaHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.getAll.via': async (params) => {
		const all = await eda.pcb_PrimitiveVia.getAll(params.net, params.primitiveLock);
		return envelopeStateArray(all, params);
	},

	'pcb.get.via': async (params) => {
		const result = await eda.pcb_PrimitiveVia.get(params.primitiveIds);
		return Array.isArray(result) ? flattenStateArray(result) : flattenState(result);
	},

	'pcb.create.via': async (params) => {
		validateViaSize(params.holeDiameter, params.diameter);
		const via = await eda.pcb_PrimitiveVia.create(
			params.net,
			params.x,
			params.y,
			params.holeDiameter,
			params.diameter,
			normalizeViaType(params.viaType),
		);
		return flattenState(via);
	},

	'pcb.create.via.mm': async (params) => {
		const holeMil = round3(mmToMil(params.drill_mm));
		const diameterMil = round3(mmToMil(params.diameter_mm));
		const via = await eda.pcb_PrimitiveVia.create(
			params.net,
			params.x,
			params.y,
			holeMil,
			diameterMil,
			normalizeViaType(params.viaType),
		);
		const flat = flattenState(via);
		return { ...flat, holeDiameter_mil: holeMil, diameter_mil: diameterMil };
	},

	'pcb.modify.via': async (params) => {
		const property = { ...params.property };
		if (property.viaType != null) property.viaType = normalizeViaType(property.viaType);
		const result = await eda.pcb_PrimitiveVia.modify(params.primitiveId, property);
		// Verify by re-fetching — modify return may not reflect persisted state.
		const after = await eda.pcb_PrimitiveVia.get(params.primitiveId);
		return { modified: !!result, after: flattenState(after) };
	},

	'pcb.delete.via': async (params) => {
		return eda.pcb_PrimitiveVia.delete(params.ids);
	},

	'pcb.via.moveWithTracks': async (params) => moveViaWithTracks(params),
};

// ---------------------------------------------------------------------------
// pcb_move_via — move a via WITHOUT breaking its routes.
//
// Modifying a via's x/y moves the via alone: the tracks ending on it stay put
// and the net breaks (one session: "DRC went 20 → 48 … the route didn't
// follow"). This drags every same-net track end sitting on the via by the same
// delta, like dragging the via in the GUI, and proves the result:
//   1. preflight the moved legs and the via disc against different-net copper
//      with the board's DRC clearances (blocked → nothing changes);
//   2. commit via + track ends as one transaction, restoring the prior state on
//      any refusal or on a read-back that doesn't match (EasyEDA can no-op);
//   3. the net must not split into more pad groups than before, otherwise the
//      move is undone (keepOnVerifyFail:true keeps it).
// Every outcome returns the same shape.
// ---------------------------------------------------------------------------

const MIL_PER_MM = 39.37007874015748;
const MULTI_LAYER = 12;
const ANGLE_TOLERANCE_DEG = 0.5;
const MIN_LEG_MIL = 1;
const POS_EPS_MIL = 1e-3;
const DEFAULT_VIA_DIAMETER_MIL = 24;

interface Pt { x: number; y: number }
interface Issue { severity: 'error' | 'warning'; code: string; message: string; trackId?: string }
interface Drag { trackId: string; end: 'start' | 'end'; from: Pt; to: Pt; layer: number }
type Coords = { startX: number; startY: number; endX: number; endY: number };
/** One primitive this call modifies: only the keys it changes, before and after. */
interface Step { kind: 'via' | 'track'; id: string; prior: Record<string, number>; next: Record<string, number> }

async function moveViaWithTracks(params: Record<string, any>): Promise<any> {
	const units: 'mil' | 'mm' = params.units === 'mm' ? 'mm' : 'mil';
	const k = units === 'mm' ? MIL_PER_MM : 1;
	const dryRun = params.dryRun !== false;
	const dragTracks = params.dragTracks !== false;
	const viaId = String(params.viaId ?? params.primitiveId ?? '').trim();
	const target: Pt = { x: Number(params.x) * k, y: Number(params.y) * k };
	const issues: Issue[] = [];
	const err = (code: string, message: string, trackId?: string) => issues.push({ severity: 'error', code, message, trackId });
	const warn = (code: string, message: string, trackId?: string) => issues.push({ severity: 'warning', code, message, trackId });
	const u = (v: number) => round(v / k, 4);
	const upt = (p: Pt) => ({ x: u(p.x), y: u(p.y) });

	let from: Pt | undefined;
	let net: string | undefined;
	const drags: Drag[] = [];
	let obstacles: { blocking: any[]; warnings: any[] } = { blocking: [], warnings: [] };
	let clearance: any;
	const shape = (status: string, extra: Record<string, any> = {}) => ({
		status,
		units,
		dryRun,
		via: { id: viaId, net, from: from ? upt(from) : undefined, to: Number.isFinite(target.x) && Number.isFinite(target.y) ? upt(target) : undefined },
		dragged: drags.map((d) => ({ trackId: d.trackId, end: d.end, from: upt(d.from), to: upt(d.to), layer: d.layer })),
		warnings: issues.filter((i) => i.severity === 'warning'),
		errors: issues.some((i) => i.severity === 'error') ? issues.filter((i) => i.severity === 'error') : undefined,
		obstacles,
		clearance,
		verify: null as any,
		...extra,
	});

	// --- the via --------------------------------------------------------------
	if (!viaId) err('VIA_REQUIRED', 'Pass "viaId" (the via primitive id).');
	if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) err('BAD_TARGET', 'Pass numeric target "x" and "y".');
	if (issues.length) return shape('invalid', { note: 'Nothing was changed.' });

	const via = await readVia(viaId);
	if (!via) {
		err('VIA_NOT_FOUND', `Via "${viaId}" not found on the active PCB.`);
		return shape('invalid', { note: 'Nothing was changed.' });
	}
	// Copy the numbers: a plain-object read may be the live record.
	from = { x: Number(via.x), y: Number(via.y) };
	net = via.net != null && String(via.net).trim() !== '' ? String(via.net) : undefined;
	const radius = (Number(via.diameter) > 0 ? Number(via.diameter) : DEFAULT_VIA_DIAMETER_MIL) / 2;
	const delta = { x: target.x - from.x, y: target.y - from.y };
	if (via.primitiveLock) err('VIA_LOCKED', `Via ${viaId} is locked; unlock it first (pcb_modify_primitive type:"via", primitiveLock:false).`);
	if (Math.hypot(delta.x, delta.y) <= POS_EPS_MIL) err('ALREADY_AT_TARGET', `Via ${viaId} is already at (${u(target.x)}, ${u(target.y)}).`);
	if (issues.length) return shape('invalid', { note: 'Nothing was changed.' });

	// --- attached copper ------------------------------------------------------
	// Same-net copper tracks with an end inside the via (any layer: through via).
	// Copper layers only, so outline/silk lines are never dragged.
	const lines = flattenStateArray((await eda.pcb_PrimitiveLine.getAll(net, undefined, undefined)) as any[])
		.filter((l: any) => isCopperLayer(l.layer) && sameNet(l.net, net));
	const inside = (p: Pt) => Math.hypot(p.x - from!.x, p.y - from!.y) <= radius + 1e-6;
	const tracks: Array<{ id: string; layer: number; lineWidth: number; prior: Coords; next: Coords; moved: Array<'start' | 'end'> }> = [];
	for (const l of lines) {
		const id = String(l.primitiveId ?? l.id ?? '');
		const prior: Coords = { startX: Number(l.startX), startY: Number(l.startY), endX: Number(l.endX), endY: Number(l.endY) };
		if (!id || !Object.values(prior).every(Number.isFinite)) continue;
		const moved: Array<'start' | 'end'> = [];
		if (inside({ x: prior.startX, y: prior.startY })) moved.push('start');
		if (inside({ x: prior.endX, y: prior.endY })) moved.push('end');
		const lineWidth = Number(l.lineWidth) > 0 ? Number(l.lineWidth) : 10;
		if (!moved.length) {
			// A track running THROUGH the via (no end on it) cannot follow it.
			const d = pointToSegmentDistance(from, { x: prior.startX, y: prior.startY }, { x: prior.endX, y: prior.endY });
			if (d <= radius) warn('TRACK_THROUGH_VIA', `Track ${id} runs through the via without ending on it; it will not follow and the connection through it will break.`, id);
			continue;
		}
		if (!dragTracks) {
			warn('DETACHED', `Track ${id} ends on the via but dragTracks:false leaves it in place.`, id);
			continue;
		}
		if (l.primitiveLock) err('TRACK_LOCKED', `Track ${id} ends on the via but is locked; unlock it first.`, id);
		const next: Coords = { ...prior };
		if (moved.includes('start')) { next.startX += delta.x; next.startY += delta.y; }
		if (moved.includes('end')) { next.endX += delta.x; next.endY += delta.y; }
		const layer = Number(normalizeLayer(l.layer));
		tracks.push({ id, layer, lineWidth, prior, next, moved });
		for (const end of moved) {
			drags.push({
				trackId: id,
				end,
				layer,
				from: end === 'start' ? { x: prior.startX, y: prior.startY } : { x: prior.endX, y: prior.endY },
				to: end === 'start' ? { x: next.startX, y: next.startY } : { x: next.endX, y: next.endY },
			});
		}
		const len = Math.hypot(next.endX - next.startX, next.endY - next.startY);
		if (len < MIN_LEG_MIL) err('TOO_SHORT', `Track ${id} would shrink to ${u(len)} ${units}; move the via elsewhere or delete that leg first.`, id);
		else if (isOctilinear(prior) && !isOctilinear(next)) {
			warn('NOT_OCTILINEAR', `Track ${id} would run at ${round(angleDeg(next), 2)}° (no longer a multiple of 45°).`, id);
		}
	}
	// Arcs can't be dragged safely (moving one end reshapes the arc).
	const arcs = (await fetchArcs()).filter((a) => isCopperLayer(a.layer) && sameNet(a.net, net)
		&& (inside({ x: a.startX, y: a.startY }) || inside({ x: a.endX, y: a.endY })));
	for (const a of arcs) {
		if (dragTracks) err('ARC_ATTACHED', `Arc ${a.primitiveId} ends on the via and cannot be dragged; re-route it as tracks (or delete it) first.`, a.primitiveId);
		else warn('DETACHED', `Arc ${a.primitiveId} ends on the via and stays in place.`, a.primitiveId);
	}
	if (issues.some((i) => i.severity === 'error')) return shape('invalid', { note: 'Nothing was changed. Fix the errors listed and retry.' });

	// --- preflight ------------------------------------------------------------
	// The via disc goes on layer 12 AND on every copper layer: the checker only
	// fetches tracks for layers present in the segment list, so a layer-12 disc
	// alone would never see top/bottom/inner tracks with no dragged leg there.
	const discLayers = new Set<number>([MULTI_LAYER, 1, 2, ...tracks.map((t) => t.layer), ...(await innerCopperLayers())]);
	const diameter = radius * 2;
	const segments = [
		...tracks.map((t) => ({ net, layer: t.layer, ...t.next, lineWidth: t.lineWidth, role: `track:${t.id}` })),
		...[...discLayers].map((layer) => ({ net, layer, startX: target.x, startY: target.y, endX: target.x, endY: target.y, lineWidth: diameter, role: 'via' })),
	];
	let check: any;
	try {
		check = await checkTraceObstacles({
			segments,
			failOnObstacle: false,
			maxObstacles: params.maxObstacles ?? 200,
			clearanceMil: params.clearanceMil,
			obstacleCheckTimeoutMs: params.obstacleCheckTimeoutMs,
			ignorePrimitiveIds: [viaId, ...tracks.map((t) => t.id)],
		});
	} catch (e: any) {
		err('PREFLIGHT_FAILED', `Obstacle preflight failed: ${e?.message ?? e}`);
		return shape('blocked', { note: 'Nothing was changed: the move could not be checked for clearance.' });
	}
	obstacles = summarizeObstacles(check, k);
	clearance = check?.clearanceMil != null ? { mil: check.clearanceMil, source: check.clearanceSource } : undefined;
	if (obstacles.blocking.length) {
		return shape('blocked', { note: 'Nothing was changed. Each blocker names the moved item (via or track), the obstacle, the gap and the required clearance.' });
	}
	if (dryRun) return shape('dry-run', { note: 'The move is clear. Re-run with dryRun:false to commit it.' });

	// --- commit ---------------------------------------------------------------
	// The connectivity comparison needs two full snapshots; skip it (honestly)
	// rather than run past the caller's deadline into a gate quarantine.
	const deadlineAt = Number(params._gateDeadlineAt) || undefined;
	const timeLeft = () => (deadlineAt ? deadlineAt - Date.now() : Number.POSITIVE_INFINITY);
	const before = net && timeLeft() > CONNECTIVITY_MIN_MS * 2 ? await netGroups(net) : undefined;
	const steps: Step[] = [
		{ kind: 'via', id: viaId, prior: { x: from.x, y: from.y }, next: { x: target.x, y: target.y } },
		...tracks.map((t): Step => {
			const keys = t.moved.flatMap((end) => (end === 'start' ? ['startX', 'startY'] : ['endX', 'endY'])) as Array<keyof Coords>;
			return { kind: 'track', id: t.id, prior: pick(t.prior, keys), next: pick(t.next, keys) };
		}),
	];
	const touched: Step[] = [];
	let failedAt: any;
	for (const step of steps) {
		// Recorded BEFORE the call: a modify that throws or returns falsy may
		// still have applied, so it gets restored too.
		touched.push(step);
		try {
			if (!(await modifyStep(step, step.next))) failedAt = { kind: step.kind, id: step.id, error: 'EasyEDA returned no result for modify' };
		} catch (e: any) {
			failedAt = { kind: step.kind, id: step.id, error: String(e?.message ?? e) };
		}
		if (failedAt) break;
	}
	invalidateSnapshot();
	if (failedAt) {
		const rollback = await restore(touched);
		return shape(rollback.ok ? 'rolled-back' : 'partial', {
			failedAt,
			rollback,
			note: rollback.ok ? 'EasyEDA refused part of the move; everything was restored.' : 'EasyEDA refused part of the move and the restore was incomplete — see rollback.errors and fix those primitives by hand.',
		});
	}

	// Read back: EasyEDA can silently no-op a modify.
	const mismatches = await readBackMismatches(steps, 'next');
	if (mismatches.length) {
		const rollback = await restore(touched);
		invalidateSnapshot();
		return shape(rollback.ok ? 'rolled-back' : 'partial', {
			verify: { readBack: { ok: false, mismatches: mismatches.map((m) => ({ ...m, want: u(m.want), got: u(m.got) })) } },
			rollback,
			note: rollback.ok ? 'EasyEDA did not persist the whole move (read-back mismatch); everything was restored.' : 'Read-back mismatch and the restore was incomplete — see rollback.errors.',
		});
	}

	// Connectivity must not get worse: no more pad groups than before.
	let connectivity: any = { skipped: net ? 'deadline: not enough time left in this call to compare connectivity — check with pcb_connectivity_status' : 'the via has no net' };
	if (net && before && timeLeft() > CONNECTIVITY_MIN_MS) {
		const after = await netGroups(net);
		const ok = after.padGroups <= before.padGroups;
		connectivity = {
			net,
			ok,
			before,
			after,
			reason: ok ? undefined : `the move split "${net}" from ${before.padGroups} into ${after.padGroups} pad group(s)`,
		};
	}
	const verify = { readBack: { ok: true }, connectivity };
	if (connectivity.ok === false && params.keepOnVerifyFail !== true) {
		const rollback = await restore(touched);
		invalidateSnapshot();
		return shape(rollback.ok ? 'rolled-back' : 'partial', {
			verify,
			rollback,
			note: rollback.ok ? 'Moved, failed the connectivity check, and was restored (pass keepOnVerifyFail:true to keep it).' : 'Connectivity check failed and the restore was incomplete — see rollback.errors.',
		});
	}
	if (connectivity.ok === false) warn('VERIFY_FAILED_KEPT', `Kept despite the connectivity check: ${connectivity.reason}.`);
	return shape('moved', { verify, note: 'Copper changed: repour (pcb_repour_all) and run DRC when you finish this batch of edits.' });
}

async function readVia(id: string): Promise<any | undefined> {
	const one = await eda.pcb_PrimitiveVia.get(id).catch(() => undefined);
	const flat = Array.isArray(one) ? flattenStateArray(one)[0] : flattenState(one);
	if (flat && typeof flat === 'object') return flat;
	const all = flattenStateArray((await eda.pcb_PrimitiveVia.getAll(undefined, undefined).catch(() => [])) as any[]);
	return all.find((v: any) => String(v.primitiveId ?? v.id) === id);
}

async function readLine(id: string): Promise<any | undefined> {
	const one = await eda.pcb_PrimitiveLine.get(id).catch(() => undefined);
	return Array.isArray(one) ? flattenStateArray(one)[0] : flattenState(one);
}

async function modifyStep(step: Step, props: Record<string, number>): Promise<boolean> {
	const result = step.kind === 'via'
		? await eda.pcb_PrimitiveVia.modify(step.id, props)
		: await eda.pcb_PrimitiveLine.modify(step.id, props);
	return !!result;
}

async function readBackMismatches(steps: Step[], which: 'prior' | 'next'): Promise<Array<{ kind: string; id: string; key: string; want: number; got: number }>> {
	const out: Array<{ kind: string; id: string; key: string; want: number; got: number }> = [];
	for (const step of steps) {
		const flat = step.kind === 'via' ? await readVia(step.id) : await readLine(step.id);
		for (const [key, want] of Object.entries(step[which])) {
			const got = Number(flat?.[key]);
			if (!(Math.abs(got - want) <= POS_EPS_MIL)) out.push({ kind: step.kind, id: step.id, key, want, got });
		}
	}
	return out;
}

/** Put every touched primitive back (newest first), then prove it by read-back. */
async function restore(touched: Step[]): Promise<{ ok: boolean; errors?: string[] }> {
	const errors: string[] = [];
	for (const step of [...touched].reverse()) {
		// A primitive EasyEDA refused never changed; re-modifying it would
		// likely be refused again and report a failed restore for nothing.
		if (!(await readBackMismatches([step], 'prior')).length) continue;
		try {
			if (!(await modifyStep(step, step.prior))) errors.push(`${step.kind} ${step.id}: modify returned no result`);
		} catch (e: any) {
			errors.push(`${step.kind} ${step.id}: ${e?.message ?? e}`);
		}
	}
	for (const m of await readBackMismatches(touched, 'prior')) {
		errors.push(`${m.kind} ${m.id}: ${m.key} is ${m.got}, expected ${m.want}`);
	}
	return errors.length ? { ok: false, errors } : { ok: true };
}

async function netGroups(net: string): Promise<{ status?: string; padGroups: number; pads: number }> {
	const snapshot = await getSnapshot({ forceRefresh: true });
	const arcs = await fetchArcs();
	const [n] = analyzeConnectivity({ ...snapshot, arcs }, [net]);
	const pads = n?.pads ?? 0;
	// padGroups is only listed when there is more than one group.
	return { status: n?.status, padGroups: n?.padGroups?.length ?? (pads > 0 ? 1 : 0), pads };
}

async function innerCopperLayers(): Promise<number[]> {
	const rows = await eda.pcb_Layer.getAllLayers().catch(() => []);
	return (Array.isArray(rows) ? rows : [])
		.map((l: any) => ({ id: Number(l?.id), status: Number(l?.layerStatus) }))
		.filter((l) => l.id >= 15 && l.id <= 44 && l.status !== 0)
		.map((l) => l.id);
}

function summarizeObstacles(check: any, k: number): { blocking: any[]; warnings: any[] } {
	const list: any[] = Array.isArray(check?.obstacles) ? check.obstacles : [];
	const u = (v: number) => round(v / k, 4);
	const brief = (o: any) => {
		const role = String(o.routeSegment?.role ?? '');
		return {
			on: role === 'via' ? 'via' : role.startsWith('track:') ? `track ${role.slice(6)}` : role || undefined,
			type: o.type,
			net: o.net,
			layer: o.layer,
			primitiveId: o.primitiveId,
			reference: o.reference,
			padNumber: o.padNumber,
			gap: o.distanceMil != null ? u(o.distanceMil) : undefined,
			required: o.clearanceRequiredMil != null ? u(o.clearanceRequiredMil) : undefined,
			clearanceSource: o.clearanceSource,
			at: o.point ? [u(o.point.x), u(o.point.y)] : undefined,
			reason: o.reason,
			planeCut: o.planeCut || undefined,
		};
	};
	// The via disc is checked once per copper layer; report each obstacle once
	// per moved item (and each crossed pour once).
	const dedupe = (items: any[]) => {
		const seen = new Set<string>();
		return items.filter((b) => {
			const key = b.planeCut ? `pour|${b.primitiveId}` : [b.on, b.type, b.primitiveId, b.reference, b.padNumber, b.reason].join('|');
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	};
	return {
		blocking: dedupe(list.filter((o) => o.severity === 'blocker').map(brief)),
		warnings: dedupe(list.filter((o) => o.severity !== 'blocker').map(brief)),
	};
}

function isCopperLayer(layer: unknown): boolean {
	let n: number;
	try { n = Number(normalizeLayer(layer as any)); } catch { return false; }
	return n === 1 || n === 2 || (n >= 15 && n <= 44);
}

function sameNet(a: unknown, b: string | undefined): boolean {
	const aa = a != null && String(a).trim() !== '' ? String(a) : undefined;
	return aa === b;
}

function angleDeg(c: Coords): number {
	return (Math.atan2(c.endY - c.startY, c.endX - c.startX) * 180) / Math.PI;
}

function isOctilinear(c: Coords): boolean {
	if (Math.hypot(c.endX - c.startX, c.endY - c.startY) < 1e-6) return true;
	const deg = angleDeg(c);
	return Math.abs(deg - Math.round(deg / 45) * 45) <= ANGLE_TOLERANCE_DEG;
}

function pick(c: Coords, keys: Array<keyof Coords>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const key of keys) out[key] = c[key];
	return out;
}

function round(v: number, places: number): number {
	const f = 10 ** places;
	return Math.round(v * f) / f;
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

// EasyEDA's via API uses MIL. Anything under ~3 mil is almost certainly the
// caller passing mm by mistake (0.3 mm pad → reads back as 0/0 because the
// runtime rounds tiny mil values to integers). Reject early with a clear hint.
function validateViaSize(holeMil: number, diameterMil: number): void {
	if (typeof holeMil !== 'number' || !Number.isFinite(holeMil) || holeMil <= 0) {
		throw new Error('holeDiameter must be a positive number in mil. Use pcb_create_via_mm for mm input.');
	}
	if (typeof diameterMil !== 'number' || !Number.isFinite(diameterMil) || diameterMil <= 0) {
		throw new Error('diameter must be a positive number in mil. Use pcb_create_via_mm for mm input.');
	}
	if (diameterMil < 6 || holeMil < 4) {
		throw new Error(
			`Via dimensions too small: hole=${holeMil} mil, diameter=${diameterMil} mil. ` +
			`EasyEDA's via API uses mil (1 mm ≈ 39.37 mil). Sub-3-mil values typically mean ` +
			`mm was passed by mistake — use pcb_create_via_mm({drill_mm, diameter_mm}) for mm.`,
		);
	}
	if (diameterMil <= holeMil) {
		throw new Error(
			`diameter (${diameterMil} mil) must be greater than holeDiameter (${holeMil} mil) — ` +
			`otherwise there is no annular ring and DRC will reject the via.`,
		);
	}
}

// Time one board snapshot + copper-graph pass needs before the caller's deadline.
const CONNECTIVITY_MIN_MS = 6_000;
