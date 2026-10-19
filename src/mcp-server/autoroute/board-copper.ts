// Board-side steps around a routed import: delete a net's copper, keep a copy
// of it to put back, and compare EasyEDA's DRC before and after.
//
// EasyEDA's DRC is the reference for "did the import make the board worse".
// fastroute checks its own result against the rules in the DSN, which leave out
// what the DSN cannot say (pour islands after a re-pour, slot clearances, pads
// that only touch), so a reroute is verified on the board and the nets that
// broke something are put back as they were.

import type { WebSocketBridge } from '../bridge';

type Params = Record<string, unknown>;

function listOf(res: any): any[] {
	return Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Delete the unlocked tracks, arcs and vias of `nets` (a reroute replaces
 * their copper). Locked copper is left alone; reroute modes never pick nets
 * that have any.
 */
export async function deleteNetCopper(
	bridge: WebSocketBridge,
	routingParams: Params,
	nets: string[],
): Promise<{ nets: number; tracks: number; arcs: number; vias: number; errors: string[] }> {
	const out = { nets: nets.length, tracks: 0, arcs: 0, vias: 0, errors: [] as string[] };
	for (const net of nets) {
		try {
			const r: any = await bridge.send('pcb.deleteByFilter.line', { ...routingParams, net, preserveLocked: true, _timeoutMs: 30_000 });
			out.tracks += Number(r?.deletedCount ?? 0);
		} catch (err: any) { out.errors.push(`${net} tracks: ${errText(err)}`); }
		for (const [kind, getter, deleter] of [['arcs', 'pcb.getAll.arc', 'pcb.delete.arc'], ['vias', 'pcb.getAll.via', 'pcb.delete.via']] as const) {
			try {
				const ids = listOf(await bridge.send(getter, { ...routingParams, net, limit: 1_000_000, fields: ['primitiveId', 'primitiveLock', 'net'], _timeoutMs: 30_000 }))
					.filter((it: any) => it?.primitiveId && it.primitiveLock !== true && (it.net == null || it.net === net))
					.map((it: any) => String(it.primitiveId));
				if (ids.length) {
					const ok = await bridge.send(deleter, { ...routingParams, ids, _timeoutMs: 30_000 });
					if (ok !== false) out[kind] += ids.length;
				}
			} catch (err: any) { out.errors.push(`${net} ${kind}: ${errText(err)}`); }
		}
	}
	return out;
}

/**
 * EasyEDA does not update a net's connectivity for tracks created through the
 * API until a primitive of that net is edited: DRC reports every pad of the net
 * as disconnected even where the copper overlaps. A same-width modify of one
 * track per net makes it recompute.
 */
export async function refreshNetConnectivity(
	bridge: WebSocketBridge,
	routingParams: Params,
	nets: string[],
): Promise<{ nets: number; refreshed: number; errors: string[] }> {
	const out = { nets: nets.length, refreshed: 0, errors: [] as string[] };
	for (const net of nets) {
		try {
			const res: any = await bridge.send('pcb.getAll.line', { ...routingParams, net, limit: 1, fields: ['primitiveId', 'lineWidth'], _timeoutMs: 15_000 });
			const line = listOf(res)[0];
			if (!line?.primitiveId) continue;
			await bridge.send('pcb.modify.line', { ...routingParams, primitiveId: line.primitiveId, property: { lineWidth: line.lineWidth }, _timeoutMs: 15_000 });
			out.refreshed++;
		} catch (err: any) {
			out.errors.push(`${net}: ${errText(err)}`);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Snapshot / restore
// ---------------------------------------------------------------------------

export interface CopperSnapshot {
	nets: string[];
	lines: Array<{ net: string; layer: unknown; startX: number; startY: number; endX: number; endY: number; lineWidth: number }>;
	arcs: Array<{ net: string; layer: unknown; startX: number; startY: number; endX: number; endY: number; arcAngle: number; lineWidth: number }>;
	vias: Array<{ net: string; x: number; y: number; holeDiameter: number; diameter: number; viaType?: unknown }>;
	errors: string[];
}

/** The unlocked tracks, arcs and vias of `nets`, as they are now (what deleteNetCopper removes). */
export async function snapshotNetCopper(bridge: WebSocketBridge, routingParams: Params, nets: string[]): Promise<CopperSnapshot> {
	const snap: CopperSnapshot = { nets: [...nets], lines: [], arcs: [], vias: [], errors: [] };
	const num = (v: unknown) => Number(v);
	for (const net of nets) {
		const get = async (method: string) => {
			try {
				return listOf(await bridge.send(method, { ...routingParams, net, limit: 1_000_000, _timeoutMs: 30_000 }))
					.filter((it: any) => it && it.primitiveLock !== true && (it.net == null || it.net === net));
			} catch (err: any) {
				snap.errors.push(`${net} ${method}: ${errText(err)}`);
				return [];
			}
		};
		for (const l of await get('pcb.getAll.line')) {
			const v = { net, layer: l.layer, startX: num(l.startX), startY: num(l.startY), endX: num(l.endX), endY: num(l.endY), lineWidth: num(l.lineWidth) };
			if ([v.startX, v.startY, v.endX, v.endY, v.lineWidth].every(Number.isFinite)) snap.lines.push(v);
			else snap.errors.push(`${net}: track ${l.primitiveId} has no readable geometry`);
		}
		for (const a of await get('pcb.getAll.arc')) {
			const v = { net, layer: a.layer, startX: num(a.startX), startY: num(a.startY), endX: num(a.endX), endY: num(a.endY), arcAngle: num(a.arcAngle), lineWidth: num(a.lineWidth) };
			if ([v.startX, v.startY, v.endX, v.endY, v.arcAngle, v.lineWidth].every(Number.isFinite)) snap.arcs.push(v);
			else snap.errors.push(`${net}: arc ${a.primitiveId} has no readable geometry`);
		}
		for (const d of await get('pcb.getAll.via')) {
			const v = { net, x: num(d.x), y: num(d.y), holeDiameter: num(d.holeDiameter), diameter: num(d.diameter), ...(d.viaType != null ? { viaType: d.viaType } : {}) };
			if ([v.x, v.y, v.holeDiameter, v.diameter].every(Number.isFinite)) snap.vias.push(v);
			else snap.errors.push(`${net}: via ${d.primitiveId} has no readable geometry`);
		}
	}
	return snap;
}

/** Replace the copper of `nets` with what `snap` holds for them (delete, then recreate). */
export async function restoreNetCopper(
	bridge: WebSocketBridge,
	routingParams: Params,
	snap: CopperSnapshot,
	nets: string[],
): Promise<{ nets: string[]; removed: Awaited<ReturnType<typeof deleteNetCopper>>; tracks: number; arcs: number; vias: number; errors: string[] }> {
	const want = new Set(nets);
	const removed = await deleteNetCopper(bridge, routingParams, nets);
	const errors: string[] = [];
	const ops = [
		...snap.lines.filter((l) => want.has(l.net)).map((l) => ({ type: 'create_track', net: l.net, layer: l.layer, startX: l.startX, startY: l.startY, endX: l.endX, endY: l.endY, lineWidth: l.lineWidth })),
		...snap.vias.filter((v) => want.has(v.net)).map((v) => ({ type: 'create_via', net: v.net, x: v.x, y: v.y, diameter: v.diameter, holeDiameter: v.holeDiameter, viaType: v.viaType ?? 'Through' })),
	];
	let tracks = 0;
	let vias = 0;
	for (let i = 0; i < ops.length; i += 75) {
		try {
			const r: any = await bridge.send('pcb.manufacture.commitSesRoutesDirect', {
				...routingParams, operations: ops.slice(i, i + 75), dryRun: false, onError: 'continue', maxResultIds: 0, perOperationTimeoutMs: 1500, _timeoutMs: 60_000,
			});
			tracks += Number(r?.createdTracks ?? 0);
			vias += Number(r?.createdVias ?? 0);
			for (const e of Array.isArray(r?.errors) ? r.errors : []) errors.push(`${e?.net ?? '?'} ${e?.type ?? ''}: ${e?.error ?? JSON.stringify(e)}`);
		} catch (err: any) { errors.push(`restore chunk ${i / 75}: ${errText(err)}`); }
	}
	let arcs = 0;
	for (const a of snap.arcs.filter((x) => want.has(x.net))) {
		try {
			await bridge.send('pcb.create.arc', { ...routingParams, ...a, _timeoutMs: 15_000 });
			arcs++;
		} catch (err: any) { errors.push(`${a.net} arc: ${errText(err)}`); }
	}
	const refresh = await refreshNetConnectivity(bridge, routingParams, nets);
	errors.push(...refresh.errors);
	return { nets, removed, tracks, arcs, vias, errors };
}

// ---------------------------------------------------------------------------
// DRC before / after
// ---------------------------------------------------------------------------

export interface DrcViolation {
	key: string;
	category: string;
	fixCategory?: string;
	nets: string[];
	message?: string;
	location?: { x: number; y: number; layer?: unknown };
}

export interface DrcSnapshot {
	total: number;
	violations: DrcViolation[];
	error?: string;
}

/** EasyEDA's DRC, reduced to comparable rows (key = category + nets + position on a 5 mil grid). */
export async function drcSnapshot(bridge: WebSocketBridge, routingParams: Params, timeoutMs = 5 * 60_000): Promise<DrcSnapshot> {
	try {
		const res: any = await bridge.send('pcb.drc.violationsDetailed', { ...routingParams, maxViolations: 5000, _timeoutMs: timeoutMs });
		const violations: DrcViolation[] = (Array.isArray(res?.violations) ? res.violations : []).map((v: any) => {
			const nets = (Array.isArray(v?.nets) ? v.nets : []).map(String).filter(Boolean).sort();
			const x = Number(v?.location?.x);
			const y = Number(v?.location?.y);
			const location = Number.isFinite(x) && Number.isFinite(y) ? { x, y, ...(v.location.layer != null ? { layer: v.location.layer } : {}) } : undefined;
			const category = String(v?.category ?? 'unknown');
			const where = location ? `${Math.round(location.x / 5)}|${Math.round(location.y / 5)}` : `#${(v?.primitiveIds ?? []).slice().sort().join(',')}`;
			return {
				key: `${category}|${nets.join(',')}|${where}`,
				category,
				...(v?.fixCategory ? { fixCategory: String(v.fixCategory) } : {}),
				nets,
				...(v?.message ? { message: String(v.message).slice(0, 200) } : {}),
				...(location ? { location } : {}),
			};
		});
		return { total: Number(res?.totalViolations ?? violations.length), violations };
	} catch (err: any) {
		return { total: -1, violations: [], error: errText(err) };
	}
}

/** Violations in `after` that `before` did not have (multiset difference by key). */
export function newViolations(before: DrcSnapshot, after: DrcSnapshot): DrcViolation[] {
	const left = new Map<string, number>();
	for (const v of before.violations) left.set(v.key, (left.get(v.key) ?? 0) + 1);
	const out: DrcViolation[] = [];
	for (const v of after.violations) {
		const n = left.get(v.key) ?? 0;
		if (n > 0) left.set(v.key, n - 1);
		else out.push(v);
	}
	return out;
}

/** Nets EasyEDA reports as not fully connected. */
export function incompleteNets(drc: DrcSnapshot): Set<string> {
	const out = new Set<string>();
	for (const v of drc.violations) {
		if (v.fixCategory ? v.fixCategory === 'route_missing_connection' : /connect|unrout|ratline/i.test(`${v.category} ${v.message ?? ''}`)) {
			for (const n of v.nets) out.add(n);
		}
	}
	return out;
}

export function summarizeViolations(vs: DrcViolation[], max = 30): Record<string, unknown> {
	const byCategory: Record<string, number> = {};
	for (const v of vs) byCategory[v.category] = (byCategory[v.category] ?? 0) + 1;
	return { count: vs.length, byCategory, sample: vs.slice(0, max).map((v) => ({ category: v.category, nets: v.nets, ...(v.message ? { message: v.message } : {}), ...(v.location ? { location: v.location } : {}) })) };
}
