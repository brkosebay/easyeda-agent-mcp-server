// Unit checks for the fixes in fix/sch-write-blockers. Run:
//   npx ts-node scripts/sch-write-blockers-smoke.ts
import assert from 'node:assert/strict';
import {
	createNativeOperationGate,
	createNativeOperationState,
	nativeOperationStatus,
	resetNativeOperations,
	acknowledgeNativeOperation,
} from '../src/extension/native-operation-gate';
import {
	classifyNetSymbol,
	correctedCoordinate,
	decideComponentYFrame,
	mergeOtherProperty,
	normalizeWireLine,
	parseSchNetSymbols,
	primitiveIdNumber,
} from '../src/extension/handlers/sch-geometry';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gateWatchdog(): Promise<void> {
	// Issue 1: a read that never settles must not wedge the queue.
	const state = createNativeOperationState();
	const gate = createNativeOperationGate(state);
	const hung = gate(false, () => new Promise<never>(() => {}), { label: 'sch.select.getAll', timeoutMs: 30 });
	const queuedRan: string[] = [];
	const next = gate(false, async () => { queuedRan.push('connectivity'); return 'ok'; }, { label: 'sch.connectivity.get', timeoutMs: 500 });
	await sleep(5);
	const busy = nativeOperationStatus(state);
	assert.equal(busy.status, 'busy');
	assert.equal(busy.active?.label, 'sch.select.getAll');
	assert.equal(busy.queued, 1);
	await assert.rejects(hung, /released its queue slot/);
	assert.equal(await next, 'ok');
	assert.deepEqual(queuedRan, ['connectivity']);
	const after = nativeOperationStatus(state);
	assert.equal(after.status, 'ready');
	assert.equal(after.abandoned.length, 1);
	assert.equal(after.abandoned[0].settled, false);

	// A request whose caller gave up while it was queued is skipped, not run late.
	const s2 = createNativeOperationState();
	const g2 = createNativeOperationGate(s2);
	let lateWriteRan = false;
	const blocker = g2(false, () => sleep(60), { label: 'slow read', timeoutMs: 1000 });
	const stale = g2(true, async () => { lateWriteRan = true; }, { label: 'sch.wire.create', timeoutMs: 20, enqueuedAt: Date.now() });
	await blocker;
	await assert.rejects(stale, /was not started/);
	assert.equal(lateWriteRan, false);

	// A hung write quarantines (existing safety semantics) and settles later.
	const s3 = createNativeOperationState();
	const g3 = createNativeOperationGate(s3);
	let finish!: () => void;
	const write = g3(true, () => new Promise<void>((r) => { finish = r; }), { label: 'sch.component.modify', timeoutMs: 20 });
	await assert.rejects(write, /blocked pending reconciliation/);
	assert.equal(nativeOperationStatus(s3).status, 'reconciliation-required');
	await assert.rejects(g3(false, async () => 1, { timeoutMs: 100 }), /requires reconciliation/);
	finish(); await sleep(0);
	assert.equal(s3.uncertain?.outcome, 'fulfilled');
	acknowledgeNativeOperation(s3.uncertain!.id, s3);
	assert.equal(await g3(false, async () => 7, { timeoutMs: 100 }), 7);

	// Operator reset releases a tail left by a gate call without a deadline.
	const s4 = createNativeOperationState();
	const g4 = createNativeOperationGate(s4);
	void g4(false, () => new Promise<never>(() => {})).catch(() => undefined);
	let ran = false;
	const blocked = g4(false, async () => { ran = true; });
	await sleep(5);
	assert.equal(ran, false);
	resetNativeOperations({}, s4);
	assert.equal(await g4(false, async () => 'fresh', { timeoutMs: 100 }), 'fresh');
	void blocked;

	// clearQuarantine drops a write that can never settle.
	const s5 = createNativeOperationState();
	const g5 = createNativeOperationGate(s5);
	await assert.rejects(g5(true, () => new Promise<never>(() => {}), { label: 'stuck', timeoutMs: 10 }));
	assert.equal(nativeOperationStatus(s5).status, 'reconciliation-required');
	resetNativeOperations({ clearQuarantine: true }, s5);
	assert.equal(nativeOperationStatus(s5).status, 'ready');
	assert.equal(await g5(true, async () => 'ok', { timeoutMs: 100 }), 'ok');
}

function wireLines(): void {
	// Issue 4: point pairs become ONE polyline.
	assert.deepEqual(normalizeWireLine([[260, -580], [285, -580]]), [260, -580, 285, -580]);
	assert.deepEqual(normalizeWireLine([260, -580, 285, -580]), [260, -580, 285, -580]);
	assert.deepEqual(normalizeWireLine([[0, 0, 10, 0], [10, 0, 10, 10]]), [[0, 0, 10, 0], [10, 0, 10, 10]]);
	assert.throws(() => normalizeWireLine([[1, 2]]), /at least two points/);
	assert.throws(() => normalizeWireLine([1, 2, 3]), /even number/);
	assert.throws(() => normalizeWireLine([1, [2, 3]] as any), /mixes/);
}

function frames(): void {
	// Issue 7: Q1 reported at y=600 with pins at y≈-600 → flip.
	const flip = decideComponentYFrame([
		{ componentY: 600, pinYs: [-590, -610, -600] },
		{ componentY: 300, pinYs: [-280, -320] },
	]);
	assert.equal(flip.flip, true);
	assert.equal(flip.decided, true);
	const same = decideComponentYFrame([{ componentY: 600, pinYs: [590, 610] }]);
	assert.equal(same.flip, false);
	// Parts at y≈0 are ambiguous → fallback, not a wrong decision.
	const ambiguous = decideComponentYFrame([{ componentY: 2, pinYs: [-10, 10] }], true);
	assert.equal(ambiguous.decided, false);
	assert.equal(ambiguous.flip, true);
}

function modifyHelpers(): void {
	// Issue 2: mirror negated x → resend negated; offset → compensate.
	assert.equal(correctedCoordinate(260, 260, 260), undefined);
	assert.equal(correctedCoordinate(260, 260, -260), -260);
	assert.equal(correctedCoordinate(260, 260, 250), 270);
	const merged = mergeOtherProperty({ Value: '10k', 'LCSC Part': 'C25804', Empty: '' }, { Value: '22k', Note: null } as any);
	assert.deepEqual(merged, { Value: '22k', 'LCSC Part': 'C25804', Empty: '', Note: '' });
}

function netSymbols(): void {
	// Issue 6: classify flags/ports even when EasyEDA files them as parts.
	assert.equal(classifyNetSymbol({ componentType: 'netflag' }), 'netflag');
	assert.equal(classifyNetSymbol({ componentType: 'part', component: { name: 'Ground-GND' } }), 'netflag');
	assert.equal(classifyNetSymbol({ componentType: 'part', symbol: { name: 'Netport-OUT' } }), 'netport');
	assert.equal(classifyNetSymbol({ componentType: 'part', component: { name: 'FQP17P06' } }), undefined);
}

function sourceNetSymbols(): void {
	// Record shapes copied from a real EasyEDA Pro 2.2.47 .esch page.
	const source = [
		'["DOCTYPE","SCH","1.1"]',
		'["COMPONENT","e1","",0,0,0,0,{},0]',
		'["ATTR","e32","e1","Symbol","e8efebf203f74365bbb94e9db5f56c7b",null,null,null,null,null,"st1",0]',
		'["COMPONENT","e3836","FQP17P06.1",260,600,0,0,{},0]',
		'["ATTR","e3837","e3836","Designator","Q1",null,null,null,null,null,"st1",0]',
		'["COMPONENT","e287","",155,505,0,0,{},0]',
		'["ATTR","e288","e287","Symbol","2711c963131e47c98500d62db3c16e84",null,null,null,null,null,"st1",0]',
		'["ATTR","e289","e287","Device","1c18ed5a06f64a07bdb5b0cf525b3d9e",null,null,null,null,null,"st1",0]',
		'["ATTR","e290","e287","Name","GND",null,null,null,null,null,"st1",0]',
		'["COMPONENT","e900","",1050,595,180,1,{},0]',
		'["ATTR","e901","e900","Name","+5V_FILTERED",null,null,null,null,null,"st1",0]',
		'["ATTR","e902","e900","Device","4eff39f2ef7f44d7a0f9c9645fba922b",null,null,null,null,null,"st1",0]',
		'["WIRE","e536",[[155,505,155,540]],"st7",0]',
	].join('\n');
	const syms = parseSchNetSymbols(source);
	assert.deepEqual(syms.map((s) => [s.id, s.name, s.x, s.y, s.rotation, s.mirror]), [
		['e287', 'GND', 155, 505, 0, false],
		['e900', '+5V_FILTERED', 1050, 595, 180, true],
	]);
	assert.equal(syms[0].deviceUuid, '1c18ed5a06f64a07bdb5b0cf525b3d9e');
	assert.equal(primitiveIdNumber('$1I287'), '287');
	assert.equal(primitiveIdNumber('e287'), '287');
}

async function main(): Promise<void> {
	await gateWatchdog();
	wireLines();
	frames();
	modifyHelpers();
	netSymbols();
	sourceNetSymbols();
	console.log('sch-write-blockers smoke: gate watchdog, wire lines, frame calibration, modify helpers, net symbols — passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

// Selection guard routing (pure part).
import { selectionGuardKind, schEditorId } from '../src/extension/selection-guard';
assert.equal(selectionGuardKind('sch.component.modify', false), 'sch');
assert.equal(selectionGuardKind('pcb.component.move', false), 'pcb');
assert.equal(selectionGuardKind('sch.select.crossProbe', false), undefined);
assert.equal(selectionGuardKind('sch.component.getAll', true), undefined);
assert.equal(selectionGuardKind('editor.native.set', false), undefined);
assert.equal(schEditorId('$4I4008'), 'e4008');
console.log('selection guard routing: passed.');

// Connectivity geometry fallback (pure part).
import { pinNetsFromGeometry } from '../src/extension/handlers/sch-geometry';
{
	const geo = pinNetsFromGeometry(
		[{ number: '1', name: 'TXD', x: 445, y: -690 }, { number: '8', name: 'S', x: 500, y: -700 }, { number: '3', x: 430, y: -660 }, { number: '5', x: 460, y: -660 }],
		[
			{ line: [445, -690, 400, -690], net: 'CAN_TX' },           // pin at wire end
			{ line: [[480, -700, 520, -700]], net: '' },                // pin mid-segment, unnamed…
			{ line: [460, -660, 460, -640], net: '' },                  // unnamed, named by a flag at its vertex
		],
		[{ x: 520, y: -700, net: '+3.3V' }, { x: 430, y: -660, net: 'GND' }, { x: 460, y: -640, net: '+5V_FILTERED' }],
	);
	assert.deepEqual(Object.fromEntries(Object.entries(geo).map(([k, v]) => [k, v.net])), { 1: 'CAN_TX', 8: '+3.3V', 3: 'GND', 5: '+5V_FILTERED' });
	console.log('connectivity geometry fallback: passed.');
}
