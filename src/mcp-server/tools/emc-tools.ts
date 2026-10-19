// EMC pre-compliance tools — schematic-side rules for now. PCB-side rules
// (ground plane continuity, PDN impedance, board-edge radiation, diff-pair
// routing) ship after pcb_extract_design exists.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';
import { analyzeEmc, listEmcRules, type EmcSnapshot } from '../analyzers/emc';

async function fetchSnapshot(bridge: WebSocketBridge, params: any): Promise<EmcSnapshot> {
	const result = await bridge.send('sch.extract.design', { ...params, _timeoutMs: 120_000 });
	return result as EmcSnapshot;
}

export function registerEmcTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'emc_run_check',
		'Run EMC pre-compliance rules over the current schematic. Phase 5 ships ~7 schematic-side rules across decoupling, IO protection, crystal loading, switching regulators, common-mode chokes, and reverse-polarity protection. PCB-side rules (ground planes, PDN impedance) come in a later phase. Pass a snapshot from sch_extract_design as snapshot, or omit to fetch fresh.',
		withDocumentParam({
			snapshot: z.any().optional().describe('Pre-fetched snapshot from sch_extract_design'),
			enabledRuleIds: z.array(z.string()).optional().describe('Run only these rule IDs (e.g. ["DEC-001","CLK-001"])'),
			disabledRuleIds: z.array(z.string()).optional().describe('Skip these rule IDs even if otherwise enabled'),
			minSeverity: z.enum(['critical', 'warning', 'info']).optional().describe('Filter findings; critical|warning|info (default returns all)'),
		}),
		async ({ snapshot, enabledRuleIds, disabledRuleIds, minSeverity, ...rest }) => {
			const snap = snapshot ?? (await fetchSnapshot(bridge, rest));
			const report = analyzeEmc(snap as EmcSnapshot, { enabledRuleIds, disabledRuleIds });

			let findings = report.findings;
			if (minSeverity) {
				const order = { critical: 3, warning: 2, info: 1 } as const;
				const threshold = order[minSeverity];
				findings = findings.filter((f) => order[f.severity] >= threshold);
			}

			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						rulesRun: report.rulesRun,
						rulesSkipped: report.rulesSkipped,
						summary: report.summary,
						bySeverity: report.bySeverity,
						byCategory: report.byCategory,
						worstCategories: report.scoredCategories.slice(0, 5),
						findingsCount: findings.length,
						findings,
					}),
				}],
			};
		},
	);

	server.tool(
		'emc_list_rules',
		'List every EMC rule available, with id, category, default severity, and title. Use this to discover rule IDs before passing to emc_run_check.',
		{},
		async () => {
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						rules: listEmcRules(),
						note: 'Phase 5 ships schematic-side rules only. PCB-side EMC checks come after pcb_extract_design exists.',
					}),
				}],
			};
		},
	);

	server.tool(
		'emc_run_category',
		'Convenience: run all rules in one EMC category and return findings sorted by severity.',
		withDocumentParam({
			category: z.enum([
				'decoupling', 'power_filtering', 'clock_routing', 'io_protection',
				'differential_pairs', 'ground_strategy', 'reset_supervision',
				'crystal_loading', 'connector_hygiene', 'switching_regulator',
				'protection_devices', 'analog_isolation',
			]),
			snapshot: z.any().optional(),
		}),
		async ({ category, snapshot, ...rest }) => {
			const snap = snapshot ?? (await fetchSnapshot(bridge, rest));
			const allRules = listEmcRules();
			const enabledRuleIds = allRules.filter((r) => r.category === category).map((r) => r.id);
			if (enabledRuleIds.length === 0) {
				return { content: [{ type: 'text', text: JSON.stringify({ category, message: 'No rules in this category yet — coming in a later phase.', findings: [] }) }] };
			}
			const report = analyzeEmc(snap as EmcSnapshot, { enabledRuleIds });
			const order = { critical: 3, warning: 2, info: 1 } as const;
			const findings = [...report.findings].sort((a, b) => order[b.severity] - order[a.severity]);
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						category,
						rulesRun: report.rulesRun,
						summary: report.summary,
						findings,
					}),
				}],
			};
		},
	);
}
