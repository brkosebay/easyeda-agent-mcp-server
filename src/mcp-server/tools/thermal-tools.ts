// Thermal analysis tools — schematic-side estimates.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';
import { analyzeThermal, inferRailVoltage, type ThermalSnapshot } from '../analyzers/thermal';

async function fetchSnapshot(bridge: WebSocketBridge, params: any): Promise<ThermalSnapshot> {
	const result = await bridge.send('sch.extract.design', { ...params, _timeoutMs: 120_000 });
	return result as ThermalSnapshot;
}

export function registerThermalTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'thermal_analyze',
		'Estimate per-component power dissipation from the schematic snapshot. Covers resistors (V²/R when bridging rail to GND), LDOs ((Vin−Vout)·Iout with downstream IC count heuristic), switching regulators (loss = Vout·Iout·(1/η−1) with η=0.85 default), and LEDs (Vf·If with series-resistor sensing). ICs are flagged as needsDatasheet — pair with datasheet_fetch for an authoritative value. Returns hottest 5, totals, and severity breakdown.',
		withDocumentParam({
			snapshot: z.any().optional().describe('Pre-fetched snapshot from sch_extract_design'),
			switcherEfficiency: z.number().min(0.5).max(0.99).optional().default(0.85).describe('Default efficiency for switching regulators when datasheet not consulted'),
			includeOk: z.boolean().optional().default(false).describe('Include components estimated < 50mW (mostly noise)'),
		}),
		async ({ snapshot, switcherEfficiency, includeOk, ...rest }) => {
			const snap = snapshot ?? (await fetchSnapshot(bridge, rest));
			const report = analyzeThermal(snap as ThermalSnapshot, { switcherEfficiency, includeOk });
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						summary: report.summary,
						totalEstimatedWatts: report.totalEstimatedWatts,
						coverage: report.coverage,
						bySeverity: report.bySeverity,
						hottest: report.hottest,
						componentsNeedingDatasheet: report.componentsNeedingDatasheet,
						estimates: report.estimates,
					}),
				}],
			};
		},
	);

	server.tool(
		'thermal_infer_rail_voltage',
		'Helper: parse a power-rail net name and return the inferred nominal voltage, or null if it doesn\'t match known patterns. Useful for sanity-checking what the analyzer assumes.',
		{ netName: z.string() },
		async ({ netName }) => {
			const v = inferRailVoltage(netName);
			return { content: [{ type: 'text', text: JSON.stringify({ netName, inferredVolts: v }) }] };
		},
	);
}
