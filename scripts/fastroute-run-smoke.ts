// Live fastroute run without EasyEDA: routes an exported EasyEDA DSN through
// the same code path pcb_autoroute uses (normalize -> rules -> fastroute ->
// denormalize), with the board rules served from a JSON file instead of the
// bridge. Needs the fastroute binary (scripts/install-fastroute.sh or FASTROUTE_BIN).
//   npx ts-node --transpile-only scripts/fastroute-run-smoke.ts board.dsn rules.json [maxTimeSeconds] [timeoutSeconds] [--fastroute-option ...]
// A timeoutSeconds below the routing time exercises the stop-and-keep-best path.
// rules.json: { ruleConfig, netRules, diffPairs, equalLengthGroups } as returned by
// pcb_get_design_rules (raw), pcb_get_net_rules, pcb_manage_diff_pairs / pcb_manage_equal_length_groups get_all.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFastrouteBinary, runFastrouteOnDsn } from '../src/mcp-server/autoroute/fastroute';
import { parseSexpr, readResolution } from '../src/mcp-server/autoroute/specctra';

async function main() {
	const [dsnPath, rulesPath, maxTime, hardTimeout, ...extraArgs] = process.argv.slice(2);
	if (!dsnPath || !rulesPath) throw new Error('usage: fastroute-run-smoke.ts board.dsn rules.json [maxTimeSeconds] [timeoutSeconds]');
	const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
	const answers: Record<string, unknown> = {
		'pcb.drc.getRuleConfiguration': rules.ruleConfig,
		'pcb.drc.getNetRules': rules.netRules,
		'pcb.drc.getDiffPairs': rules.diffPairs,
		'pcb.drc.getEqualLengthGroups': rules.equalLengthGroups,
	};
	const bridge = { send: async (method: string) => answers[method] } as any;
	const { path: bin, searched } = await resolveFastrouteBinary();
	assert.ok(bin, `fastroute not found; searched ${searched.slice(0, 4).join(', ')}`);

	const dir = mkdtempSync(join(tmpdir(), 'fastroute-smoke-'));
	const run = await runFastrouteOnDsn(bridge, {}, bin!, readFileSync(dsnPath, 'utf8'), dir, 'board', {
		rules: 'easyeda',
		lengthToleranceMm: 0.5,
		boardThicknessMm: 1.6,
		clearanceMarginUm: 5,
		passes: 100,
		timeoutSeconds: Number(hardTimeout ?? Number(maxTime ?? 120) + 60),
		maxTimeSeconds: Number(maxTime ?? 120),
		diagnose: false,
		live: false,
		extraArgs,
	});
	assert.deepEqual(readResolution(parseSexpr(run.ses)), { unit: 'mil', value: 1000 }, 'SES is back in EasyEDA units');
	const { report, rules: applied, warnings, logHighlights, stoppedBy, elapsedSeconds } = run.details as any;
	console.log(JSON.stringify({ dir, sesFile: run.sesFile, stoppedBy, elapsedSeconds, exitCode: run.processResult.code, signal: run.processResult.signal, stats: report?.stats, unroutedByNet: report?.unroutedByNet, newClearanceViolations: report?.newClearanceViolations, applied, warnings, logHighlights }, null, 1));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
