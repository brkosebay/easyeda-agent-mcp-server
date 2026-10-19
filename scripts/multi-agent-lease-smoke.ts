// Work-lease enforcement, driven through the real daemon RPC path with a fake
// extension. Run: npx ts-node scripts/multi-agent-lease-smoke.ts
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.EDA_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'eda-lease-smoke-'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Daemon } = require('../src/daemon/index');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LeaseManager } = require('../src/daemon/lease-manager');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { methodIsWrite } = require('../src/daemon/protocol');

const daemon = new Daemon() as any;
daemon.log = () => {};
const sent: any[] = [];
const replies: any[] = [];
const ext: any = {
	ws: { readyState: 1 },
	info: {
		instanceId: 'aaaaaaaa',
		currentDocument: 'docA@proj',
		documents: [{ title: 'PCB1', uuid: 'docA@proj' }, { title: 'SCH1', uuid: 'docB@proj' }],
	},
	pending: new Map(),
	infoWaiters: new Map(),
	rpcCount: 0,
	tabSwitches: 0,
};
daemon.extensions.set('aaaaaaaa', ext);
daemon.sendExtension = async (_conn: unknown, frame: any) => { sent.push(frame); };
daemon.writeAgent = (_agent: unknown, msg: any) => replies.push(msg);
const orchestrator = { agentId: 'orch' };
daemon.agents.set('orch', orchestrator);

let seq = 0;
async function rpc(msg: Record<string, unknown>, respond = true): Promise<{ frame?: any; reply?: any }> {
	const id = `m${++seq}`;
	const before = sent.length;
	await daemon.handleRpc(orchestrator, { type: 'rpc', id, ...msg });
	const frame = sent.length > before ? sent[sent.length - 1] : undefined;
	if (frame && respond) daemon.routeExtensionResponse(ext, { id: frame.id, result: 'ok' });
	return { frame, reply: replies.find((r) => r.id === id) };
}
function lease(msg: Record<string, unknown>): any {
	const id = `l${++seq}`;
	daemon.handleLease(orchestrator, { type: 'lease', id, ...msg });
	const reply = replies.find((r) => r.id === id);
	assert.ok(reply, 'lease reply');
	return reply;
}

(async () => {
	// --- write classification is shared with the extension (fail-closed) ---
	assert.equal(methodIsWrite('pcb.select.net'), true, 'unlisted method is a write');
	assert.equal(methodIsWrite('pcb.getAll.via'), false);
	assert.equal(methodIsWrite('sch.extract.design'), false);
	assert.equal(methodIsWrite('editor.native.resetQueue'), false, 'gate-bypass recovery never takes the doc lock');

	// --- no leases: today's behaviour, document falls back to the active tab ---
	let r = await rpc({ method: 'pcb.create.track', params: {} });
	assert.equal(r.reply.error, undefined);
	assert.equal(r.frame.params.document, 'docA@proj');

	// --- exclusive lease pins and protects its document ---
	const claim = lease({ action: 'claim', documents: ['PCB1'], owner: 'router', task: 'route USB' });
	assert.equal(claim.error, undefined);
	const routerLease = claim.result.leaseId as string;
	assert.deepEqual(claim.result.documents, ['docA'], 'title resolves to bare UUID');

	r = await rpc({ method: 'pcb.create.track', document: 'docA', params: {} });
	assert.match(r.reply.error, /reserved.*router/, 'non-holder write refused');
	assert.equal(r.frame, undefined, 'refused write never reaches EasyEDA');

	r = await rpc({ method: 'pcb.create.track', params: {} });
	assert.match(r.reply.error, /must name their "document"/, 'lease-less write must name its document');

	r = await rpc({ method: 'pcb.getAll.via', document: 'docA', params: {} });
	assert.equal(r.reply.error, undefined, 'reads stay open');

	ext.info.currentDocument = 'docB@proj'; // another agent switched tabs
	r = await rpc({ method: 'pcb.create.track', leaseId: routerLease, params: {} });
	assert.equal(r.reply.error, undefined);
	assert.equal(r.frame.params.document, 'docA', 'lease pins the document, not the active tab');

	r = await rpc({ method: 'pcb.create.track', leaseId: routerLease, document: 'docB', params: {} });
	assert.match(r.reply.error, /covers docA, not docB/);

	r = await rpc({ method: 'pcb.create.track', leaseId: routerLease, document: 'PCB1', params: {} });
	assert.equal(r.reply.error, undefined, 'title alias accepted');

	r = await rpc({ method: 'sch.create.wire', document: 'docB', params: {} });
	assert.equal(r.reply.error, undefined, 'unleased document stays writable');

	assert.match(lease({ action: 'claim', documents: ['docA'], owner: 'placer' }).error, /already leased.*router/);
	assert.match(lease({ action: 'claim', documents: ['docA'], owner: 'x', mode: 'shared', scope: { nets: ['GND'] } }).error, /already leased/);

	// --- read leases are enforced read-only ---
	const reviewer = lease({ action: 'claim', mode: 'read', owner: 'emc-review' }).result.leaseId;
	r = await rpc({ method: 'pcb.getAll.via', leaseId: reviewer, document: 'docA', params: {} });
	assert.equal(r.reply.error, undefined);
	r = await rpc({ method: 'sch.create.wire', leaseId: reviewer, document: 'docB', params: {} });
	assert.match(r.reply.error, /read-only lease/);

	// --- shared leases: disjoint declared scopes coexist ---
	assert.equal(lease({ action: 'claim', mode: 'shared', documents: ['docB'], owner: 'w1', scope: { nets: ['USB_D+'] } }).error, undefined);
	assert.match(lease({ action: 'claim', mode: 'shared', documents: ['docB'], owner: 'w2', scope: { nets: ['usb_d+'] } }).error, /overlaps.*nets "usb_d\+"/i);
	assert.equal(lease({ action: 'claim', mode: 'shared', documents: ['docB'], owner: 'w3', scope: { nets: ['GND'] } }).error, undefined);
	const w4 = lease({ action: 'claim', mode: 'shared', documents: ['docB'], owner: 'w4', scope: { designators: ['U3'] } });
	assert.equal(w4.error, undefined);
	assert.ok(w4.result.warnings?.some((w: string) => /disjointness could not be checked/.test(w)));
	assert.match(lease({ action: 'claim', mode: 'shared', documents: ['docB'], owner: 'w5' }).error, /must declare a scope/);

	// --- gate recovery is orchestrator-only while leases exist ---
	r = await rpc({ method: 'editor.native.resetQueue', params: {} });
	assert.match(r.reply.error, /affects every agent/);
	r = await rpc({ method: 'editor.native.resetQueue', leaseId: routerLease, params: {} });
	assert.match(r.reply.error, /only the orchestrator/);
	r = await rpc({ method: 'editor.native.resetQueue', overrideLeases: true, params: {} });
	assert.equal(r.reply.error, undefined);

	// --- canonical lock key: `docA` and `docA@proj` serialize together ---
	lease({ action: 'release', all: true });
	const first = rpc({ method: 'pcb.create.via', document: 'docA@proj', params: {} }, false);
	await first;
	const held = sent[sent.length - 1];
	const countBefore = sent.length;
	const second = rpc({ method: 'pcb.create.via', document: 'docA', params: {} });
	await new Promise((res) => setTimeout(res, 20));
	assert.equal(sent.length, countBefore, 'second write waits for the first (same document)');
	daemon.routeExtensionResponse(ext, { id: held.id, result: 'ok' });
	await second;
	assert.equal(sent.length, countBefore + 1);

	// --- schematic extract cache: sch writes invalidate, pcb writes do not ---
	const extract = { method: 'sch.extract.design', document: 'docB', params: { allPages: true } };
	r = await rpc(extract);
	assert.ok(r.frame, 'first extract hits EasyEDA');
	r = await rpc(extract);
	assert.equal(r.frame, undefined, 'second extract served from daemon cache');
	await rpc({ method: 'pcb.create.via', document: 'docA', params: {} });
	r = await rpc(extract);
	assert.equal(r.frame, undefined, 'PCB write leaves schematic cache alone');
	await rpc({ method: 'sch.create.wire', document: 'docC', params: {} });
	r = await rpc(extract);
	assert.ok(r.frame, 'write on another schematic page invalidates the extract');

	// --- tab-switch telemetry ---
	const list = lease({ action: 'list' }).result;
	assert.ok(list.instances[0].tabSwitches > 0 && list.instances[0].rpcs > 0);

	// --- TTL: expiry, and writes sliding it forward ---
	let now = 0;
	const lm = new LeaseManager(() => now);
	const a = lm.claim({ instanceId: 'i', documents: ['d1'], mode: 'exclusive', owner: 'a', ttlMs: 10_000, creatorAgentId: 'x' }).lease;
	now = 8_000; lm.touch(a, false);
	now = 16_000; assert.ok(lm.get(a.leaseId), 'any use renews the lease');
	now = 30_000; assert.equal(lm.get(a.leaseId), undefined, 'idle lease expires');
	assert.ok(lm.claim({ instanceId: 'i', documents: ['d1'], mode: 'exclusive', owner: 'b', creatorAgentId: 'x' }).lease, 'expired lease frees the document');

	// --- leases die with the daemon connection that claimed them ---
	const socket = Object.assign(new EventEmitter(), { written: [] as string[], write(line: string) { this.written.push(line); return true; }, destroy() {} });
	const fresh = new Daemon() as any;
	fresh.log = () => {};
	fresh.extensions.set('aaaaaaaa', { ...ext, pending: new Map() });
	fresh.handleAgent(socket, 'tok');
	socket.emit('data', JSON.stringify({ type: 'auth', token: 'tok', clientInfo: { pid: 1 }, mcpVersion: '1' }) + '\n');
	socket.emit('data', JSON.stringify({ type: 'lease', id: 'c1', action: 'claim', documents: ['docA'], owner: 'sub' }) + '\n');
	await new Promise((res) => setTimeout(res, 10));
	assert.equal(fresh.leases.active().length, 1);
	socket.emit('close');
	assert.equal(fresh.leases.active().length, 0, 'disconnect releases the agent\'s leases');

	console.log('Multi-agent work leases: all checks passed.');
	process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
