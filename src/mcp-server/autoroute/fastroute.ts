// fastroute (https://github.com/parisxmas/fastroute, GPL-3.0): a Rust port of
// FreeRouting with the same DSN -> SES contract plus differential pairs,
// length matching and no-neck-down classes. It runs as a separate process, so
// nothing here links against it.
//
// Pipeline for one run (the caller has already exported and layer-patched the
// EasyEDA DSN):
//   1. read the board's rules over the bridge (rule config, net rules, diff
//      pairs, equal-length groups)
//   2. normalize the DSN to microns and replace its net classes (specctra.ts)
//   3. write --pairs / --tune files and build the command line
//      (fastroute-config.ts)
//   4. run fastroute with --max-time (soft stop, best result kept) under a
//      hard timeout that SIGTERMs, waits, then reads the checkpointed SES
//   5. scale the SES back to EasyEDA units so every existing importer works

import { spawn } from 'child_process';
import { access, constants, readFile, writeFile } from 'fs/promises';
import { delimiter, join, resolve } from 'path';
import type { WebSocketBridge } from '../bridge';
import { normalizeDiffPairs } from '../../shared/drc-rules';
import {
	buildFastrouteConfig,
	normalizeEqualLengthGroups,
	pairsFileText,
	tuneFileText,
	type EasyedaRuleInputs,
	type FastrouteConfig,
	type FastrouteConfigOptions,
} from './fastroute-config';
import { runtimeRootCandidates, uniqueStrings } from './runtime-paths';
import { collectAndAddPourPlanes, type PlaneResult } from './pour-planes';
import {
	EASYEDA_DSN_UNIT_UM,
	NORMALIZED_RESOLUTION,
	atomText,
	childLists,
	cloneTree,
	denormalizeSes,
	dsnNetCopper,
	firstChild,
	normalizeDsnToMicrons,
	parseSexpr,
	readDsnNetwork,
	replaceNetClasses,
	sesNetCopper,
	setDsnWiring,
	shrinkPinPadstacks,
	writeSexpr,
	type NetCopper,
	type SList,
	type WiringDecision,
} from './specctra';

const EXE = process.platform === 'win32' ? 'fastroute.exe' : 'fastroute';

export async function resolveFastrouteBinary(): Promise<{ path?: string; searched: string[] }> {
	const envPath = process.env.FASTROUTE_BIN?.trim();
	if (envPath) {
		const p = resolve(envPath);
		return (await isExecutable(p)) ? { path: p, searched: [p] } : { searched: [p] };
	}
	const candidates = uniqueStrings([
		...runtimeRootCandidates().flatMap((root) => [resolve(root, 'vendor/fastroute', EXE), resolve(root, 'vendor', EXE)]),
		...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, EXE)),
	]);
	for (const c of candidates) if (await isExecutable(c)) return { path: c, searched: candidates };
	return { searched: candidates };
}

async function isExecutable(p: string): Promise<boolean> {
	try {
		await access(p, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export interface ProcessResult {
	code: number;
	signal: string | null;
	stdoutTail: string;
	stderrTail: string;
	/** Log lines worth surfacing (pairs, tuning, stop reasons, errors). */
	highlights: string[];
	/** The hard timeout fired and the process was asked to stop (SIGTERM, then SIGKILL after the grace period). */
	timedOut: boolean;
	elapsedMs: number;
}

const HIGHLIGHT = /diff pair|length tuning|--max-time|stop requested|routing finished|Auto-routing stage completed|cannot be routed|net class '|saved '|\bERROR\b|panic/;
const MAX_HIGHLIGHTS = 60;
const TAIL = 4000;

/** Run fastroute; on the hard timeout ask it to stop (it then writes its best board) instead of failing. */
export function runFastrouteProcess(bin: string, args: string[], timeoutMs: number, cwd: string, graceMs = 30_000): Promise<ProcessResult> {
	return new Promise((resolveProm, rejectProm) => {
		const started = Date.now();
		const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let pending = '';
		const highlights: string[] = [];
		let timedOut = false;
		let killer: NodeJS.Timeout | undefined;

		const scan = (chunk: string) => {
			pending += chunk;
			const lines = pending.split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) {
				if (HIGHLIGHT.test(line) && !/pre-existing/.test(line)) {
					highlights.push(line.trim().slice(0, 300));
					if (highlights.length > MAX_HIGHLIGHTS) highlights.splice(0, highlights.length - MAX_HIGHLIGHTS);
				}
			}
		};
		const stopper = setTimeout(() => {
			timedOut = true;
			try { proc.kill('SIGTERM'); } catch { /* already gone */ }
			killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, graceMs);
		}, timeoutMs);

		proc.stdout.on('data', (d) => {
			const s = d.toString();
			scan(s);
			stdout += s;
			if (stdout.length > TAIL * 2) stdout = stdout.slice(-TAIL);
		});
		proc.stderr.on('data', (d) => {
			const s = d.toString();
			scan(s);
			stderr += s;
			if (stderr.length > TAIL * 2) stderr = stderr.slice(-TAIL);
		});
		proc.on('error', (err) => {
			clearTimeout(stopper);
			if (killer) clearTimeout(killer);
			rejectProm(new Error(`Failed to start fastroute (${bin}): ${err.message}`));
		});
		proc.on('close', (code, signal) => {
			clearTimeout(stopper);
			if (killer) clearTimeout(killer);
			if (pending) scan('\n');
			resolveProm({
				code: code ?? -1,
				signal: signal ?? null,
				stdoutTail: stdout.slice(-TAIL),
				stderrTail: stderr.slice(-TAIL),
				highlights,
				timedOut,
				elapsedMs: Date.now() - started,
			});
		});
	});
}

/** macOS refuses to run the unsigned release binary while it carries the download quarantine flag. */
function launchHint(bin: string, result?: ProcessResult): string | undefined {
	if (process.platform !== 'darwin') return undefined;
	if (result && result.signal !== 'SIGKILL' && result.code !== 137) return undefined;
	return `If macOS blocked the unsigned binary, clear its quarantine flag once: xattr -d com.apple.quarantine "${bin}"`;
}

/**
 * The parts of fastroute's --report JSON an agent acts on. With `baseline` (the
 * board routed with routing disabled), a violation at a spot where the board
 * already had one is counted as carried over, not new: unlocking a net turns
 * its existing artifacts (e.g. vias inside its own pads) from "between fixed
 * items" into fixable ones without anything having changed.
 */
export function summarizeFastrouteReport(report: any, baseline?: any, maxUnrouted = 25): Record<string, unknown> | undefined {
	if (!report || typeof report !== 'object') return undefined;
	const unrouted = Array.isArray(report.unrouted) ? report.unrouted : [];
	const violations = Array.isArray(report.clearance_violations) ? report.clearance_violations : [];
	const before = Array.isArray(baseline?.clearance_violations) ? baseline.clearance_violations : [];
	const existed = (v: any) => before.some((b: any) => b?.layer === v?.layer && Array.isArray(b?.xy) && Array.isArray(v?.xy)
		&& Math.abs(b.xy[0] - v.xy[0]) < 0.05 && Math.abs(b.xy[1] - v.xy[1]) < 0.05);
	const fixable = violations.filter((v: any) => !v?.unfixable && !existed(v));
	const byNet = new Map<string, number>();
	for (const u of unrouted) byNet.set(String(u?.net ?? '?'), (byNet.get(String(u?.net ?? '?')) ?? 0) + 1);
	return {
		stats: report.stats,
		timeS: report.time_s,
		unroutedByNet: Object.fromEntries(Array.from(byNet).sort((a, b) => b[1] - a[1])),
		unroutedSample: unrouted.slice(0, maxUnrouted).map((u: any) => ({
			net: u?.net,
			lengthMm: u?.length_mm,
			from: u?.from,
			to: u?.to,
			...(u?.diagnosis ? { diagnosis: u.diagnosis } : {}),
		})),
		newClearanceViolations: fixable.length,
		preExistingClearanceViolations: violations.length - fixable.length,
		...(baseline ? { violationBaseline: 'violations at spots the unrouted board already had are counted as pre-existing' } : {}),
		newViolationSample: fixable.slice(0, 10),
		note: 'Coordinates in this report are fastroute board coordinates in mm (DSN frame, y up), not EasyEDA canvas coordinates.',
	};
}

export async function collectEasyedaRuleInputs(
	bridge: WebSocketBridge,
	routingParams: Record<string, unknown>,
	warnings: string[],
): Promise<EasyedaRuleInputs> {
	const read = async (method: string, label: string) => {
		try {
			return await bridge.send(method, { ...routingParams, _timeoutMs: 20_000 });
		} catch (err: any) {
			warnings.push(`could not read ${label} (${method}): ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	};
	const [ruleConfig, netRules, pairsRaw, groupsRaw] = [
		await read('pcb.drc.getRuleConfiguration', 'design rules'),
		await read('pcb.drc.getNetRules', 'net rules'),
		await read('pcb.drc.getDiffPairs', 'differential pairs'),
		await read('pcb.drc.getEqualLengthGroups', 'equal-length groups'),
	];
	return {
		ruleConfig,
		netRules,
		diffPairs: normalizeDiffPairs(pairsRaw),
		equalLengthGroups: normalizeEqualLengthGroups(groupsRaw),
	};
}

export interface FastrouteRunOptions extends FastrouteConfigOptions {
	passes: number;
	/** Hard limit for each fastroute process (s). */
	timeoutSeconds: number;
	/** Soft limit passed as --max-time (s); default: timeoutSeconds - 30. */
	maxTimeSeconds?: number;
	threads?: number;
	multiStart?: number;
	diagnose: boolean;
	live: boolean;
	extraArgs: string[];
	/**
	 * inner: solid trace-free inner pours become plane layers, other pours are not passed;
	 * planes: every pour is passed as a conduction area; ignore: none (rules:"easyeda" only).
	 */
	pours: 'inner' | 'planes' | 'ignore';
	/**
	 * none: existing copper stays fixed, only missing connections are routed.
	 * signals: every net without a pour (and not in keepNets / locked) may be ripped up and rerouted.
	 * best: like signals, then only nets that came out better than the current routing are rerouted,
	 * verified by re-routing with every other net fixed.
	 */
	reroute: 'none' | 'signals' | 'best';
	keepNets?: string[];
	/** best: one via counts as this much trace length when comparing. */
	viaCostMm: number;
	/** best: a complete net must get this much better (%) to be replaced. */
	minGainPct: number;
	/** best: verification passes before giving up on convergence. */
	maxBestPasses: number;
	/**
	 * Nets EasyEDA's DRC reports as not fully connected. Given, every other net
	 * counts as complete on the board as it is: fastroute's own check misses
	 * joins where copper overlaps a pad without ending inside it, so its
	 * baseline would otherwise show such nets as unrouted and any reroute of
	 * them as an improvement.
	 */
	easyedaIncompleteNets?: string[];
}

export interface FastrouteRunResult {
	/** SES in the original EasyEDA DSN units, ready for the existing importers. */
	ses: string;
	sesFile: string;
	processResult: ProcessResult;
	/** Nets whose existing copper must be deleted before the SES is imported (reroute modes). */
	replaceNets: string[];
	details: Record<string, unknown>;
}

interface PassResult {
	label: string;
	dsnFile: string;
	sesFile: string;
	sesTree: SList;
	report: any;
	proc: ProcessResult;
	unroutedByNet: Map<string, number>;
	copper: Map<string, NetCopper>;
	/** Nets with a routed (not fixed) track narrower than their rule minimum. */
	thin: Map<string, { minUm: number; ruleMinUm: number; count: number }>;
}

/** Pads are shrunk by this much per side (um) so that abutting pads are routed to each other; well inside the clearance margin. */
const PAD_INSET_UM = 2;

const NO_ROUTING = ['--router.autorouter.enabled=false', '--router.fanout.enabled=false', '--router.optimizer.enabled=false'];
/** SES board units in the normalized DSN are 0.1 um. */
const SES_MM_PER_UNIT = 1 / (NORMALIZED_RESOLUTION * 1000);

/** Routed (not fixed) SES tracks narrower than their net's rule minimum; `umPerUnit` = size of one SES unit. */
function thinWires(ses: SList, minUm: Record<string, number>, umPerUnit: number): Map<string, { minUm: number; ruleMinUm: number; count: number }> {
	const out = new Map<string, { minUm: number; ruleMinUm: number; count: number }>();
	const routes = firstChild(ses, 'routes');
	const networkOut = routes ? firstChild(routes, 'network_out') : undefined;
	for (const net of networkOut ? childLists(networkOut, 'net') : []) {
		const name = atomText(net.items[1]);
		const ruleMin = name ? minUm[name] : undefined;
		if (!name || ruleMin == null) continue;
		for (const w of childLists(net, 'wire')) {
			const type = atomText(firstChild(w, 'type')?.items[1]);
			if (type === 'protect' || type === 'fix') continue;
			for (const path of childLists(w, 'path')) {
				const width = Number(atomText(path.items[2])) * umPerUnit;
				// 1 um tolerance for unit rounding
				if (!Number.isFinite(width) || width >= ruleMin - 1) continue;
				const e = out.get(name) ?? { minUm: width, ruleMinUm: ruleMin, count: 0 };
				e.minUm = Math.min(e.minUm, Math.round(width * 10) / 10);
				e.count++;
				out.set(name, e);
			}
		}
	}
	return out;
}

function unroutedByNet(report: any): Map<string, number> {
	const out = new Map<string, number>();
	for (const u of Array.isArray(report?.unrouted) ? report.unrouted : []) {
		const n = String(u?.net ?? '');
		if (n) out.set(n, (out.get(n) ?? 0) + 1);
	}
	return out;
}

function totals(copper: Map<string, NetCopper>, nets?: Iterable<string>) {
	let lengthMm = 0;
	let vias = 0;
	for (const n of nets ?? copper.keys()) {
		const c = copper.get(n);
		if (c) { lengthMm += c.lengthMm; vias += c.vias; }
	}
	return { lengthMm: Math.round(lengthMm * 10) / 10, vias };
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Nets whose copper EasyEDA has locked: they are never rerouted. */
async function lockedNets(bridge: WebSocketBridge, routingParams: Record<string, unknown>, warnings: string[]): Promise<Set<string>> {
	const out = new Set<string>();
	for (const method of ['pcb.getAll.line', 'pcb.getAll.arc', 'pcb.getAll.via']) {
		try {
			const res: any = await bridge.send(method, { ...routingParams, primitiveLock: true, limit: 1_000_000, fields: ['net', 'primitiveLock'], _timeoutMs: 20_000 });
			const list = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
			for (const it of list) if (it?.net && it.primitiveLock !== false) out.add(String(it.net));
		} catch (err: any) {
			warnings.push(`could not read locked copper (${method}): ${err instanceof Error ? err.message : String(err)}; lock state not honored for that type`);
		}
	}
	return out;
}

/**
 * Route `dsnEasyeda` (EasyEDA units, already layer-patched) with fastroute in
 * `dir`. Each pass writes <label>.um.dsn / <label>.um.ses (fastroute's view,
 * microns); the chosen result is written as `<baseName>.ses` in EasyEDA units.
 */
export async function runFastrouteOnDsn(
	bridge: WebSocketBridge,
	routingParams: Record<string, unknown>,
	bin: string,
	dsnEasyeda: string,
	dir: string,
	baseName: string,
	opts: FastrouteRunOptions,
): Promise<FastrouteRunResult> {
	const warnings: string[] = [];
	const useRules = opts.rules === 'easyeda';
	const inputs = useRules ? await collectEasyedaRuleInputs(bridge, routingParams, warnings) : undefined;

	const tree = parseSexpr(dsnEasyeda);
	const network = readDsnNetwork(tree);

	// Pours -> planes, in EasyEDA units before the micron rewrite.
	let planes: PlaneResult | undefined;
	if (useRules && opts.pours !== 'ignore') {
		planes = await collectAndAddPourPlanes(bridge, routingParams, tree, new Set(network.nets), network.layers, true, opts.pours === 'inner');
		warnings.push(...planes.warnings);
	}

	const norm = normalizeDsnToMicrons(tree, EASYEDA_DSN_UNIT_UM);
	if (norm.original.unit !== 'mil' || norm.original.value !== 1000) {
		warnings.push(`DSN declares (resolution ${norm.original.unit} ${norm.original.value}); the 10-mil-per-unit EasyEDA convention was still assumed`);
	}
	if (norm.unhandledNumericKeywords.length) {
		warnings.push(`DSN keywords with numbers that were not scaled to microns: ${norm.unhandledNumericKeywords.join(', ')}. If they are geometry, the routed result near them may be wrong.`);
	}

	// Abutting same-net pads: fastroute would count them as joined, EasyEDA does not.
	const padstacksShrunk = shrinkPinPadstacks(tree, PAD_INSET_UM);

	const config: FastrouteConfig = buildFastrouteConfig(network, inputs, opts);
	warnings.push(...config.warnings);
	if (config.classes) replaceNetClasses(tree, config.classes);

	// Options shared by every pass.
	const common: string[] = ['-mp', String(opts.passes)];
	if (opts.threads != null) common.push(`--router.autorouter.max_threads=${opts.threads}`, `--router.optimizer.max_threads=${opts.threads}`);
	if (opts.multiStart != null) common.push(`--multi-start=${opts.multiStart}`);
	let pairsFile: string | undefined;
	let tuneFile: string | undefined;
	if (config.pairs.length) {
		pairsFile = join(dir, 'pairs.txt');
		await writeFile(pairsFile, pairsFileText(config.pairs));
		common.push(`--pairs=${pairsFile}`);
	}
	if (config.tuneGroups.length) {
		tuneFile = join(dir, 'tune.txt');
		await writeFile(tuneFile, tuneFileText(config.tuneGroups));
		common.push(`--tune=${tuneFile}`);
	}
	if (config.layerHeightsMm) common.push(`--layer-heights=${config.layerHeightsMm.join(',')}`);
	if (config.noNeckdownClasses.length) common.push(`--no-neckdown-classes=${config.noNeckdownClasses.join(',')}`);
	if (config.minTraceWidthUm != null) {
		// fastroute's automatic neck-down narrows a track at a pin to whatever
		// fits, ignoring min_trace_width_um in places (0.07 mm and 10 um tracks
		// seen). Off instead, and connections that fail at full width are
		// retried at the rule minimum.
		common.push(`--router.min_trace_width_um=${config.minTraceWidthUm}`, '--router.automatic_neckdown=false', `--router.neck_width_um=${config.minTraceWidthUm}`);
	}
	if (config.edgeClearanceUm != null) common.push(`--router.copper_to_edge_clearance_um=${config.edgeClearanceUm}`);
	common.push(...opts.extraArgs);
	const maxTime = Math.max(1, opts.maxTimeSeconds ?? Math.max(30, opts.timeoutSeconds - 30));

	const original = dsnNetCopper(tree, 1 / 1000);
	const passes: PassResult[] = [];
	const runPass = async (label: string, decide: ((net: string | undefined) => WiringDecision) | null, extra: string[], routing: boolean): Promise<PassResult> => {
		const t = cloneTree(tree);
		if (decide) setDsnWiring(t, decide);
		const dsnFile = join(dir, `${label}.um.dsn`);
		const sesFile = join(dir, `${label}.um.ses`);
		const reportFile = join(dir, `${label}.report.json`);
		await writeFile(dsnFile, writeSexpr(t) + '\n');
		const args = ['-de', dsnFile, '-do', sesFile, `--report=${reportFile}`, ...common, ...extra];
		if (routing) {
			args.push(`--max-time=${maxTime}`);
			if (opts.diagnose) args.push('--diagnose');
			if (opts.live) args.push('--live');
		}
		let proc: ProcessResult;
		try {
			proc = await runFastrouteProcess(bin, args, opts.timeoutSeconds * 1000, dir);
		} catch (err: any) {
			const hint = launchHint(bin);
			throw new Error(`${err instanceof Error ? err.message : String(err)}${hint ? `\n${hint}` : ''}`);
		}
		let sesRaw: string;
		try {
			sesRaw = await readFile(sesFile, 'utf8');
		} catch {
			const hint = launchHint(bin, proc);
			throw new Error(
				`fastroute (${label}) wrote no SES (exit ${proc.code}${proc.signal ? `, signal ${proc.signal}` : ''}${proc.timedOut ? ', stopped by timeout' : ''}).\n` +
				`log tail:\n${(proc.stderrTail || proc.stdoutTail || '(empty)').slice(-2000)}\n` +
				`Normalized DSN kept at: ${dsnFile}${hint ? `\n${hint}` : ''}`,
			);
		}
		if (proc.code !== 0 && !proc.timedOut) warnings.push(`fastroute (${label}) exited with code ${proc.code}${proc.signal ? ` (signal ${proc.signal})` : ''}; using the best SES it checkpointed`);
		let report: any;
		try { report = JSON.parse(await readFile(reportFile, 'utf8')); } catch { /* a killed run has no report */ }
		const sesTree = parseSexpr(sesRaw);
		const pass: PassResult = { label, dsnFile, sesFile, sesTree, report, proc, unroutedByNet: unroutedByNet(report), copper: sesNetCopper(sesTree, SES_MM_PER_UNIT), thin: thinWires(sesTree, config.netMinWidthUm, SES_MM_PER_UNIT * 1000) };
		passes.push(pass);
		return pass;
	};

	// Which nets may be rerouted.
	const pourNets = new Set(planes?.pourNets ?? []);
	const keep = new Set(opts.keepNets ?? []);
	let locked = new Set<string>();
	if (opts.reroute !== 'none') locked = await lockedNets(bridge, routingParams, warnings);
	const reroutable = new Set(Array.from(original.keys()).filter((n) => !pourNets.has(n) && !keep.has(n) && !locked.has(n)));

	const baseline = opts.reroute !== 'none' ? await runPass('baseline', null, NO_ROUTING, false) : undefined;
	const easyedaIncomplete = opts.easyedaIncompleteNets ? new Set(opts.easyedaIncompleteNets) : undefined;
	const unroutedBefore = (net: string): number => {
		const fr = baseline?.unroutedByNet.get(net) ?? 0;
		if (!easyedaIncomplete) return fr;
		return easyedaIncomplete.has(net) ? Math.max(1, fr) : 0;
	};
	const better = (net: string, cand: PassResult): boolean => {
		if (cand.thin.has(net)) return false;
		const ou = unroutedBefore(net);
		const cu = cand.unroutedByNet.get(net) ?? 0;
		if (cu !== ou) return cu < ou;
		const o = original.get(net);
		const c = cand.copper.get(net);
		if (!o || !c) return false;
		const so = o.lengthMm + opts.viaCostMm * o.vias;
		const sc = c.lengthMm + opts.viaCostMm * c.vias;
		return sc < so * (1 - opts.minGainPct / 100);
	};

	let final: PassResult;
	let replace = new Set<string>();
	let bestNotes: string[] = [];
	if (opts.reroute === 'none') {
		final = await runPass('route', null, [], true);
	} else if (opts.reroute === 'signals') {
		final = await runPass('reroute', (net) => (net && reroutable.has(net) ? 'unlock' : 'keep'), [], true);
		replace = new Set(reroutable);
	} else {
		const first = await runPass('best-1', (net) => (net && reroutable.has(net) ? 'unlock' : 'keep'), [], true);
		let chosen = new Set(Array.from(reroutable).filter((n) => better(n, first)));
		bestNotes.push(`pass best-1: ${chosen.size} of ${reroutable.size} reroutable nets came out better`);
		let settled: PassResult | undefined;
		for (let i = 2; i <= opts.maxBestPasses + 1 && chosen.size; i++) {
			const current = chosen;
			const pass = await runPass(`best-${i}`, (net) => (net && current.has(net) ? 'unlock' : 'keep'), [], true);
			const worse = Array.from(current).filter((n) => !better(n, pass));
			if (!worse.length) { settled = pass; break; }
			bestNotes.push(`pass best-${i}: ${worse.length} net(s) no longer better with the others fixed (${worse.slice(0, 8).join(', ')}${worse.length > 8 ? ', ...' : ''}); kept as they are`);
			chosen = new Set(Array.from(current).filter((n) => !worse.includes(n)));
			if (i === opts.maxBestPasses + 1 && chosen.size) {
				warnings.push(`best: no stable selection after ${opts.maxBestPasses} verification passes; the last pass is used and ${worse.length} of its rerouted nets are not better`);
				settled = pass;
				chosen = current;
			}
		}
		if (settled) {
			final = settled;
			replace = chosen;
		} else {
			bestNotes.push('no net improved; only missing connections are routed');
			final = await runPass('route', null, [], true);
		}
	}

	// Per-net comparison against the board as it is.
	let comparison: Record<string, unknown> | undefined;
	if (baseline) {
		const rows = Array.from(reroutable).map((net) => {
			const o = original.get(net) ?? { lengthMm: 0, vias: 0, wires: 0 };
			const c = final.copper.get(net) ?? { lengthMm: 0, vias: 0, wires: 0 };
			return {
				net,
				before: { lengthMm: r1(o.lengthMm), vias: o.vias, unrouted: unroutedBefore(net) },
				after: { lengthMm: r1(c.lengthMm), vias: c.vias, unrouted: final.unroutedByNet.get(net) ?? 0 },
				decision: replace.has(net) ? 'rerouted' : 'kept',
				gainMm: r1(o.lengthMm + opts.viaCostMm * o.vias - (c.lengthMm + opts.viaCostMm * c.vias)),
			};
		});
		const rerouted = rows.filter((r) => r.decision === 'rerouted').sort((a, b) => b.gainMm - a.gainMm);
		comparison = {
			note: `before = the board as it is; after = the chosen result. Score = length + ${opts.viaCostMm} mm per via. Pour nets${keep.size ? ', keepNets' : ''} and nets with locked copper are never rerouted.`,
			board: {
				before: {
					unrouted: baseline.report?.stats?.unrouted,
					...(easyedaIncomplete ? { incompleteNetsPerEasyedaDrc: easyedaIncomplete.size, note: 'unrouted is fastroute\'s count, which misses joins where copper overlaps a pad; reroute decisions use EasyEDA\'s DRC instead' } : {}),
					...totals(original),
				},
				after: { unrouted: final.report?.stats?.unrouted, ...totals(final.copper) },
			},
			reroutedNets: {
				count: rerouted.length,
				before: totals(original, rerouted.map((r) => r.net)),
				after: totals(final.copper, rerouted.map((r) => r.net)),
				rows: rerouted.slice(0, 40),
			},
			keptNets: rows.length - rerouted.length,
			neverRerouted: { pourNets: Array.from(pourNets), keepNets: Array.from(keep), lockedNets: Array.from(locked) },
			...(bestNotes.length ? { bestPasses: bestNotes } : {}),
		};
	}

	const denorm = denormalizeSes(final.sesTree, norm.umPerUnit, norm.original);
	if (denorm.unhandledNumericKeywords.length) warnings.push(`SES keywords with numbers that were not scaled back: ${denorm.unhandledNumericKeywords.join(', ')}`);
	const ses = writeSexpr(final.sesTree) + '\n';
	const sesFile = join(dir, `${baseName}.ses`);
	await writeFile(sesFile, ses);

	const details: Record<string, unknown> = {
		router: 'fastroute',
		fastrouteBinary: bin,
		reroute: opts.reroute,
		exitCode: final.proc.code,
		stoppedBy: final.proc.timedOut ? 'timeout (SIGTERM; best checkpoint used)' : final.proc.highlights.some((l) => l.includes('--max-time')) ? 'maxTimeSeconds' : 'completed',
		elapsedSeconds: r1(passes.reduce((s, p) => s + p.proc.elapsedMs, 0) / 1000),
		routerPasses: passes.map((p) => ({ label: p.label, seconds: r1(p.proc.elapsedMs / 1000), unrouted: p.report?.stats?.unrouted, vias: p.report?.stats?.vias, newClearanceViolations: summarizeFastrouteReport(p.report, baseline?.report)?.newClearanceViolations })),
		...(replace.size ? { replaceNets: Array.from(replace) } : {}),
		...(final.thin.size ? { tracksBelowRuleMinimum: Object.fromEntries(final.thin), tracksBelowRuleMinimumNote: 'routed tracks narrower than the net\'s Track rule minimum; EasyEDA\'s DRC will flag them' } : {}),
		...(comparison ? { comparison } : {}),
		units: {
			note: `fastroute sees the board in real microns (EasyEDA DSN units are 10 mil); the returned sesFile is scaled back to EasyEDA units. Pin pads are ${PAD_INSET_UM} um smaller per side (${padstacksShrunk} padstacks), so pads that only touch get a track between them.`,
			dsnUnitUm: norm.umPerUnit,
			originalResolution: norm.original,
		},
		pours: planes
			? { planes: planes.planes, powerLayers: planes.powerLayers, calibration: planes.calibration }
			: opts.pours !== 'ignore' ? 'not passed (rules:"dsn")' : 'ignored',
		rules: {
			mode: opts.rules,
			netClasses: config.classes ? config.classSummary : 'exported DSN classes kept',
			diffPairs: config.pairs,
			lengthGroups: config.tuneGroups,
			noNeckdownClasses: config.noNeckdownClasses,
			minTraceWidthUm: config.minTraceWidthUm,
			minTraceWidthSource: config.minTraceWidthSource,
			edgeClearanceUm: config.edgeClearanceUm,
			edgeClearanceSource: config.edgeClearanceSource,
			layerHeightsMmDsnOrder: config.layerHeightsMm,
			dsnLayerOrder: network.layers,
			layerHeightsSource: config.layerHeightsSource,
		},
		files: { normalizedDsn: final.dsnFile, fastrouteSes: final.sesFile, pairsFile, tuneFile },
		report: summarizeFastrouteReport(final.report, baseline?.report),
		logHighlights: final.proc.highlights,
		warnings,
	};
	return { ses, sesFile, processResult: final.proc, replaceNets: Array.from(replace), details };
}
