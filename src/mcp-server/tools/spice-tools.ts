// SPICE testbench tools — generates SPICE netlists for detected subcircuits
// (voltage dividers, RC filters, LED drive). Output is text-mode SPICE the
// user can paste into EasyEDA's built-in simulator OR run with ngspice.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { promises as fs } from 'fs';
import { dirname } from 'path';
import { mkdir } from 'fs/promises';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';
import { generateSpiceTestbenches } from '../analyzers/spice-testbench';
import type { DesignSnapshotMinimal } from '../analyzers/bom';

export function registerSpiceTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'spice_generate_testbenches',
		'Auto-generate SPICE testbenches for detected subcircuits (voltage dividers, RC filters, LED drives). Returns text-mode SPICE netlists with stimulus + expected metrics. Paste into EasyEDA\'s built-in simulator or run with ngspice.',
		withDocumentParam({
			snapshot: z.any().optional().describe('Pre-fetched sch_extract_design snapshot'),
			subcircuits: z.array(z.enum(['voltage_divider','rc_filter','led_drive','ldo_regulator','buck_regulator','current_limit_resistor'])).optional(),
			outputDir: z.string().optional().describe('If set, write each testbench as a .cir file in this directory'),
		}),
		async ({ snapshot, subcircuits, outputDir, ...rest }) => {
			const snap = (snapshot ?? (await bridge.send('sch.extract.design', { ...rest, allPages: true, _timeoutMs: 120_000 }))) as DesignSnapshotMinimal;
			const report = generateSpiceTestbenches(snap);
			const filtered = subcircuits ? report.testbenches.filter((t) => subcircuits.includes(t.subcircuit as any)) : report.testbenches;

			const writtenPaths: string[] = [];
			if (outputDir) {
				await mkdir(outputDir, { recursive: true });
				for (const t of filtered) {
					const p = `${outputDir.replace(/\/$/, '')}/${t.name}.cir`;
					await fs.writeFile(p, `* ${t.description}\n${t.netlist}\n`);
					writtenPaths.push(p);
				}
			}

			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						summary: report.summary,
						stats: report.stats,
						count: filtered.length,
						writtenPaths,
						testbenches: filtered.map((t) => ({
							name: t.name,
							subcircuit: t.subcircuit,
							description: t.description,
							involvedDesignators: t.involvedDesignators,
							expected: t.expected,
							netlist: t.netlist,
						})),
					}),
				}],
			};
		},
	);
}
