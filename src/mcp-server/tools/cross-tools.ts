// Cross-analysis tools — schematic ↔ PCB consistency.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withInstanceParam } from './query-params';
import { crossVerify, reconcileBom, type SchSnap, type PcbSnap } from '../analyzers/cross';

export function registerCrossTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'cross_verify_design',
		'Reconcile schematic and PCB: matches designators, flags MPN/footprint divergence between sch and pcb, finds nets in one side missing from the other. Pass schDocument and pcbDocument UUIDs (or pre-fetched snapshots).',
		withInstanceParam({
			schDocument: z.string().describe('Schematic document UUID'),
			pcbDocument: z.string().describe('PCB document UUID'),
			schSnapshot: z.any().optional(),
			pcbSnapshot: z.any().optional(),
		}),
		async ({ schDocument, pcbDocument, schSnapshot, pcbSnapshot, ...rest }) => {
			const sch = (schSnapshot ?? (await bridge.send('sch.extract.design', { ...rest, document: schDocument, allPages: true, _timeoutMs: 120_000 }))) as SchSnap;
			const pcb = (pcbSnapshot ?? (await bridge.send('pcb.extract.design', { ...rest, document: pcbDocument, includeAllPads: true, _timeoutMs: 180_000 }))) as PcbSnap;
			const report = crossVerify(sch, pcb);
			return { content: [{ type: 'text', text: JSON.stringify(report) }] };
		},
	);

	server.tool(
		'cross_reconcile_bom',
		'Compare BOM derived from schematic vs the PCB manufacture BOM (CSV rows). Use when the manufacturing house BOM divergence from the schematic BOM is suspected.',
		withInstanceParam({
			schDocument: z.string(),
			schSnapshot: z.any().optional(),
			pcbBomRows: z.array(z.object({
				designators: z.string().optional(),
				mpn: z.string().optional(),
				qty: z.number().optional(),
			})).describe('Parsed rows from a PCB manufacture BOM CSV — pass `designators` (comma-sep) and `mpn`.'),
		}),
		async ({ schDocument, schSnapshot, pcbBomRows, ...rest }) => {
			const sch = (schSnapshot ?? (await bridge.send('sch.extract.design', { ...rest, document: schDocument, allPages: true, _timeoutMs: 120_000 }))) as SchSnap;
			return { content: [{ type: 'text', text: JSON.stringify(reconcileBom(sch, pcbBomRows)) }] };
		},
	);
}
