// Pure pieces of the native autorouter harness (native-autoroute.ts): argument
// coercion into the runtime's IPCB_AutoRoutingProps, an order-independent
// signature of the board's copper (or component positions), the completion
// state machine that decides when a never-awaited autoRouting()/autoLayout()
// call is done, and connectivity before/after diffs. No `eda` access here, so
// scripts/native-autoroute-smoke.ts drives it directly.

import { normalizeLayer } from './_utils';

// Mirrors pro-api 0.3.50 api-types.d.ts (EasyEDA Pro 3.2.150+). The npm types
// we compile against (0.2.34) have none of this.
export interface AutoRoutingProps {
	RoutingNets?: 'selected' | 'selectedComponents' | string[];
	/** EPCB_AutoRoutingCornerStyle: 0 = 45°, 1 = 90° */
	cornerStyle?: 0 | 1;
	/** EPCB_AutoRoutingExistingPrimitiveMode */
	existingPrimitiveMode?: 'keep' | 'remove';
	/** EPCB_AutoRoutingOptimization: 1 = completion, 0 = faster */
	optimization?: 0 | 1;
	layers?: number[];
	ignoreNets?: string[];
}
export interface AutoRoutingResult { success: boolean; totalNetsCount: number; successNetsCount: number; failedNets: string[]; duration: number }
export interface AutoLayoutResult { success: boolean; totalComponentsCount: number; successComponentsCount: number; failedComponents: string[]; duration: number }

export type AutoJobKind = 'route' | 'layout';
export type AutoJobStatus = 'running' | 'completed' | 'quiet' | 'no-change' | 'deadline' | 'failed' | 'sdk-unresponsive' | 'document-changed' | 'unsupported';

const COPPER_LAYERS = new Set<number>([1, 2, ...Array.from({ length: 30 }, (_, i) => 15 + i)]);

function stringList(value: unknown, name: string): string[] | undefined {
	if (value == null) return undefined;
	if (!Array.isArray(value)) throw new Error(`${name} must be an array of net names.`);
	const out = value.map((v) => String(v ?? '').trim()).filter(Boolean);
	return out.length ? Array.from(new Set(out)) : undefined;
}

/**
 * MCP arguments → IPCB_AutoRoutingProps. Selection modes are refused: every
 * pcb.* write runs inside the selection guard, which clears the GUI selection
 * before the handler starts, so "selected" would route an empty set.
 */
export function buildAutoRoutingProps(params: Record<string, any> = {}): { props: AutoRoutingProps; warnings: string[] } {
	const warnings: string[] = [];
	const props: AutoRoutingProps = {};
	if (typeof params.nets === 'string') {
		throw new Error(`nets:"${params.nets}" is not supported: the bridge clears the GUI selection before every write. Pass the net names to route, or omit nets to route every unrouted net.`);
	}
	const nets = stringList(params.nets, 'nets');
	if (nets) props.RoutingNets = nets;
	const ignore = stringList(params.ignoreNets, 'ignoreNets');
	if (ignore) props.ignoreNets = ignore;
	if (nets && ignore) {
		const overlap = nets.filter((n) => ignore.includes(n));
		if (overlap.length) warnings.push(`nets and ignoreNets both list ${overlap.join(', ')}; EasyEDA decides which wins.`);
	}

	if (params.layers != null) {
		if (!Array.isArray(params.layers) || params.layers.length === 0) throw new Error('layers must be a non-empty array of copper layers (e.g. ["TopLayer","BottomLayer"] or [1,2]).');
		const layers = params.layers.map((l: unknown) => normalizeLayer(l));
		for (const [i, id] of layers.entries()) {
			if (typeof id !== 'number' || !COPPER_LAYERS.has(id)) throw new Error(`layers[${i}] (${String(params.layers[i])}) is not a copper layer. Use 1=Top, 2=Bottom, 15..44=Inner1..30.`);
		}
		props.layers = Array.from(new Set<number>(layers));
	}

	if (params.corner != null) {
		const c = String(params.corner).trim().toLowerCase().replace(/°|deg(ree)?s?/g, '');
		if (c === '45') props.cornerStyle = 0;
		else if (c === '90') props.cornerStyle = 1;
		else throw new Error(`corner must be "45" or "90" (got ${String(params.corner)}).`);
	}
	if (params.optimization != null) {
		const o = String(params.optimization).trim().toLowerCase();
		if (o === 'completion') props.optimization = 1;
		else if (o === 'faster' || o === 'speed') props.optimization = 0;
		else throw new Error(`optimization must be "completion" or "faster" (got ${String(params.optimization)}).`);
	}
	if (params.ripUpExisting === true) {
		props.existingPrimitiveMode = 'remove';
		warnings.push('ripUpExisting: EasyEDA removes ALL existing tracks and vias before routing (existingPrimitiveMode "remove").');
	} else {
		props.existingPrimitiveMode = 'keep';
	}
	return { props, warnings };
}

// ---------------------------------------------------------------------------
// Signatures: detect any change, not just count changes (a rip-up-and-reroute
// can keep the count identical).
// ---------------------------------------------------------------------------

function fnv1a(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/** Order-independent fingerprint of a set of strings. */
export function setFingerprint(items: Iterable<string>): { count: number; hash: string } {
	let count = 0;
	let sum = 0;
	let xor = 0;
	for (const item of items) {
		const h = fnv1a(item);
		sum = (sum + h) >>> 0;
		xor = (xor ^ h) >>> 0;
		count++;
	}
	return { count, hash: `${sum.toString(16)}.${xor.toString(16)}` };
}

export interface CopperCounts { lines: number; vias: number; arcs: number }

export function copperSignature(ids: { lines: string[]; vias: string[]; arcs: string[] }): { counts: CopperCounts; signature: string } {
	const l = setFingerprint(ids.lines);
	const v = setFingerprint(ids.vias);
	const a = setFingerprint(ids.arcs);
	return { counts: { lines: l.count, vias: v.count, arcs: a.count }, signature: `L${l.count}:${l.hash}|V${v.count}:${v.hash}|A${a.count}:${a.hash}` };
}

export interface ComponentPose { id: string; designator?: string; x: number; y: number; rotation?: number; layer?: unknown }

export function layoutSignature(poses: ComponentPose[]): string {
	const f = setFingerprint(poses.map((p) => `${p.id}@${round2(p.x)},${round2(p.y)},${round2(p.rotation ?? 0)},${String(p.layer ?? '')}`));
	return `C${f.count}:${f.hash}`;
}

export function diffPoses(before: ComponentPose[], after: ComponentPose[], sampleLimit = 15): { total: number; moved: number; sample: Array<{ id: string; designator?: string; from: [number, number, number]; to: [number, number, number] }> } {
	const prior = new Map(before.map((p) => [p.id, p]));
	const sample: Array<{ id: string; designator?: string; from: [number, number, number]; to: [number, number, number] }> = [];
	let moved = 0;
	for (const p of after) {
		const b = prior.get(p.id);
		if (!b) continue;
		if (round2(b.x) !== round2(p.x) || round2(b.y) !== round2(p.y) || round2(b.rotation ?? 0) !== round2(p.rotation ?? 0) || String(b.layer ?? '') !== String(p.layer ?? '')) {
			moved++;
			if (sample.length < sampleLimit) sample.push({ id: p.id, designator: p.designator, from: [round2(b.x), round2(b.y), round2(b.rotation ?? 0)], to: [round2(p.x), round2(p.y), round2(p.rotation ?? 0)] });
		}
	}
	return { total: after.length, moved, sample };
}

function round2(n: number): number {
	return Math.round(Number(n) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Completion state machine
// ---------------------------------------------------------------------------
//
// The autoRouting() promise is observed, never awaited (canvas-tick SDK
// promises can stay pending forever while awaited). Its documented result
// (`success` = "started successfully") disagrees with the doc example
// (`routedNets/totalNets`), so a resolved promise may be an ACK, not
// completion. It ends the job only if its value is a report (counts,
// failed list, duration) or it resolved after the copper started changing;
// otherwise completion is "quiet": copper changed, then stopped changing.
// EasyEDA may also stop answering polls while it routes; silence alone is
// never terminal before the deadline.

export type PromiseState = 'pending' | 'resolved' | 'rejected' | 'not-a-promise';

export interface ProgressState {
	dispatchedAt: number;
	baseline?: string;
	last?: string;
	firstChangeAt?: number;
	lastChangeAt?: number;
	/** Consecutive answered polls with the same signature since the last change. */
	stablePolls: number;
	lastOkAt: number;
	answered: number;
	missed: number;
	/** Polls EasyEDA answered with an error (alive, but no signature). */
	errored: number;
	maxSilentMs: number;
	promise: PromiseState;
	promiseSettledAt?: number;
	/** The settled value carries a routing/layout report (counts, failed list, duration), not just an ack. */
	promiseReport?: boolean;
}

export interface CompletionConfig {
	/** Copper changed, promise still pending: stable this long ⇒ "quiet". */
	quietMs: number;
	/** Identical answered polls also required for "quiet". */
	settlePolls: number;
	/** Promise resolved but copper unchanged: wait this long before "completed". */
	promiseGraceMs: number;
	/** Polling stops here. */
	deadlineAt: number;
	/** At the deadline, silent this long ⇒ "sdk-unresponsive" rather than "deadline"/"no-change". */
	unresponsiveMs: number;
}

export function createProgress(dispatchedAt: number, baseline: string | undefined): ProgressState {
	return { dispatchedAt, baseline, last: baseline, stablePolls: 0, lastOkAt: dispatchedAt, answered: 0, missed: 0, errored: 0, maxSilentMs: 0, promise: 'pending' };
}

/** Feed one poll result (`undefined` = the poll was not answered in time). */
export function observe(state: ProgressState, at: number, signature: string | undefined): void {
	if (signature === undefined) {
		state.missed++;
		state.maxSilentMs = Math.max(state.maxSilentMs, at - state.lastOkAt);
		return;
	}
	state.answered++;
	state.maxSilentMs = Math.max(state.maxSilentMs, at - state.lastOkAt);
	state.lastOkAt = at;
	if (state.baseline === undefined) state.baseline = signature;
	if (state.last !== undefined && signature !== state.last) {
		state.firstChangeAt ??= at;
		state.lastChangeAt = at;
		state.stablePolls = 0;
	} else if (state.firstChangeAt !== undefined) {
		state.stablePolls++;
	}
	state.last = signature;
}

/** The poll was answered with an error: EasyEDA is alive, but there is no signature. */
export function observeAlive(state: ProgressState, at: number): void {
	state.errored++;
	state.maxSilentMs = Math.max(state.maxSilentMs, at - state.lastOkAt);
	state.lastOkAt = at;
}

export function settlePromise(state: ProgressState, outcome: 'resolved' | 'rejected' | 'not-a-promise', at: number, report = false): void {
	if (state.promise !== 'pending') return;
	state.promise = outcome;
	state.promiseSettledAt = at;
	state.promiseReport = report;
}

/**
 * A resolved promise counts as completion when its value is a report, or
 * when it resolved after the copper started changing. A bare ack that
 * resolved before any change proves nothing about the routing itself.
 */
export function promiseMeansDone(state: ProgressState): boolean {
	if (state.promise !== 'resolved' && state.promise !== 'not-a-promise') return false;
	if (state.promiseReport) return true;
	return state.firstChangeAt !== undefined && (state.promiseSettledAt ?? 0) >= state.firstChangeAt;
}

/** Copper differs from the pre-dispatch baseline (a change that was reverted counts as none). */
export function changedFromBaseline(state: ProgressState): boolean {
	return state.firstChangeAt !== undefined && state.last !== state.baseline;
}

export function decide(state: ProgressState, now: number, cfg: CompletionConfig): AutoJobStatus {
	if (state.promise === 'rejected') return 'failed';
	const changed = state.firstChangeAt !== undefined;
	if (promiseMeansDone(state)) {
		if (changed && state.stablePolls >= 1) return 'completed';
		// A report with no copper change (nothing to route, or every net failed):
		// give a late commit a grace period to show up.
		if (!changed && now - (state.promiseSettledAt ?? now) >= cfg.promiseGraceMs) return 'completed';
	}
	if (changed && state.stablePolls >= cfg.settlePolls && now - (state.lastChangeAt ?? now) >= cfg.quietMs) return 'quiet';
	if (now >= cfg.deadlineAt) {
		if (now - state.lastOkAt >= cfg.unresponsiveMs) return 'sdk-unresponsive';
		return changed ? 'deadline' : 'no-change';
	}
	return 'running';
}

// ---------------------------------------------------------------------------
// Settled value + connectivity diffs
// ---------------------------------------------------------------------------

export interface SettledValue { type: string; keys?: string[]; json?: string }

/** Raw record of whatever the promise settled with — the runtime's real shape is unverified. */
export function describeSettledValue(value: unknown, maxJson = 1500): SettledValue {
	const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
	const out: SettledValue = { type };
	if (value && typeof value === 'object') out.keys = Object.keys(value as object).slice(0, 40);
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) out.json = json.length > maxJson ? `${json.slice(0, maxJson)}…(${json.length} chars)` : json;
	} catch (err: any) {
		out.json = `<unserializable: ${err?.message ?? String(err)}>`;
	}
	return out;
}

/** Pull the documented fields out of the settled value, if they are there. */
export function routingResultFields(value: unknown): Partial<AutoRoutingResult> & { routedNets?: number; totalNets?: number } | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const v = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of ['success', 'totalNetsCount', 'successNetsCount', 'duration', 'routedNets', 'totalNets']) if (v[k] !== undefined) out[k] = v[k];
	if (Array.isArray(v.failedNets)) out.failedNets = (v.failedNets as unknown[]).map(String);
	return Object.keys(out).length ? out as any : undefined;
}

/** The settled value reports an outcome (not just `true` / `{success}`). */
export function isAutoReport(kind: AutoJobKind, value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	const keys = kind === 'route'
		? ['totalNetsCount', 'successNetsCount', 'failedNets', 'duration', 'routedNets', 'totalNets']
		: ['totalComponentsCount', 'successComponentsCount', 'failedComponents', 'duration'];
	return keys.some((k) => v[k] !== undefined);
}

export interface NetStatusLike { net: string; status: string }

export interface ConnectivitySummary {
	netCount: number;
	counts: Record<string, number>;
	/** Nets with pads to join (single_pad excluded). */
	routable: number;
	connected: number;
	open: string[];
}

export function summarizeConnectivity(nets: NetStatusLike[], openLimit = 40): ConnectivitySummary {
	const counts: Record<string, number> = {};
	for (const n of nets) counts[n.status] = (counts[n.status] ?? 0) + 1;
	const open = nets.filter((n) => n.status !== 'connected' && n.status !== 'single_pad').map((n) => n.net).sort();
	return {
		netCount: nets.length,
		counts,
		routable: nets.filter((n) => n.status !== 'single_pad').length,
		connected: counts.connected ?? 0,
		open: open.slice(0, openLimit),
	};
}

export function diffConnectivity(before: NetStatusLike[], after: NetStatusLike[], limit = 40): {
	newlyConnected: string[];
	regressed: Array<{ net: string; from: string; to: string }>;
	stillOpen: string[];
	newlyConnectedCount: number;
	regressedCount: number;
	stillOpenCount: number;
} {
	const prior = new Map(before.map((n) => [n.net, n.status]));
	const newlyConnected: string[] = [];
	const regressed: Array<{ net: string; from: string; to: string }> = [];
	const stillOpen: string[] = [];
	for (const n of after) {
		const was = prior.get(n.net);
		if (n.status === 'connected' && was !== 'connected') newlyConnected.push(n.net);
		else if (was === 'connected' && n.status !== 'connected') regressed.push({ net: n.net, from: was, to: n.status });
		else if (n.status !== 'connected' && n.status !== 'single_pad') stillOpen.push(n.net);
	}
	newlyConnected.sort();
	stillOpen.sort();
	return {
		newlyConnected: newlyConnected.slice(0, limit),
		regressed: regressed.slice(0, limit),
		stillOpen: stillOpen.slice(0, limit),
		newlyConnectedCount: newlyConnected.length,
		regressedCount: regressed.length,
		stillOpenCount: stillOpen.length,
	};
}
