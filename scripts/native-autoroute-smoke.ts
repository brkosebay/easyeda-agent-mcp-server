// Native autorouter harness: argument coercion, board signatures, the
// completion state machine over scripted samples, connectivity diffs, and the
// handler end-to-end against a fake EasyEDA whose router never settles its
// promise (or settles with a report / an ack).
// Run: npx ts-node --transpile-only scripts/native-autoroute-smoke.ts
import assert from 'node:assert/strict';
import * as L from '../src/extension/handlers/native-autoroute-logic';

function props() {
	const d = L.buildAutoRoutingProps({});
	assert.deepEqual(d.props, { existingPrimitiveMode: 'keep' }, 'defaults: keep existing copper, everything else EasyEDA default');
	const p = L.buildAutoRoutingProps({ nets: ['SDA', 'SCL', 'SDA', ' '], ignoreNets: ['GND'], layers: ['TopLayer', 'In1.Cu', 2, 'bottom'], corner: '90', optimization: 'faster' }).props;
	assert.deepEqual(p.RoutingNets, ['SDA', 'SCL']);
	assert.deepEqual(p.ignoreNets, ['GND']);
	assert.deepEqual(p.layers, [1, 15, 2]);
	assert.equal(p.cornerStyle, 1);
	assert.equal(p.optimization, 0);
	assert.equal(L.buildAutoRoutingProps({ corner: '45°', optimization: 'completion' }).props.cornerStyle, 0);
	assert.equal(L.buildAutoRoutingProps({ optimization: 'completion' }).props.optimization, 1);
	const rip = L.buildAutoRoutingProps({ ripUpExisting: true });
	assert.equal(rip.props.existingPrimitiveMode, 'remove');
	assert.match(rip.warnings.join(' '), /removes ALL existing tracks/);
	assert.match(L.buildAutoRoutingProps({ nets: ['A'], ignoreNets: ['A'] }).warnings[0], /both list A/);
	assert.throws(() => L.buildAutoRoutingProps({ nets: 'selected' }), /not supported/);
	assert.throws(() => L.buildAutoRoutingProps({ layers: ['BoardOutline'] }), /not a copper layer/);
	assert.throws(() => L.buildAutoRoutingProps({ layers: [] }), /non-empty/);
	assert.throws(() => L.buildAutoRoutingProps({ corner: '30' }), /corner/);
	assert.throws(() => L.buildAutoRoutingProps({ optimization: 'best' }), /optimization/);
}

function signatures() {
	assert.deepEqual(L.setFingerprint(['a', 'b', 'c']), L.setFingerprint(['c', 'a', 'b']), 'order-independent');
	const a = L.copperSignature({ lines: ['e1', 'e2'], vias: ['v1'], arcs: [] });
	const b = L.copperSignature({ lines: ['e1', 'e3'], vias: ['v1'], arcs: [] });
	assert.deepEqual(a.counts, b.counts);
	assert.notEqual(a.signature, b.signature, 'rip-up-and-reroute with an equal count is still a change');
	const before: L.ComponentPose[] = [{ id: 'c1', designator: 'U1', x: 0, y: 0, rotation: 0, layer: 1 }, { id: 'c2', x: 10, y: 10, rotation: 90, layer: 1 }];
	const after: L.ComponentPose[] = [{ id: 'c1', designator: 'U1', x: 50, y: 0, rotation: 0, layer: 1 }, { id: 'c2', x: 10, y: 10, rotation: 90, layer: 1 }];
	assert.notEqual(L.layoutSignature(before), L.layoutSignature(after));
	const moved = L.diffPoses(before, after);
	assert.equal(moved.moved, 1);
	assert.deepEqual(moved.sample[0].to, [50, 0, 0]);
}

// sig: the board's signature from t on; null = polls go unanswered from t on;
// '!err' = polls are answered with an error from t on.
type Event = { t: number; sig?: string | null; promise?: 'resolved' | 'rejected'; report?: boolean };
/** Replays one poll per tick and returns the first terminal status and when. */
function replay(events: Event[], cfg: Partial<L.CompletionConfig> = {}, tickMs = 1_000, until = 200_000) {
	const config: L.CompletionConfig = { quietMs: 20_000, settlePolls: 3, promiseGraceMs: 10_000, deadlineAt: 100_000, unresponsiveMs: 20_000, ...cfg };
	const state = L.createProgress(0, 'base');
	let last = 'base';
	let mode: 'ok' | 'silent' | 'error' = 'ok';
	for (let t = tickMs; t <= until; t += tickMs) {
		for (const e of events.filter((ev) => ev.t > t - tickMs && ev.t <= t)) {
			if (e.promise) L.settlePromise(state, e.promise, e.t, e.report === true);
			if (e.sig === null) mode = 'silent';
			else if (e.sig === '!err') mode = 'error';
			else if (e.sig !== undefined) { last = e.sig; mode = 'ok'; }
		}
		if (mode === 'error') L.observeAlive(state, t);
		else L.observe(state, t, mode === 'silent' ? undefined : last);
		const status = L.decide(state, t, config);
		if (status !== 'running') return { status, t, state };
	}
	return { status: 'running' as const, t: until, state };
}

function stateMachine() {
	// Promise never settles (the known deadlock): copper changes, then goes quiet.
	let r = replay([{ t: 3_000, sig: 's1' }, { t: 5_000, sig: 's2' }]);
	assert.equal(r.status, 'quiet');
	assert.equal(r.t, 25_000, 'quiet = 20 s after the last change');
	assert.ok(L.changedFromBaseline(r.state));

	// Promise resolves with a report after copper changed: done on the next stable poll.
	r = replay([{ t: 3_000, sig: 's1' }, { t: 6_000, sig: 's2' }, { t: 6_500, promise: 'resolved', report: true }]);
	assert.equal(r.status, 'completed');
	assert.equal(r.t, 7_000);

	// Bare ack resolves first; the router commits later: an ack never ends the job by itself.
	r = replay([{ t: 500, promise: 'resolved', report: false }, { t: 30_000, sig: 's1' }]);
	assert.equal(r.status, 'quiet', 'ack + later copper ⇒ quiet, not an early "completed"');
	assert.equal(r.t, 50_000);

	// Ack and nothing ever changes: no-change at the deadline.
	r = replay([{ t: 500, promise: 'resolved', report: false }]);
	assert.equal(r.status, 'no-change');
	assert.equal(r.t, 100_000);

	// Report but no copper change (nothing to route): completed after the grace period.
	r = replay([{ t: 2_000, promise: 'resolved', report: true }]);
	assert.equal(r.status, 'completed');
	assert.equal(r.t, 12_000);

	// Ack resolving after copper started changing counts as completion.
	r = replay([{ t: 3_000, sig: 's1' }, { t: 4_500, promise: 'resolved', report: false }]);
	assert.equal(r.status, 'completed');

	// Still changing at the deadline.
	const churn: Event[] = Array.from({ length: 120 }, (_, i) => ({ t: (i + 1) * 1_000, sig: `c${i}` }));
	assert.equal(replay(churn).status, 'deadline');

	// Editor silent for the last 30 s before the deadline: sdk-unresponsive, not no-change.
	r = replay([{ t: 70_000, sig: null }]);
	assert.equal(r.status, 'sdk-unresponsive');

	// Reads that reject are answers: the editor is alive, so no-change, not sdk-unresponsive.
	r = replay([{ t: 70_000, sig: '!err' }]);
	assert.equal(r.status, 'no-change');
	assert.equal(r.state.errored, 31);

	// Silence alone is never terminal before the deadline.
	r = replay([{ t: 2_000, sig: null }], { deadlineAt: 150_000 });
	assert.equal(r.t, 150_000);

	// Rejection ends the job at once.
	r = replay([{ t: 1_500, promise: 'rejected' }]);
	assert.equal(r.status, 'failed');
	assert.equal(r.t, 2_000);

	// A change that is reverted is not a change from the baseline.
	r = replay([{ t: 2_000, sig: 's1' }, { t: 4_000, sig: 'base' }]);
	assert.equal(r.status, 'quiet');
	assert.equal(L.changedFromBaseline(r.state), false);
}

function reporting() {
	const before = [{ net: 'A', status: 'unrouted' }, { net: 'B', status: 'connected' }, { net: 'C', status: 'incomplete' }, { net: 'D', status: 'single_pad' }];
	const after = [{ net: 'A', status: 'connected' }, { net: 'B', status: 'incomplete' }, { net: 'C', status: 'incomplete' }, { net: 'D', status: 'single_pad' }];
	const s = L.summarizeConnectivity(after);
	assert.equal(s.routable, 3);
	assert.equal(s.connected, 1);
	assert.deepEqual(s.open, ['B', 'C']);
	const d = L.diffConnectivity(before, after);
	assert.deepEqual(d.newlyConnected, ['A']);
	assert.deepEqual(d.regressed, [{ net: 'B', from: 'connected', to: 'incomplete' }]);
	assert.deepEqual(d.stillOpen, ['C']);

	assert.equal(L.isAutoReport('route', { success: true }), false, 'bare success is an ack');
	assert.equal(L.isAutoReport('route', { success: true, totalNetsCount: 4, successNetsCount: 3, failedNets: ['X'], duration: 900 }), true);
	assert.equal(L.isAutoReport('route', true), false);
	assert.equal(L.isAutoReport('layout', { duration: 10 }), true);
	assert.deepEqual(L.routingResultFields({ success: true, successNetsCount: 3, failedNets: ['X'], other: 1 }), { success: true, successNetsCount: 3, failedNets: ['X'] });
	assert.equal(L.describeSettledValue(undefined).type, 'undefined');
	const big = L.describeSettledValue({ a: 'x'.repeat(5_000) });
	assert.deepEqual(big.keys, ['a']);
	assert.ok(big.json!.length < 1_600);
}

// ---------------------------------------------------------------------------
// Handler end-to-end against a fake EasyEDA
// ---------------------------------------------------------------------------

type Router = (board: { lines: string[]; vias: string[] }) => unknown;

function fakeEda(router: Router | undefined) {
	const board = { lines: ['t1', 't2'], vias: ['v1'] };
	return {
		board,
		eda: {
			pcb_Document: router ? { autoRouting: () => router(board), autoLayout: () => new Promise(() => undefined) } : {},
			pcb_PrimitiveLine: { getAllPrimitiveId: async () => [...board.lines] },
			pcb_PrimitiveVia: { getAllPrimitiveId: async () => [...board.vias] },
			pcb_PrimitiveArc: { getAllPrimitiveId: async () => [] },
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'doc1', documentType: 3 }) },
		},
	};
}

async function handlerRuns() {
	const g = globalThis as any;
	const { nativeAutorouteHandlers: H } = await import('../src/extension/handlers/native-autoroute');
	const fast = { verify: false, drc: false, pollMs: 250, quietMs: 2_000 };

	g.eda = fakeEda(undefined).eda;
	const unsupported = await H['pcb.native.autoroute']({});
	assert.equal(unsupported.supported, false, 'pre-3.2.150 host: feature-detected, nothing dispatched');

	// Router commits copper in two bursts and never settles its promise.
	let fake = fakeEda((board) => {
		setTimeout(() => { board.lines.push('r1', 'r2'); }, 300);
		setTimeout(() => { board.vias.push('rv1'); }, 700);
		return new Promise(() => undefined);
	});
	g.eda = fake.eda;
	let res = await H['pcb.native.autoroute']({ ...fast, nets: ['A'], _timeoutMs: 60_000 });
	assert.equal(res.status, 'quiet');
	assert.equal(res.promise.state, 'pending');
	assert.deepEqual(res.board.delta, { lines: 2, vias: 1, arcs: 0 });
	assert.deepEqual(res.request, { RoutingNets: ['A'], existingPrimitiveMode: 'keep' });

	// Router settles with a report after committing: completed, raw value kept.
	fake = fakeEda((board) => new Promise((resolve) => setTimeout(() => {
		board.lines.push('r3');
		setTimeout(() => resolve({ success: true, totalNetsCount: 2, successNetsCount: 1, failedNets: ['B'], duration: 400 }), 50);
	}, 300)));
	g.eda = fake.eda;
	res = await H['pcb.native.autoroute']({ ...fast, _timeoutMs: 60_000 });
	assert.equal(res.status, 'completed');
	assert.equal(res.promise.state, 'resolved');
	assert.deepEqual(res.promise.report, { success: true, totalNetsCount: 2, successNetsCount: 1, duration: 400, failedNets: ['B'] });
	assert.deepEqual(res.board.delta, { lines: 1, vias: 0, arcs: 0 });

	// Background: returns at once, finishes later, promise settles after the job ended.
	let settle!: (v: unknown) => void;
	fake = fakeEda((board) => {
		setTimeout(() => { board.lines.push('r4'); }, 200);
		return new Promise((resolve) => { settle = resolve; });
	});
	g.eda = fake.eda;
	const started = await H['pcb.native.autoroute']({ ...fast, background: true, _timeoutMs: 30_000 });
	assert.equal(started.status, 'running');
	await assert.rejects(H['pcb.native.autoroute']({ ...fast }), /still running/, 'one job at a time');
	let status: any;
	for (let i = 0; i < 40; i++) {
		await new Promise((r) => setTimeout(r, 250));
		status = await H['pcb.native.autoJobStatus']({ jobId: started.jobId });
		if (status.status !== 'running') break;
	}
	assert.equal(status.status, 'quiet');
	settle(true);
	await new Promise((r) => setTimeout(r, 10));
	fake.board.lines.push('late');
	status = await H['pcb.native.autoJobStatus']({ jobId: started.jobId, refresh: true });
	assert.equal(status.promise.state, 'resolved');
	assert.equal(status.promise.settledAfterJobFinished, true);
	assert.equal(status.refresh.changedSinceFinish, true);
	assert.deepEqual(status.refresh.board.deltaSinceFinish, { lines: 1, vias: 0, arcs: 0 });

	// pauseRatline: stopped while the router runs, restored before the after-checks.
	let ratline = 'active';
	let seenAtDispatch = '';
	fake = fakeEda((board) => {
		seenAtDispatch = ratline;
		setTimeout(() => { board.lines.push('r5'); }, 200);
		return Promise.resolve({ success: true, totalNetsCount: 1, successNetsCount: 1, failedNets: [], duration: 200 });
	});
	Object.assign(fake.eda.pcb_Document, {
		getCalculatingRatlineStatus: async () => ratline,
		stopCalculatingRatline: async () => { ratline = 'inactive'; return true; },
		startCalculatingRatline: async () => { ratline = 'active'; return true; },
	});
	g.eda = fake.eda;
	res = await H['pcb.native.autoroute']({ ...fast, pauseRatline: true, _timeoutMs: 60_000 });
	assert.equal(res.status, 'completed');
	assert.equal(seenAtDispatch, 'inactive');
	assert.equal(ratline, 'active');
	assert.deepEqual(res.ratline, { paused: true, priorStatus: 'active', restored: true });
	// Already off before the run: left off.
	ratline = 'inactive';
	res = await H['pcb.native.autoroute']({ ...fast, pauseRatline: true, _timeoutMs: 60_000 });
	assert.equal(ratline, 'inactive');
	assert.deepEqual(res.ratline, { paused: false, priorStatus: 'inactive' });

	// Wedged editor: the probe fails and nothing is dispatched.
	let dispatched = false;
	fake = fakeEda(() => { dispatched = true; return new Promise(() => undefined); });
	fake.eda.pcb_PrimitiveLine.getAllPrimitiveId = () => new Promise(() => undefined);
	g.eda = fake.eda;
	res = await H['pcb.native.autoroute']({ ...fast, _timeoutMs: 60_000 });
	assert.equal(res.status, 'sdk-unresponsive');
	assert.equal(dispatched, false);

	// Synchronous rejection.
	g.eda = fakeEda(() => { throw new Error('router busy'); }).eda;
	res = await H['pcb.native.autoroute']({ ...fast, _timeoutMs: 60_000 });
	assert.equal(res.status, 'failed');
	assert.match(res.promise.error, /router busy/);
}

async function main() {
	props();
	signatures();
	stateMachine();
	reporting();
	await handlerRuns();
	console.log('Native autoroute harness: props, signatures, completion state machine, connectivity diff, fake-host runs (quiet / completed / background + late settle / ratline pause+restore / unresponsive / rejected / unsupported): passed.');
	process.exit(0);
}
main().catch((error) => { console.error(error); process.exit(1); });
