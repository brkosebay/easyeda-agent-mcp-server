// Functional review tools — the intent check. Where emc_run_check verifies
// electrical continuity, functional_run_check verifies functional INTENT:
// required pins reach the right thing. It is what catches a USB connector
// whose D+/D- data lines are floating or tied to GND (shield/standoff/mounting
// pads netlisted to GND make connectivity LOOK fine — this engine excludes
// those from credit). Missing connection / required pins / USB data lines
// floating — all surface here.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';
import { analyzeFunctional, listFunctionalRules, type FunctionalSnapshot, type FunctionalFinding } from '../analyzers/functional';

async function fetchSnapshot(bridge: WebSocketBridge, params: any): Promise<FunctionalSnapshot> {
	const result = await bridge.send('sch.extract.design', { ...params, _timeoutMs: 120_000 });
	return result as FunctionalSnapshot;
}

export function registerFunctionalTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'functional_run_check',
		'Run the FUNCTIONAL REVIEW rule engine over the current schematic — an intent check, not just continuity. Verifies that REQUIRED pins reach the RIGHT functional part: USB D+/D- must reach a controller/hub/ESD (and are flagged CRITICAL if floating or tied to GND/power — the classic "USB data lines floating but review passes because the shield/mounting pads are on GND" bug), Type-C CC pins reach Rd/Rp, crystal terminals have load caps to GND, I2C/reset nets have pull-ups, and IC power rails have decoupling. Mounting holes, test points, shields and standoffs are EXCLUDED from connectivity credit, so a missing connection masked by mechanical pads is caught. Pass a snapshot from sch_extract_design as snapshot, or omit to fetch fresh.',
		withDocumentParam({
			snapshot: z.any().optional().describe('Pre-fetched snapshot from sch_extract_design'),
			enabledRules: z.array(z.string()).optional().describe('Run only these rule IDs (e.g. ["CON-USB-002","XTAL-001"])'),
			disabledRules: z.array(z.string()).optional().describe('Skip these rule IDs even if otherwise enabled'),
			minSeverity: z.enum(['critical', 'warning', 'info']).optional().describe('Filter findings; critical|warning|info (default returns all)'),
		}),
		async ({ snapshot, enabledRules, disabledRules, minSeverity, ...rest }) => {
			const snap = snapshot ?? (await fetchSnapshot(bridge, rest));
			const findings = analyzeFunctional(snap as FunctionalSnapshot, { enabledRules, disabledRules, minSeverity });

			const order = { critical: 3, warning: 2, info: 1 } as const;
			const grouped: Record<'critical' | 'warning' | 'info', FunctionalFinding[]> = { critical: [], warning: [], info: [] };
			for (const f of findings) grouped[f.severity].push(f);
			const bySeverity = { critical: grouped.critical.length, warning: grouped.warning.length, info: grouped.info.length };
			const byConfidence = { high: 0, medium: 0, low: 0 } as Record<'high' | 'medium' | 'low', number>;
			for (const f of findings) byConfidence[f.confidence] += 1;

			const sorted = [...findings].sort((a, b) => order[b.severity] - order[a.severity]);
			const summary = `${findings.length} functional findings: ${bySeverity.critical} critical, ${bySeverity.warning} warning, ${bySeverity.info} info (${byConfidence.high} high / ${byConfidence.medium} medium / ${byConfidence.low} low confidence).`;

			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						summary,
						bySeverity,
						byConfidence,
						findingsCount: findings.length,
						findingsBySeverity: grouped,
						findings: sorted,
					}),
				}],
			};
		},
	);

	server.tool(
		'functional_list_rules',
		'List every FUNCTIONAL REVIEW rule available, with ruleId, target deviceClass, severity, and description. Covers required-pin / intent checks: USB data-line connectivity (CON-USB-002), Type-C CC, VBUS, generic connector liveness, crystal load caps, I2C/reset pull-ups, IC decoupling. Use this to discover rule IDs before passing to functional_run_check.',
		{},
		async () => {
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						rules: listFunctionalRules(),
						note: 'Functional review verifies INTENT (required pins reach the right part), not just electrical continuity. Mounting/shield/test-point peers are excluded from connectivity credit.',
					}),
				}],
			};
		},
	);
}
