// PCB-side EMC + DFM tools.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam, withInstanceParam } from './query-params';
import { analyzePcbEmc, type PcbSnapMinimal } from '../analyzers/pcb-emc';
import { analyzeDfm, getTier } from '../analyzers/dfm';
import type { DesignSnapshotMinimal } from '../analyzers/bom';

export function registerPcbEmcTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_emc_run_check',
		'PCB-side EMC checks: decoupling cap proximity to IC power pins (PCB-DEC-001), ground plane pour coverage (PCB-GND-001), 2-layer-with-switcher warning (PCB-LYR-001). Pass a snapshot from pcb_extract_design to skip re-fetch.',
		withDocumentParam({
			snapshot: z.any().optional().describe('Pre-fetched pcb_extract_design snapshot'),
			decouplingMaxMil: z.number().optional().default(200).describe('Max distance from IC power pin to nearest decoupling cap (mil). 200mil ≈ 5mm.'),
		}),
		async ({ snapshot, decouplingMaxMil, ...rest }) => {
			const snap = snapshot ?? (await bridge.send('pcb.extract.design', { ...rest, includeAllPads: true, _timeoutMs: 180_000 }));
			const report = analyzePcbEmc(snap as PcbSnapMinimal, { decouplingMaxMil });
			return { content: [{ type: 'text', text: JSON.stringify(report) }] };
		},
	);

	server.tool(
		'dfm_check',
		'Run DFM checks for a manufacturing tier (JLCPCB or PCBWay). Verifies parts (LCSC basic-vs-extended), layer count, and surfaces tier-specific minimum trace/drill envelope. Schematic snapshot required for parts checks; PCB snapshot optional.',
		withInstanceParam({
			tier: z.enum(['jlcpcb', 'pcbway']).default('jlcpcb'),
			schDocument: z.string().describe('Schematic document UUID'),
			pcbDocument: z.string().optional().describe('PCB document UUID — optional but enables layer/geometry checks'),
			schSnapshot: z.any().optional(),
			pcbSnapshot: z.any().optional(),
		}),
		async ({ tier, schDocument, pcbDocument, schSnapshot, pcbSnapshot, ...rest }) => {
			const sch = (schSnapshot ?? (await bridge.send('sch.extract.design', { ...rest, document: schDocument, allPages: true, _timeoutMs: 120_000 }))) as DesignSnapshotMinimal;
			let pcb: any = pcbSnapshot;
			if (!pcb && pcbDocument) {
				try { pcb = await bridge.send('pcb.extract.design', { ...rest, document: pcbDocument, includeAllPads: false, _timeoutMs: 180_000 }); }
				catch { /* PCB extract may fail if extension is older */ pcb = null; }
			}
			const report = await analyzeDfm(sch, pcb ?? null, getTier(tier));
			return { content: [{ type: 'text', text: JSON.stringify(report) }] };
		},
	);
}
