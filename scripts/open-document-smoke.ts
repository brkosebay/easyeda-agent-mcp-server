// Tab activation (editor_open_document + ensureDocument) is fire-and-verify
// and must never quarantine the operation gate. Mocks the EasyEDA runtime.
import assert from 'node:assert/strict';
import { openNativeDocument, activateNativeDocument, pendingDocumentOpens, DEFAULT_DOCUMENT_OPEN_WAIT_MS, DocumentActivationError } from '../src/extension/document-context';
import { createNativeOperationGate, nativeOperationStatus } from '../src/extension/native-operation-gate';
import { editorHandlers } from '../src/extension/handlers/editor';

type Doc = { uuid: string; documentType?: number; parentProjectUuid?: string; parentLibraryUuid?: string; tabId?: string };
interface Setup {
	active: Doc;
	pcbs?: string[];
	schematics?: Array<{ uuid: string; page: Array<{ uuid: string }> }>;
	tabs?: string[];
	bus?: (payload: { uuid: string }) => Promise<unknown>;
	open?: (id: string) => Promise<unknown>;
	activate?: (tabId: string) => Promise<unknown>;
}

const root = globalThis as any;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<never>(() => {});
const pcbDoc = (uuid: string): Doc => ({ uuid, documentType: 3, parentProjectUuid: 'project', tabId: `${uuid}@project` });
const fast = { pollMs: 10, failedGraceMs: 30 };

function install(setup: Setup) {
	const world = { active: setup.active, project: 'project', tabs: setup.tabs ?? [], calls: { open: 0, bus: 0, activate: 0 } };
	root.eda = {
		dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: world.project }) },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => world.active },
		dmt_Pcb: { getAllPcbsInfo: async () => (setup.pcbs ?? []).map((uuid) => ({ uuid })) },
		dmt_Schematic: { getAllSchematicsInfo: async () => setup.schematics ?? [] },
		dmt_EditorControl: {
			getSplitScreenTree: async () => ({ id: 'root', tabs: [{ tabId: 'tab_page1' }], children: [{ tabs: world.tabs.map((tabId) => ({ tabId })) }] }),
			activateDocument: async (tabId: string) => {
				world.calls.activate++;
				if (setup.activate) return setup.activate(tabId);
				world.active = pcbDoc(tabId.split('@')[0]);
				return true;
			},
			openDocument: async (id: string) => {
				world.calls.open++;
				return setup.open ? setup.open(id) : undefined;
			},
		},
	};
	root.UI = setup.bus
		? { gVars: { messageBus: { rpcCall: async (topic: string, payload: { uuid: string }) => { assert.equal(topic, 'openPcbByUUid'); world.calls.bus++; return setup.bus!(payload); } } } }
		: undefined;
	return world;
}

function assertGateUsable(context: string) {
	const status = nativeOperationStatus();
	assert.equal(status.uncertain, null, `${context}: gate must not be quarantined`);
	assert.notEqual(status.status, 'reconciliation-required', context);
}

async function main() {
	assert.ok(DEFAULT_DOCUMENT_OPEN_WAIT_MS >= 45_000, 'default wait is sized for large PCBs, not the old 15 s');

	// 1. Slow cold open of a large PCB: the native opener never settles (render
	// tick), the tab appears later. Succeeds within the budget, no quarantine.
	let world = install({
		active: pcbDoc('small'), pcbs: ['small', 'big'],
		bus: () => { setTimeout(() => { world.active = pcbDoc('big'); }, 600); return never(); },
	});
	let result = await openNativeDocument('big', { timeoutMs: 5_000, ...fast });
	assert.equal(result.via, 'open-pcb');
	assert.equal(result.alreadyActive, false);
	assert.ok(result.waitedMs >= 550, `waited ${result.waitedMs}ms for the load`);
	assert.equal(world.calls.bus, 1);
	assert.equal(world.calls.open, 0);
	assert.deepEqual(pendingDocumentOpens(), [], 'a confirmed open leaves nothing in flight');
	assertGateUsable('slow cold open');

	// Same without the internal bus: public openDocument never settles (Pro 2.2 tabChange race).
	world = install({
		active: pcbDoc('small'), pcbs: ['small', 'big'],
		open: () => { setTimeout(() => { world.active = pcbDoc('big'); }, 300); return never(); },
	});
	result = await openNativeDocument('big', { timeoutMs: 5_000, ...fast });
	assert.equal(result.via, 'open-document');
	assert.equal(world.calls.open, 1);

	// 2. Already active returns immediately, with no native call.
	world = install({ active: pcbDoc('big'), pcbs: ['big'] });
	let started = Date.now();
	result = await openNativeDocument('big@project');
	assert.equal(result.alreadyActive, true);
	assert.equal(result.via, 'already-active');
	assert.ok(Date.now() - started < 200);
	assert.deepEqual(world.calls, { open: 0, bus: 0, activate: 0 });

	// Already-open tab is activated, not re-opened.
	world = install({ active: pcbDoc('small'), pcbs: ['small', 'big'], tabs: ['small@project', 'big@project'], bus: () => never() });
	result = await openNativeDocument('big', { timeoutMs: 2_000, ...fast });
	assert.equal(result.via, 'activate-tab');
	assert.deepEqual(world.calls, { open: 0, bus: 0, activate: 1 });

	// 3. Genuine failures report precisely and leave the gate usable.
	world = install({ active: pcbDoc('small'), pcbs: ['small'], open: async () => undefined });
	await assert.rejects(openNativeDocument('libfp', { timeoutMs: 2_000, ...fast }), (error: Error) => {
		assert.ok(error instanceof DocumentActivationError);
		assert.match(error.message, /did not reach/);
		assert.match(error.message, /returned no tab/);
		assert.match(error.message, /Requested libfp; active document is small \(PCB, project project\)/);
		assert.match(error.message, /libfp is not a PCB, schematic or schematic page/);
		assert.match(error.message, /Document actions are not blocked/);
		return true;
	});
	world = install({ active: pcbDoc('small'), pcbs: ['small'], open: async () => { throw new Error('boom'); } });
	await assert.rejects(openNativeDocument('x', { timeoutMs: 2_000, ...fast }), /rejected the open request: boom/);
	assertGateUsable('failed open');
	assert.equal(await createNativeOperationGate()(true, async () => 42, { label: 'pcb.test.write', timeoutMs: 1_000 }), 42, 'writes still run after a failed open');

	// 4. Timeout while EasyEDA is still loading: precise, non-quarantining; a
	// retry joins the in-progress open instead of opening a second copy.
	let finish!: () => void;
	world = install({
		active: pcbDoc('small'), pcbs: ['small', 'huge'],
		open: (id) => new Promise((resolve) => { finish = () => { world.active = pcbDoc('huge'); resolve(`${id}@project`); }; }),
	});
	await assert.rejects(openNativeDocument('huge', { timeoutMs: 1_000, ...fast }), (error: Error) => {
		assert.ok(error instanceof DocumentActivationError);
		assert.match(error.message, /Opening document huge did not complete within 1000ms/);
		assert.match(error.message, /active document is small \(PCB, project project\)/);
		assert.match(error.message, /still loading it \(open-document requested \d+ms ago/);
		assert.match(error.message, /joins this open/);
		assert.match(error.message, /Document actions are not blocked/);
		assert.equal(error.details.inProgress, true);
		return true;
	});
	assertGateUsable('timed-out open');
	assert.equal(pendingDocumentOpens().filter((open) => open.target === 'huge' && !open.settled).length, 1);
	const retry = openNativeDocument('huge', { timeoutMs: 3_000, ...fast });
	await sleep(150);
	finish();
	result = await retry;
	assert.equal(result.via, 'joined-in-progress');
	assert.equal(world.calls.open, 1, 'the retry must not open the document a second time');
	assert.deepEqual(pendingDocumentOpens(), []);

	// 5. Concurrent calls for the same document dispatch exactly one open.
	world = install({
		active: pcbDoc('small'), pcbs: ['small', 'big2'],
		bus: () => { setTimeout(() => { world.active = pcbDoc('big2'); }, 250); return never(); },
	});
	const both = await Promise.all([openNativeDocument('big2', { timeoutMs: 3_000, ...fast }), openNativeDocument('big2', { timeoutMs: 3_000, ...fast })]);
	assert.equal(world.calls.bus, 1);
	assert.deepEqual(both.map((r) => r.via).sort(), ['joined-in-progress', 'open-pcb']);

	// 6. A schematic UUID is reached when one of its pages becomes active.
	const page = (uuid: string): Doc => ({ uuid, documentType: 1, parentProjectUuid: 'project', tabId: `${uuid}@project` });
	world = install({
		active: pcbDoc('small'), pcbs: ['small'], schematics: [{ uuid: 'schA', page: [{ uuid: 'pageA1' }, { uuid: 'pageA2' }] }],
		open: async (id) => { assert.equal(id, 'schA'); world.active = page('pageA1'); return 'pageA1@project'; },
	});
	result = await openNativeDocument('schA', { timeoutMs: 2_000, ...fast });
	assert.equal(result.document.uuid, 'pageA1');
	assert.equal((await openNativeDocument('schA')).alreadyActive, true);
	// A specific page that is open in a tab is activated directly.
	world.tabs = ['pageA1@project', 'pageA2@project'];
	root.eda.dmt_EditorControl.activateDocument = async (tabId: string) => { world.calls.activate++; world.active = page(tabId.split('@')[0]); return true; };
	result = await openNativeDocument('pageA2', { timeoutMs: 2_000, ...fast });
	assert.equal(result.via, 'activate-tab');
	assert.equal(result.document.uuid, 'pageA2');

	// 7. In-PCB footprint tabs (`<pcb>_<primitiveId>`, no parentProjectUuid) are
	// bound through their PCB; library documents are not project documents.
	world = install({
		active: pcbDoc('big'), pcbs: ['big'],
		open: (id) => { setTimeout(() => { world.active = { uuid: 'big_e914', documentType: 4 }; }, 100); return never(); },
	});
	result = await openNativeDocument('!big_e914', { timeoutMs: 2_000, ...fast });
	assert.equal(result.document.uuid, 'big_e914');
	assert.equal((await openNativeDocument('big_e914')).alreadyActive, true, 'an active footprint tab is not a project mismatch');
	world = install({ active: { uuid: 'libfp', documentType: 4, parentLibraryUuid: 'lib1' }, pcbs: ['big'] });
	await assert.rejects(activateNativeDocument('libfp', fast), /not bound to the current project project/);
	assert.equal(world.calls.open, 0);

	// 8. Race with the user: EasyEDA reports the open done but focus went
	// elsewhere — the tab is focused once, then the call succeeds.
	world = install({
		active: pcbDoc('small'), pcbs: ['small', 'big3'],
		open: async (id) => { world.tabs = ['small@project', `${id}@project`]; return `${id}@project`; },
	});
	result = await openNativeDocument('big3', { timeoutMs: 4_000, ...fast });
	assert.equal(world.calls.activate, 1);
	assert.equal(result.document.uuid, 'big3');

	// 9. Project binding: a project switch mid-open is reported, not accepted.
	world = install({
		active: pcbDoc('small'), pcbs: ['small', 'big4'],
		open: async () => { world.active = pcbDoc('big4'); world.project = 'project2'; return 'big4@project'; },
	});
	await assert.rejects(openNativeDocument('big4', { timeoutMs: 2_000, ...fast }), /did not reach.*active project changed from project to project2/);

	// 10. Handler path under the real gate: the wait ends before the gate
	// deadline, so a stuck open returns our error instead of tripping the
	// write watchdog (which would quarantine every later edit).
	world = install({ active: pcbDoc('small'), pcbs: ['small', 'stuck'], open: () => never() });
	const gate = createNativeOperationGate();
	const openHandler = editorHandlers['editor.openDocument'];
	started = Date.now();
	await assert.rejects(
		gate(true, () => openHandler({ documentUuid: 'stuck', _gateDeadlineAt: Date.now() + 2_600, pollMs: 10 }), { label: 'editor.openDocument', timeoutMs: 2_600 }),
		/Opening document stuck did not complete within/,
	);
	assert.ok(Date.now() - started < 2_600);
	assertGateUsable('handler with gate deadline');
	// Tool-shaped params: absolute waitUntil + relative _timeoutMs.
	await assert.rejects(
		gate(true, () => openHandler({ documentUuid: 'stuck', timeoutMs: 45_000, waitUntil: Date.now() + 1_200, _timeoutMs: 6_000, pollMs: 10 }), { label: 'editor.openDocument', timeoutMs: 6_000 }),
		/did not complete within 12\d\dms|did not complete within 1[01]\d\dms/,
	);
	assertGateUsable('handler with waitUntil');
	// The handler reports alreadyActive/via alongside the document identity.
	world.active = pcbDoc('stuck');
	const shaped = await gate(true, () => openHandler({ documentUuid: 'stuck@project', _timeoutMs: 6_000 }), { label: 'editor.openDocument', timeoutMs: 6_000 });
	assert.equal(shaped.uuid, 'stuck');
	assert.equal(shaped.alreadyActive, true);
	assert.equal(shaped.via, 'already-active');
	await assert.rejects(openHandler({}), /requires documentUuid/);
	assertGateUsable('end');

	console.log('Open document: slow cold open, already-active fast path, precise failures, in-progress join, concurrency, schematic/footprint binding, focus race and gate-deadline cap: passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
