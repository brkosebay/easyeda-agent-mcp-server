// EasyEDA's own PCB autorouter / autolayout (pcb_native_autoroute,
// pcb_native_autolayout, pcb_native_auto_job_status) — fire-and-verify.
//
// EasyEDA Pro 3.2.150+ has eda.pcb_Document.autoRouting(props) (β) and
// autoLayout() (α). In the 3.2.206 runtime (pro-api 0.3.50) both forward to
// the editor's rpc "extensionApi.PCB_Document.autoRouting" / "…autoLayout".
// autoRouting first awaits pcb_Layer.getAllLayers() when no layers are given
// (SIGNAL/PLANE layers with layerStatus 1), then sends {routingRange,
// routingCorner, isKeep, routingEffectPriority, routingNetPriority: 0, layers,
// ignoreNets, ignoreLayers: []}. Neither is verified live, and long
// canvas-tick SDK promises can stay pending forever, so this module never
// awaits them:
//   - liveness probe and an id-only copper baseline (plus connectivity) before
//     anything is dispatched;
//   - the promise is observed: state, settle time and the raw value are kept
//     on the job record, even after the job itself has finished;
//   - completion comes from polling the id-only line/via/arc lists (one call
//     in flight, 4 s deadline) — see decide() in native-autoroute-logic.ts;
//   - connectivity is analyzed exactly twice (before, after) and DRC once
//     after, each time-bounded;
//   - a synchronous call returns before the gate watchdog fires (no
//     quarantine); background:true returns a jobId at once.
// When the runtime reaches pro-api 0.4.x, startAutoRouting/getAutoJobStatus/
// cancelAutoJob can replace the dispatch and the poll signal; the job record
// and the before/after verification stay as they are.

import { canonicalDocumentId } from '../../shared/method-classes';
import { didTimeOut, readWithTimeout } from './_utils';
import { getSnapshot, invalidateBoardSnapshotCache } from './board-context';
import { drcHandlers } from './drc';
import { findNativeHost } from './native-copper';
import { analyzeConnectivity, fetchArcs } from './net-connectivity';
import * as L from './native-autoroute-logic';

const PROBE_MS = 3_000;
const POLL_CALL_MS = 4_000;
const DOC_CHECK_EVERY = 5;
const DEADLINE_MARGIN_MS = 8_000;
const SYNC_DEFAULT_TOTAL_MS = 100_000;
const BACKGROUND_DEFAULT_TOTAL_MS = 600_000;
const MAX_TOTAL_MS = 1_800_000;
const DEFAULT_POLL_MS: Record<L.AutoJobKind, number> = { route: 1_000, layout: 1_500 };
const DEFAULT_QUIET_MS = 20_000;
const SETTLE_POLLS = 3;
const PROMISE_GRACE_MS = 10_000;
const UNRESPONSIVE_MS = 20_000;
const CONNECTIVITY_MS = 45_000;
const DRC_MS = 60_000;
// Synchronous calls keep this much of their window for the after-checks.
const SYNC_VERIFY_RESERVE_MS = 35_000;
const MAX_JOBS = 10;
const STALE_AFTER_MS = 30_000;
const EVENT_TOPICS = ['pcbUpdateProgress', 'setPcbTabUnSaved'];

interface AutoJob {
	jobId: string;
	kind: L.AutoJobKind;
	status: L.AutoJobStatus;
	background: boolean;
	startedAt: number;
	finishedAt?: number;
	documentUuid?: string;
	hardDeadlineAt: number;
	pollDeadlineAt: number;
	config: { pollMs: number; quietMs: number; settlePolls: number; promiseGraceMs: number; verify: boolean; drc: boolean; pauseRatline: boolean };
	request?: L.AutoRoutingProps;
	progress?: L.ProgressState;
	dispatchedAt?: number;
	promise: { state: L.PromiseState; settledAfterMs?: number; settledAfterJobFinished?: boolean; value?: L.SettledValue; report?: Record<string, unknown>; error?: string };
	copper: { before?: L.CopperCounts; last?: L.CopperCounts };
	poses?: { before?: L.ComponentPose[]; last?: L.ComponentPose[] };
	connectivity: { before?: L.NetStatusLike[]; beforeSummary?: L.ConnectivitySummary; afterSummary?: L.ConnectivitySummary; diff?: ReturnType<typeof L.diffConnectivity>; errors: string[] };
	drc?: Record<string, unknown>;
	/** pauseRatline: the ratsnest calculation is stopped around the run and restored after. */
	ratline?: { priorStatus?: string; paused: boolean; restored?: boolean; error?: string };
	nativeEvents: Record<string, { count: number; firstAfterMs?: number; lastAfterMs?: number; sample?: string }>;
	pollErrors: string[];
	cacheInvalidated: boolean;
	warnings: string[];
	notes: string[];
}

interface AutoState { seq: number; jobs: Map<string, AutoJob>; lastJobId?: string }

// Survives a menu re-evaluation of the bundle, so an in-flight promise is
// never orphaned from its record.
const host = globalThis as unknown as { __easyedaNativeAutoStateV1?: AutoState; __easyedaRepourStateV1?: { lastJobId?: string; jobs?: Map<string, { status?: string }> } };
const autoState: AutoState = host.__easyedaNativeAutoStateV1 ??= { seq: 0, jobs: new Map() };

export const nativeAutorouteHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.native.autoroute': (params) => startAutoJob('route', params),
	'pcb.native.autolayout': (params) => startAutoJob('layout', params),
	// In-memory job record: no operation gate, answers while EasyEDA is busy.
	'pcb.native.autoJobStatus': (params) => autoJobStatus(params),
};

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function positive(v: unknown): number | undefined {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function errText(err: any): string {
	return err?.message ?? String(err);
}

function documentApi(): any {
	return (eda as any)?.pcb_Document;
}

async function activeDocumentUuid(): Promise<string | undefined> {
	try {
		const doc = await readWithTimeout(() => eda.dmt_SelectControl.getCurrentDocumentInfo(), PROBE_MS);
		if (didTimeOut(doc)) return undefined;
		return (doc as any)?.uuid ? String((doc as any).uuid) : undefined;
	} catch {
		return undefined;
	}
}

/** Time-bounded liveness probe on the cheapest copper API (ids only). */
async function probeSdk(): Promise<{ responsive: boolean; ms: number; error?: string }> {
	const t0 = Date.now();
	try {
		const out = await readWithTimeout(() => eda.pcb_PrimitiveLine.getAllPrimitiveId(), PROBE_MS);
		return { responsive: !didTimeOut(out), ms: Date.now() - t0 };
	} catch (err) {
		// A rejection is still an answer: the SDK is alive.
		return { responsive: true, ms: Date.now() - t0, error: errText(err) };
	}
}

// ---------------------------------------------------------------------------
// Board readers
// ---------------------------------------------------------------------------

async function rawCopperIds(): Promise<{ lines: string[]; vias: string[]; arcs: string[] }> {
	const arcApi = (eda as any).pcb_PrimitiveArc;
	const [lines, vias, arcs] = await Promise.all([
		eda.pcb_PrimitiveLine.getAllPrimitiveId(),
		eda.pcb_PrimitiveVia.getAllPrimitiveId(),
		typeof arcApi?.getAllPrimitiveId === 'function' ? arcApi.getAllPrimitiveId() : Promise.resolve([]),
	]);
	const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
	return { lines: ids(lines), vias: ids(vias), arcs: ids(arcs) };
}

function stateOf(p: any, state: string, flat: string): any {
	try {
		const getter = p?.[`getState_${state}`];
		if (typeof getter === 'function') return getter.call(p);
	} catch {/* */}
	return p?.[flat];
}

async function rawPoses(): Promise<L.ComponentPose[]> {
	const list = await eda.pcb_PrimitiveComponent.getAll();
	return ((list as any[]) || []).map((c) => ({
		id: String(stateOf(c, 'PrimitiveId', 'primitiveId') ?? ''),
		designator: stateOf(c, 'Designator', 'designator') ?? undefined,
		x: Number(stateOf(c, 'X', 'x')),
		y: Number(stateOf(c, 'Y', 'y')),
		rotation: Number(stateOf(c, 'Rotation', 'rotation') ?? 0),
		layer: stateOf(c, 'Layer', 'layer'),
	})).filter((p) => p.id);
}

interface Sample { signature: string; counts?: L.CopperCounts; poses?: L.ComponentPose[] }

async function readSample(kind: L.AutoJobKind): Promise<Sample> {
	if (kind === 'route') {
		const { counts, signature } = L.copperSignature(await rawCopperIds());
		return { signature, counts };
	}
	const poses = await rawPoses();
	return { signature: L.layoutSignature(poses), poses };
}

/**
 * Never more than one board read in flight: while EasyEDA has not answered
 * the previous one, poll() reports a miss instead of stacking another
 * request onto a busy editor.
 */
function createSampler(kind: L.AutoJobKind) {
	let inflight: Promise<Sample> | undefined;
	/** undefined = not answered in time (or the previous read is still pending). */
	return async (): Promise<{ sample: Sample } | { error: string } | undefined> => {
		if (inflight) return undefined;
		const call = readSample(kind);
		inflight = call;
		void call.then(() => undefined, () => undefined).then(() => { if (inflight === call) inflight = undefined; });
		try {
			const out = await readWithTimeout(() => call, POLL_CALL_MS);
			return didTimeOut(out) ? undefined : { sample: out };
		} catch (err) {
			// A rejection is still an answer: EasyEDA is alive.
			return { error: errText(err) };
		}
	};
}

async function readConnectivity(ms: number): Promise<L.NetStatusLike[] | { error: string }> {
	if (ms < 2_000) return { error: 'not enough time left in this call' };
	try {
		const out = await readWithTimeout(async () => {
			const snapshot = await getSnapshot({ forceRefresh: true });
			const arcs = await fetchArcs();
			return analyzeConnectivity({ ...snapshot, arcs }).map((n) => ({ net: n.net, status: n.status }));
		}, ms);
		return didTimeOut(out) ? { error: `connectivity analysis did not finish within ${ms} ms` } : out;
	} catch (err) {
		return { error: `connectivity analysis failed: ${errText(err)}` };
	}
}

async function readDrc(ms: number): Promise<Record<string, unknown>> {
	if (ms < 2_000) return { skipped: 'not enough time left in this call — run pcb_drc_summarize' };
	try {
		const out = await readWithTimeout(() => drcHandlers['pcb.drc.summarize']({ top: 8, includeSamples: false }), ms);
		if (didTimeOut(out)) return { error: `DRC did not finish within ${ms} ms — run pcb_drc_summarize` };
		const r = out as any;
		return {
			passed: r?.passed,
			totalViolations: r?.totalViolations,
			topGroups: Array.isArray(r?.topGroups) ? r.topGroups.map((g: any) => ({ key: g.key, count: g.count })) : undefined,
			note: r?.note,
		};
	} catch (err) {
		return { error: `DRC failed: ${errText(err)}` };
	}
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

function registerJob(job: AutoJob): void {
	autoState.jobs.set(job.jobId, job);
	autoState.lastJobId = job.jobId;
	while (autoState.jobs.size > MAX_JOBS) {
		const oldest = autoState.jobs.keys().next().value;
		if (oldest === undefined || oldest === job.jobId) break;
		autoState.jobs.delete(oldest);
	}
}

function finishJob(job: AutoJob, status: L.AutoJobStatus): void {
	job.status = status;
	job.finishedAt = Date.now();
}

function invalidateOnce(job: AutoJob): void {
	if (job.cacheInvalidated || job.status === 'running') return;
	// ws-client invalidates after the handler returns, which is too early for
	// a background job: the router writes copper after that.
	invalidateBoardSnapshotCache(job.documentUuid);
	job.cacheInvalidated = true;
}

function runningJob(): AutoJob | undefined {
	const job = autoState.lastJobId ? autoState.jobs.get(autoState.lastJobId) : undefined;
	if (!job || job.status !== 'running') return undefined;
	if (Date.now() > job.hardDeadlineAt + STALE_AFTER_MS) {
		job.notes.push('Marked failed: still "running" 30 s past its deadline (stale job record).');
		finishJob(job, 'failed');
		return undefined;
	}
	return job;
}

function repourRunning(): boolean {
	const state = host.__easyedaRepourStateV1;
	const last = state?.lastJobId ? state.jobs?.get(state.lastJobId) : undefined;
	return last?.status === 'running';
}

async function startAutoJob(kind: L.AutoJobKind, params: Record<string, any>): Promise<any> {
	const fn = kind === 'route' ? 'autoRouting' : 'autoLayout';
	if (typeof documentApi()?.[fn] !== 'function') {
		return {
			supported: false,
			status: 'unsupported',
			reason: `eda.pcb_Document.${fn} is not available in this EasyEDA build (it was added in EasyEDA Pro 3.2.150).`,
		};
	}
	const busy = runningJob();
	if (busy) {
		throw new Error(`Native ${busy.kind} job ${busy.jobId} is still running (${Math.round((Date.now() - busy.startedAt) / 1000)} s). Poll pcb_native_auto_job_status instead of starting another.`);
	}
	if (repourRunning()) throw new Error('A repour job is running; wait for pcb_repour_status to finish before autorouting.');

	const { props, warnings } = kind === 'route' ? L.buildAutoRoutingProps(params) : { props: undefined, warnings: [] as string[] };
	const background = params?.background === true;
	const verify = params?.verify !== false;
	const drc = params?.drc !== false;
	const startedAt = Date.now();
	const callBudgetMs = positive(params?._timeoutMs);
	const gateDeadlineAt = positive(params?._gateDeadlineAt);
	// Everything before the dispatch runs inside this call, in both modes.
	const callLimitAt = gateDeadlineAt
		? gateDeadlineAt - DEADLINE_MARGIN_MS
		: startedAt + (callBudgetMs ?? 120_000) - DEADLINE_MARGIN_MS;
	const totalMs = Math.min(MAX_TOTAL_MS, positive(params?.totalTimeoutMs)
		?? (background ? BACKGROUND_DEFAULT_TOTAL_MS : (callBudgetMs ? callBudgetMs - DEADLINE_MARGIN_MS : SYNC_DEFAULT_TOTAL_MS)));
	let hardDeadlineAt = startedAt + Math.max(10_000, totalMs);
	if (!background) hardDeadlineAt = Math.min(hardDeadlineAt, callLimitAt);

	const job: AutoJob = {
		jobId: `native-${kind}-${++autoState.seq}-${startedAt}`,
		kind,
		status: 'running',
		background,
		startedAt,
		hardDeadlineAt,
		pollDeadlineAt: hardDeadlineAt,
		config: {
			pollMs: Math.max(250, positive(params?.pollMs) ?? DEFAULT_POLL_MS[kind]),
			quietMs: Math.max(2_000, positive(params?.quietMs) ?? DEFAULT_QUIET_MS),
			settlePolls: SETTLE_POLLS,
			promiseGraceMs: PROMISE_GRACE_MS,
			verify,
			drc,
			pauseRatline: params?.pauseRatline === true,
		},
		request: props,
		promise: { state: 'pending' },
		copper: {},
		poses: kind === 'layout' ? {} : undefined,
		connectivity: { errors: [] },
		nativeEvents: {},
		pollErrors: [],
		cacheInvalidated: false,
		warnings,
		notes: [],
	};

	// 1. Never dispatch into a wedged editor.
	const probe = await probeSdk();
	if (!probe.responsive) {
		job.notes.push(`EasyEDA did not answer a ${PROBE_MS} ms liveness probe; nothing was dispatched. Press Esc in the editor (open dialog / placement mode?) and retry.`);
		finishJob(job, 'sdk-unresponsive');
		registerJob(job);
		return summarize(job);
	}
	job.documentUuid = await activeDocumentUuid();

	// 2. Baselines.
	let baseline: Sample;
	try {
		const out = await readWithTimeout(() => readSample(kind), POLL_CALL_MS * 2);
		if (didTimeOut(out)) throw new Error(`the ${kind === 'route' ? 'copper' : 'component'} baseline did not answer within ${POLL_CALL_MS * 2} ms`);
		baseline = out;
	} catch (err) {
		job.notes.push(`Baseline failed (${errText(err)}); nothing was dispatched.`);
		finishJob(job, 'failed');
		registerJob(job);
		return summarize(job);
	}
	if (baseline.counts) job.copper.before = job.copper.last = baseline.counts;
	if (job.poses) job.poses.before = job.poses.last = baseline.poses;

	if (kind === 'route' && verify) {
		const before = await readConnectivity(Math.min(CONNECTIVITY_MS, callLimitAt - Date.now() - 10_000));
		if ('error' in before) job.connectivity.errors.push(`before: ${before.error}`);
		else {
			job.connectivity.before = before;
			job.connectivity.beforeSummary = L.summarizeConnectivity(before);
		}
	}
	if (!background) {
		const reserve = verify || drc ? Math.min(SYNC_VERIFY_RESERVE_MS, Math.max(0, (hardDeadlineAt - Date.now()) * 0.35)) : 0;
		job.pollDeadlineAt = hardDeadlineAt - reserve;
		if (job.pollDeadlineAt - Date.now() < 5_000) {
			job.notes.push('Not enough time left in this call to dispatch and observe the job; nothing was dispatched. Raise totalTimeoutMs or use background:true.');
			finishJob(job, 'deadline');
			registerJob(job);
			return summarize(job);
		}
	}
	registerJob(job);

	// 3. Dispatch — observed, never awaited.
	if (job.config.pauseRatline) await pauseRatline(job);
	dispatch(job, baseline.signature);
	if (job.status !== 'running') {
		await restoreRatline(job);
		return summarize(job);
	}

	if (background) {
		void runJob(job).catch((err) => {
			job.notes.push(`Background job crashed: ${errText(err)}`);
			if (job.status === 'running') finishJob(job, 'failed');
			void restoreRatline(job);
		});
		return {
			...summarize(job),
			note: 'Running in the background; the bridge queue is already released. Poll pcb_native_auto_job_status {jobId} until status != "running". Avoid other edits on this board until it finishes — they interleave with the router.',
		};
	}
	try {
		await runJob(job);
	} catch (err) {
		job.notes.push(`Job loop failed: ${errText(err)}`);
		if (job.status === 'running') finishJob(job, 'failed');
		await restoreRatline(job);
	}
	return summarize(job);
}

function dispatch(job: AutoJob, baselineSignature: string): void {
	const api = documentApi();
	const dispatchedAt = Date.now();
	job.dispatchedAt = dispatchedAt;
	const progress = L.createProgress(dispatchedAt, baselineSignature);
	job.progress = progress;
	subscribeEvents(job);
	let returned: unknown;
	try {
		returned = job.kind === 'route' ? api.autoRouting(job.request) : api.autoLayout();
	} catch (err) {
		job.promise = { state: 'rejected', error: `threw synchronously: ${errText(err)}`, settledAfterMs: 0 };
		L.settlePromise(progress, 'rejected', dispatchedAt);
		job.notes.push(`autoRouting threw before dispatch: ${errText(err)}`);
		unsubscribeEvents(job);
		finishJob(job, 'failed');
		return;
	}
	const record = (state: 'resolved' | 'rejected' | 'not-a-promise', value?: unknown, error?: string) => {
		const at = Date.now();
		job.promise.state = state;
		job.promise.settledAfterMs = at - dispatchedAt;
		job.promise.settledAfterJobFinished = job.status !== 'running';
		if (error !== undefined) job.promise.error = error;
		else {
			job.promise.value = L.describeSettledValue(value);
			job.promise.report = job.kind === 'route' ? L.routingResultFields(value) : layoutResultFields(value);
		}
		L.settlePromise(progress, state, at, state !== 'rejected' && L.isAutoReport(job.kind, value));
	};
	if (returned && typeof (returned as any).then === 'function') {
		(returned as Promise<unknown>).then((value) => record('resolved', value), (err) => record('rejected', undefined, errText(err)));
	} else {
		record('not-a-promise', returned);
	}
}

// The official FreeRouting extension pauses the ratsnest around bulk copper
// writes (SES import). Whether EasyEDA's own router needs its connection data
// live is unknown, so this is opt-in, for an A/B on a scratch board.
async function pauseRatline(job: AutoJob): Promise<void> {
	const doc = documentApi();
	const entry: NonNullable<AutoJob['ratline']> = { paused: false };
	job.ratline = entry;
	try {
		const prior = await readWithTimeout(() => doc.getCalculatingRatlineStatus(), PROBE_MS);
		entry.priorStatus = didTimeOut(prior) ? 'unknown' : String(prior);
		if (entry.priorStatus === 'inactive') return;
		const stopped = await readWithTimeout(() => doc.stopCalculatingRatline(), PROBE_MS);
		entry.paused = !didTimeOut(stopped) && stopped !== false;
		if (!entry.paused) entry.error = didTimeOut(stopped) ? `stopCalculatingRatline did not answer within ${PROBE_MS} ms` : 'stopCalculatingRatline returned false';
	} catch (err) {
		entry.error = errText(err);
	}
}

async function restoreRatline(job: AutoJob): Promise<void> {
	const entry = job.ratline;
	// Restart whenever we may have stopped it (a stop that timed out may still land).
	if (!entry || entry.restored !== undefined || entry.priorStatus === 'inactive') return;
	try {
		const out = await readWithTimeout(() => documentApi().startCalculatingRatline(), PROBE_MS);
		entry.restored = !didTimeOut(out) && out !== false;
	} catch (err) {
		entry.restored = false;
		entry.error = errText(err);
	}
	if (!entry.restored) job.notes.push('The ratsnest calculation could not be restarted after pauseRatline; turn ratlines back on in EasyEDA.');
}

function layoutResultFields(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const v = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of ['success', 'totalComponentsCount', 'successComponentsCount', 'duration']) if (v[k] !== undefined) out[k] = v[k];
	if (Array.isArray(v.failedComponents)) out.failedComponents = (v.failedComponents as unknown[]).slice(0, 40).map(String);
	return Object.keys(out).length ? out : undefined;
}

const subscriptions = new Map<string, Array<{ cancel?: () => void } | undefined>>();

/** Best effort: which editor events fire during the run (timing evidence only). */
function subscribeEvents(job: AutoJob): void {
	const found = findNativeHost();
	if (!found.host) {
		job.nativeEvents = {};
		return;
	}
	const subs: Array<{ cancel?: () => void } | undefined> = [];
	for (const topic of EVENT_TOPICS) {
		try {
			subs.push(found.host.messageBus.subscribe(topic, (m: unknown) => {
				if (job.status !== 'running') return;
				if (topic === 'setPcbTabUnSaved' && job.documentUuid) {
					const id = Array.isArray(m) ? m[0] : undefined;
					if (id != null && canonicalDocumentId(String(id)) !== canonicalDocumentId(job.documentUuid)) return;
				}
				const afterMs = Date.now() - (job.dispatchedAt ?? Date.now());
				const entry = job.nativeEvents[topic] ??= { count: 0 };
				entry.count++;
				entry.firstAfterMs ??= afterMs;
				entry.lastAfterMs = afterMs;
				if (entry.sample === undefined) {
					try { entry.sample = JSON.stringify(m)?.slice(0, 160); } catch { entry.sample = String(m).slice(0, 160); }
				}
			}));
		} catch {/* topic unavailable */}
	}
	subscriptions.set(job.jobId, subs);
}

function unsubscribeEvents(job: AutoJob): void {
	for (const sub of subscriptions.get(job.jobId) ?? []) { try { sub?.cancel?.(); } catch {/* */} }
	subscriptions.delete(job.jobId);
}

async function runJob(job: AutoJob): Promise<void> {
	const progress = job.progress!;
	const sample = createSampler(job.kind);
	const cfg: L.CompletionConfig = {
		quietMs: job.config.quietMs,
		settlePolls: job.config.settlePolls,
		promiseGraceMs: job.config.promiseGraceMs,
		deadlineAt: job.pollDeadlineAt,
		unresponsiveMs: UNRESPONSIVE_MS,
	};
	let tick = 0;
	let outcome: L.AutoJobStatus = 'running';
	try {
		while (outcome === 'running') {
			await sleep(job.config.pollMs);
			const polled = await sample();
			const now = Date.now();
			if (polled && 'error' in polled) {
				L.observeAlive(progress, now);
				if (job.pollErrors.length < 5) job.pollErrors.push(polled.error);
			} else {
				const s = polled?.sample;
				L.observe(progress, now, s?.signature);
				if (s?.counts) job.copper.last = s.counts;
				if (s?.poses && job.poses) job.poses.last = s.poses;
			}
			if (job.documentUuid && ++tick % DOC_CHECK_EVERY === 0) {
				const active = await activeDocumentUuid();
				if (active && canonicalDocumentId(active) !== canonicalDocumentId(job.documentUuid)) {
					job.notes.push(`The active document changed to ${active}; stopped observing. The router may still be running on ${job.documentUuid}.`);
					outcome = 'document-changed';
					break;
				}
			}
			outcome = L.decide(progress, Date.now(), cfg);
		}
	} finally {
		unsubscribeEvents(job);
	}
	finishJob(job, outcome);
	// Before the after-checks: DRC may rely on the editor's connection data.
	await restoreRatline(job);
	explainOutcome(job);
	invalidateOnce(job);
	await verifyAfter(job);
}

function explainOutcome(job: AutoJob): void {
	const p = job.progress!;
	switch (job.status) {
		case 'completed':
			job.notes.push(L.promiseMeansDone(p) && p.firstChangeAt === undefined
				? 'The promise settled with a report but the board did not change.'
				: 'The promise settled and the board stopped changing.');
			break;
		case 'quiet':
			job.notes.push(`The board changed and then stayed unchanged for ${Math.round(job.config.quietMs / 1000)} s, but the promise ${p.promise === 'pending' ? 'is still pending' : 'only acknowledged the start'}. Treat as finished; pcb_native_auto_job_status {refresh:true} shows whether anything changed later.`);
			break;
		case 'no-change':
			job.notes.push('Nothing on the board changed before the deadline. The router may still be computing (status refresh:true shows late changes), may have found nothing to route, or a dialog may be waiting in EasyEDA.');
			break;
		case 'deadline':
			job.notes.push('The board was still changing at the deadline. Poll pcb_native_auto_job_status {refresh:true}; next time use background:true or a larger totalTimeoutMs.');
			break;
		case 'sdk-unresponsive':
			job.notes.push(`EasyEDA answered no board read for ${Math.round((Date.now() - p.lastOkAt) / 1000)} s at the deadline (it may be routing on its main thread). Poll pcb_native_auto_job_status {refresh:true}.`);
			break;
		case 'failed':
			if (job.promise.error) job.notes.push(`autoRouting rejected: ${job.promise.error}`);
			break;
		default:
			break;
	}
}

async function verifyAfter(job: AutoJob): Promise<void> {
	if (job.status === 'sdk-unresponsive' || job.status === 'document-changed') {
		job.notes.push('After-checks skipped (editor not answering / other document active). Run pcb_connectivity_status and pcb_drc_summarize yourself.');
		return;
	}
	const remaining = (cap: number) => (job.background ? cap : Math.min(cap, job.hardDeadlineAt - Date.now() - 1_000));
	if (job.kind === 'route' && job.config.verify) {
		const after = await readConnectivity(remaining(CONNECTIVITY_MS));
		if ('error' in after) job.connectivity.errors.push(`after: ${after.error}`);
		else {
			job.connectivity.afterSummary = L.summarizeConnectivity(after);
			if (job.connectivity.before) job.connectivity.diff = L.diffConnectivity(job.connectivity.before, after);
		}
	}
	if (job.config.drc) job.drc = await readDrc(remaining(DRC_MS));
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function countsDelta(before?: L.CopperCounts, after?: L.CopperCounts): L.CopperCounts | undefined {
	if (!before || !after) return undefined;
	return { lines: after.lines - before.lines, vias: after.vias - before.vias, arcs: after.arcs - before.arcs };
}

function summarize(job: AutoJob): Record<string, unknown> {
	const now = Date.now();
	const p = job.progress;
	const routedNets = job.connectivity.beforeSummary && job.connectivity.afterSummary
		? { before: job.connectivity.beforeSummary.connected, after: job.connectivity.afterSummary.connected, routable: job.connectivity.afterSummary.routable }
		: undefined;
	return {
		supported: true,
		jobId: job.jobId,
		kind: job.kind,
		status: job.status,
		background: job.background,
		documentUuid: job.documentUuid,
		elapsedMs: (job.finishedAt ?? now) - job.startedAt,
		observedMs: job.dispatchedAt ? (job.finishedAt ?? now) - job.dispatchedAt : undefined,
		deadlineInMs: job.status === 'running' ? Math.max(0, job.pollDeadlineAt - now) : undefined,
		request: job.request,
		promise: { ...job.promise },
		board: job.kind === 'route'
			? { before: job.copper.before, after: job.copper.last, delta: countsDelta(job.copper.before, job.copper.last) }
			: job.poses?.before && job.poses.last ? L.diffPoses(job.poses.before, job.poses.last) : undefined,
		progress: p ? {
			changed: p.firstChangeAt !== undefined,
			changedFromBaseline: L.changedFromBaseline(p),
			firstChangeAfterMs: p.firstChangeAt !== undefined ? p.firstChangeAt - p.dispatchedAt : undefined,
			lastChangeAfterMs: p.lastChangeAt !== undefined ? p.lastChangeAt - p.dispatchedAt : undefined,
			polls: { answered: p.answered, missed: p.missed, errored: p.errored, maxSilentMs: p.maxSilentMs },
			pollErrors: job.pollErrors.length ? job.pollErrors : undefined,
		} : undefined,
		routedNets,
		connectivity: job.kind === 'route' ? {
			before: job.connectivity.beforeSummary,
			after: job.connectivity.afterSummary,
			diff: job.connectivity.diff,
			errors: job.connectivity.errors.length ? job.connectivity.errors : undefined,
		} : undefined,
		drc: job.drc,
		ratline: job.ratline,
		nativeEvents: job.nativeEvents,
		config: job.config,
		warnings: job.warnings.length ? job.warnings : undefined,
		notes: job.notes,
		mode: 'fire-and-verify',
	};
}

async function autoJobStatus(params: Record<string, any>): Promise<any> {
	const jobId = params?.jobId ? String(params.jobId) : autoState.lastJobId;
	const job = jobId ? autoState.jobs.get(jobId) : undefined;
	if (!job) {
		return {
			status: 'no-job',
			jobId: jobId ?? null,
			knownJobs: [...autoState.jobs.keys()],
			supported: { autoRouting: typeof documentApi()?.autoRouting === 'function', autoLayout: typeof documentApi()?.autoLayout === 'function' },
		};
	}
	invalidateOnce(job);
	const out: Record<string, unknown> = summarize(job);
	if (params?.refresh === true && job.status !== 'running' && job.progress) {
		// One bounded board read: did anything change after observation ended?
		try {
			const s = await readWithTimeout(() => readSample(job.kind), POLL_CALL_MS);
			if (didTimeOut(s)) out.refresh = { answered: false, note: `EasyEDA did not answer a board read within ${POLL_CALL_MS} ms.` };
			else {
				const changedSinceFinish = s.signature !== job.progress.last;
				out.refresh = {
					answered: true,
					changedSinceFinish,
					board: job.kind === 'route'
						? { now: s.counts, deltaSinceFinish: countsDelta(job.copper.last, s.counts), deltaSinceStart: countsDelta(job.copper.before, s.counts) }
						: job.poses?.before && s.poses ? L.diffPoses(job.poses.before, s.poses) : undefined,
					note: changedSinceFinish ? 'The board changed after observation ended (router still running, or other edits). Re-check pcb_connectivity_status / pcb_drc_summarize.' : undefined,
				};
				if (changedSinceFinish) invalidateBoardSnapshotCache(job.documentUuid);
			}
		} catch (err) {
			out.refresh = { answered: true, error: errText(err) };
		}
	}
	return out;
}
