// Repour safety smoke test (v2.1.10). Runs pcb.pour.repourAll against a mocked
// `eda` that reproduces the live failure modes:
//   change — rebuild replaces the poured-fill ids (GUI-like success)
//   noop   — rebuild promise never settles and nothing changes (EasyEDA keeps answering)
//   wedge  — after the first dispatch EasyEDA answers no SDK call at all
// and checks the handler never hangs, never dispatches into a wedged host and
// always returns inside its budget. Also checks native_operation_reset hooks.
import assert from 'node:assert/strict';

const g = globalThis as any;
const hang = () => new Promise<never>(() => {});
let pouredIds = ['p1', 'p2', 'p3'];
let mode: 'change' | 'noop' | 'wedge' | 'resolve' = 'change';
// Only the poured-fill API hangs (the rest of the SDK answers).
let pouredApiHangs = false;
let wedged = false;
let dispatches: string[] = [];

function mkPour(id: string) {
	return {
		getState_PrimitiveId: () => id,
		getState_Net: () => 'GND',
		getState_Layer: () => 1,
		getState_PourName: () => `pour_${id}`,
		getState_PrimitiveLock: () => false,
		isAsync: () => false,
		rebuildCopperRegion: () => {
			dispatches.push(id);
			if (mode === 'change') {
				setTimeout(() => { pouredIds = pouredIds.map((x) => `${x}r`); }, 300);
				return hang();
			}
			if (mode === 'wedge') wedged = true;
			if (mode === 'resolve') return new Promise((res) => setTimeout(() => res(undefined), 200));
			return hang();
		},
	};
}

g.eda = {
	pcb_PrimitivePour: {
		getAllPrimitiveId: async () => (wedged ? hang() : ['A', 'B']),
		getAll: async () => (wedged ? hang() : [mkPour('A'), mkPour('B')]),
		get: async (id: string) => (wedged ? hang() : mkPour(id)),
		modify: async () => ({}),
	},
	pcb_PrimitivePoured: {
		getAllPrimitiveId: async () => (wedged || pouredApiHangs ? hang() : [...pouredIds]),
		// The pre-2.1.10 code awaited this untimed; it must not be called any more.
		getAll: () => { throw new Error('pcb_PrimitivePoured.getAll must not be used by repour'); },
	},
	dmt_SelectControl: {
		getCurrentDocumentInfo: async () => (wedged ? hang() : { uuid: 'doc1', documentType: 3 }),
	},
};

async function main() {
	const { pourFillHandlers } = await import('../src/extension/handlers/pour-fill');
	const { resetNativeOperations, onNativeOperationsReset } = await import('../src/extension/native-operation-gate');
	const repour = pourFillHandlers['pcb.pour.repourAll'];
	const status = pourFillHandlers['pcb.pour.jobStatus'];

	// 1. Success path: ids change → rebuilt, one pour at a time.
	mode = 'change'; wedged = false; dispatches = [];
	let t0 = Date.now();
	let r = await repour({ strategy: 'rebuild', perPourTimeoutMs: 8_000, totalTimeoutMs: 30_000 });
	assert.equal(r.status, 'completed', JSON.stringify(r));
	assert.equal(r.rebuilt, 2);
	assert.deepEqual(dispatches, ['A', 'B']);
	assert.ok(r.results.every((p: any) => p.confirmedBy === 'pouredIdChange'));
	console.log(`change: rebuilt 2/2 in ${Date.now() - t0} ms`);

	// 2. No-op rebuild while EasyEDA keeps answering → unconfirmed, bounded.
	mode = 'noop'; wedged = false; dispatches = [];
	t0 = Date.now();
	r = await repour({ strategy: 'rebuild', perPourTimeoutMs: 2_000, totalTimeoutMs: 30_000 });
	assert.equal(r.status, 'partial');
	assert.equal(r.unconfirmed, 2);
	assert.ok(Date.now() - t0 < 8_000, 'noop run must stay inside the per-pour budgets');
	console.log(`noop: 2 unconfirmed in ${Date.now() - t0} ms`);

	// 3. Wedge after the first dispatch → stop, never dispatch the second pour.
	mode = 'wedge'; wedged = false; dispatches = [];
	t0 = Date.now();
	r = await repour({ strategy: 'rebuild', perPourTimeoutMs: 2_500, totalTimeoutMs: 60_000 });
	assert.equal(r.status, 'sdk-unresponsive', JSON.stringify(r));
	assert.deepEqual(dispatches, ['A'], 'no dispatch after EasyEDA went silent');
	assert.equal(r.results[1].status, 'not-started');
	assert.ok(Date.now() - t0 < 10_000, `wedge run returned in ${Date.now() - t0} ms`);
	console.log(`wedge: stopped after 1 dispatch in ${Date.now() - t0} ms`);

	// 4. Already wedged → probe fails, nothing dispatched.
	dispatches = [];
	t0 = Date.now();
	r = await repour({ strategy: 'rebuild' });
	assert.equal(r.status, 'sdk-unresponsive');
	assert.equal(dispatches.length, 0);
	assert.ok(Date.now() - t0 < 5_000);
	const s = await status({ probe: true });
	assert.equal(s.probe.responsive, false);
	console.log(`probe: refused to dispatch into a wedged host in ${Date.now() - t0} ms`);

	// 5. Background job: returns at once, status polls to completion; a second
	// start while running is refused.
	mode = 'change'; wedged = false; dispatches = [];
	t0 = Date.now();
	const bg = await repour({ strategy: 'rebuild', background: true, perPourTimeoutMs: 8_000 });
	assert.equal(bg.status, 'running');
	assert.ok(Date.now() - t0 < 1_000, 'background call returns immediately');
	await assert.rejects(() => repour({}), /still running/);
	let st: any;
	for (let i = 0; i < 60; i += 1) {
		st = await status({ jobId: bg.jobId });
		if (st.status !== 'running') break;
		await new Promise((res) => setTimeout(res, 250));
	}
	assert.equal(st.status, 'completed', JSON.stringify(st));
	console.log(`background: ${st.rebuilt} rebuilt, polled to completion in ${Date.now() - t0} ms`);

	// 6. Poured-fill API hangs but the SDK answers: no false "wedge"; the
	// promise confirms, a no-op rebuild is reported unconfirmed.
	pouredApiHangs = true; mode = 'resolve'; dispatches = [];
	t0 = Date.now();
	r = await repour({ strategy: 'rebuild', perPourTimeoutMs: 6_000, totalTimeoutMs: 60_000 });
	assert.equal(r.status, 'completed', JSON.stringify(r));
	assert.ok(r.results.every((p: any) => p.confirmedBy === 'promise'));
	mode = 'noop'; dispatches = [];
	r = await repour({ strategy: 'rebuild', perPourTimeoutMs: 2_000, totalTimeoutMs: 60_000 });
	assert.equal(r.status, 'partial', JSON.stringify(r));
	assert.equal(r.unconfirmed, 2);
	assert.deepEqual(dispatches, ['A', 'B']);
	// modify() resolving only proves the edit was accepted (live 2026-10-05:
	// "completed" modify runs left no copper) — never report it as rebuilt.
	r = await repour({ strategy: 'modify', perPourTimeoutMs: 6_000, totalTimeoutMs: 60_000 });
	assert.equal(r.status, 'partial', JSON.stringify(r));
	assert.equal(r.rebuilt, 0);
	assert.equal(r.unverified, 2);
	assert.ok(r.notes.some((n: string) => /unverified/.test(n) && /Shift\+B/.test(n)));
	pouredApiHangs = false;
	console.log(`poured API hang: promise-confirmed, unconfirmed and modify-unverified paths ok in ${Date.now() - t0} ms`);

	// 6b. native (default): EasyEDA's own copper engine via the host UI bridge —
	// the same events Shift+B fires — with results read back from the editor's
	// copper store (CopperSource). Mock the top-window UI (tabBar + buses).
	let nativeMode: 'complete' | 'ignore' | 'stall' = 'complete';
	let copperOnRebuild: 'new' | 'same' | 'none' = 'new';
	let copperReadable = true;
	let activeTab = 'doc1@proj';
	let gen = 0;
	const copper = new Map<string, string[]>([['A', ['fA0']]]); // B starts empty (never filled)
	const published: Array<{ topic: string; message: any }> = [];
	const listeners = new Map<string, Set<(m: unknown) => void>>();
	const emit = (topic: string, message: unknown) => { for (const fn of listeners.get(topic) ?? []) fn(message); };
	const copperSource = () => {
		const recs: string[] = [];
		for (const [pour, fills] of copper) for (const f of fills) recs.push(JSON.stringify(['POURED', f, pour, 0, true, [[0, 0, 'L', 100, 0, 100, -50, 'ARC', 90, 0, -50]]]));
		return ['["DOCTYPE", "POURED", "1.1"] ' + recs.join(' ')];
	};
	const applyRebuild = (ids: string[]) => {
		gen += 1;
		for (const id of ids) {
			if (copperOnRebuild === 'none') copper.delete(id);
			else if (copperOnRebuild === 'new') copper.set(id, [`f${id}${gen}a`, `f${id}${gen}b`]);
			else if (!copper.has(id)) copper.set(id, [`f${id}${gen}`]);
		}
	};
	g.UI = {
		tabBar: { getActiveTab: () => activeTab, getTabIFrame: async () => ({ contentWindow: { frame: 'pcb' } }) },
		gVars: {
			messageBus: {
				subscribe: (topic: string, fn: (m: unknown) => void) => {
					if (!listeners.has(topic)) listeners.set(topic, new Set());
					listeners.get(topic)!.add(fn);
					return { cancel: () => listeners.get(topic)!.delete(fn) };
				},
			},
			windowBridge: {
				rpcCall: async (topic: string, _message: unknown, target: any) => {
					assert.equal(topic, 'CopperSource');
					assert.equal(target?.frame, 'pcb');
					if (!copperReadable) throw new Error('rpc timeout');
					return { message: copperSource() };
				},
				publish: (topic: string, message: any, target: any) => {
					assert.equal(target?.frame, 'pcb', 'delivered into the PCB tab frame');
					published.push({ topic, message });
					if (topic === 'rebuildPlane' || nativeMode === 'ignore') return;
					const ids = topic === 'rebuildSingleCopper' ? message.ids : ['A', 'B'];
					setTimeout(() => emit('pcbUpdateProgress', { ratio: 0, descripte: 'copper' }), 50);
					if (nativeMode === 'stall') return;
					setTimeout(() => emit('setPcbTabUnSaved', ['someOtherTab@proj', true]), 100); // another tab's edit
					setTimeout(() => { applyRebuild(ids); emit('setPcbTabUnSaved', [activeTab, true]); }, 400);
				},
			},
		},
	};
	const activeListeners = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
	const byId = (res: any, id: string) => res.results.find((p: any) => p.primitiveId === id);

	// Copper status before any rebuild: B has no copper — reported, not hidden.
	let cs = await pourFillHandlers['pcb.copper.status']({});
	assert.equal(cs.available, true, JSON.stringify(cs));
	assert.deepEqual(cs.summary, { pours: 2, withCopper: 1, empty: 1, islands: 1 });
	assert.deepEqual(cs.emptyPours, ['B']);
	assert.deepEqual(cs.pours[0].bboxApprox, { minX: 0, minY: -50, maxX: 100, maxY: 0 }, 'ARC angle is not read as a coordinate');

	t0 = Date.now();
	r = await repour({});
	assert.equal(r.strategy, 'native');
	assert.equal(r.status, 'completed', JSON.stringify(r));
	assert.equal(r.rebuilt, 2);
	assert.equal(r.confirmedBy.copperSource, 2);
	assert.deepEqual(byId(r, 'A').copper.islands, 2);
	assert.equal(byId(r, 'A').fillIdsRemoved, 1);
	assert.deepEqual(published.map((p) => p.topic), ['rebuildCopper', 'rebuildPlane'], 'exactly what Shift+B publishes');
	assert.ok(r.diagnostics.nativeEvents.finishedAfterMs >= 350, 'another tab\'s unsaved event is not mistaken for completion');
	assert.equal(activeListeners(), 0, 'listeners cancelled');
	cs = await pourFillHandlers['pcb.copper.status']({});
	assert.deepEqual(cs.emptyPours, []);

	// Scoped: only the requested pour, by id.
	published.length = 0;
	r = await repour({ pourIds: ['A'] });
	assert.equal(r.status, 'completed', JSON.stringify(r));
	assert.deepEqual(published, [{ topic: 'rebuildSingleCopper', message: { ids: ['A'], isLast: false } }]);

	// Engine keeps identical copper → up-to-date, still completed.
	copperOnRebuild = 'same';
	r = await repour({ pourIds: ['A'] });
	assert.equal(r.status, 'completed', JSON.stringify(r));
	assert.equal(byId(r, 'A').status, 'up-to-date');

	// Rebuild ran but a pour ends with no copper → "empty", job NOT completed.
	copperOnRebuild = 'none';
	r = await repour({ pourIds: ['B'] });
	assert.equal(r.status, 'partial', JSON.stringify(r));
	assert.equal(byId(r, 'B').status, 'empty');
	assert.equal(r.empty, 1);
	assert.ok(r.notes.some((n: string) => /no copper after the rebuild: B/.test(n)));
	copperOnRebuild = 'new';

	// Editor finished but copper cannot be read back → unverified, never "rebuilt".
	copperReadable = false;
	r = await repour({ pourIds: ['A'] });
	assert.equal(r.status, 'partial', JSON.stringify(r));
	assert.equal(byId(r, 'A').status, 'unverified');
	assert.equal(r.rebuilt, 0);
	cs = await pourFillHandlers['pcb.copper.status']({});
	assert.equal(cs.available, false);
	copperReadable = true;

	nativeMode = 'ignore';
	t0 = Date.now();
	r = await repour({});
	assert.equal(r.status, 'failed', JSON.stringify(r));
	assert.ok(Date.now() - t0 < 12_000, 'an ignored request fails fast');
	assert.ok(r.notes.some((n: string) => /Shift\+B/.test(n)));
	assert.equal(activeListeners(), 0);

	nativeMode = 'stall';
	r = await repour({ totalTimeoutMs: 6_000 });
	assert.equal(r.status, 'deadline', JSON.stringify(r));
	assert.equal(r.unconfirmed, 2);

	nativeMode = 'complete';
	published.length = 0;
	activeTab = 'otherDoc@proj';
	r = await repour({});
	assert.equal(r.status, 'document-changed', JSON.stringify(r));
	assert.equal(published.length, 0, 'never rebuilds a tab other than the target document');
	activeTab = 'doc1@proj';

	const ui = g.UI;
	delete g.UI;
	r = await repour({});
	assert.equal(r.status, 'failed', JSON.stringify(r));
	assert.equal(r.diagnostics.nativeHost.via, null);
	assert.ok(r.notes.some((n: string) => /not reachable/.test(n) && /Shift\+B/.test(n)), 'fails loudly, never falls back to the SDK paths');
	g.UI = ui;
	console.log(`native: copper status, completed/scoped/up-to-date/empty/unverified/ignored/stalled/wrong-tab/unreachable paths ok in ${Date.now() - t0} ms`);

	// 7. native_operation_reset runs registered release hooks (doc locks).
	let hookRan = false;
	onNativeOperationsReset(() => { hookRan = true; return { docLocksCleared: 3 }; });
	const reset = resetNativeOperations({ clearQuarantine: true });
	assert.ok(hookRan);
	assert.equal((reset as any).released.docLocksCleared, 3);

	console.log('Repour safety: bounded success/no-op/wedge/probe/background paths and reset hooks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
