// BOM tools — extract BOM from sch_extract_design snapshot, audit gaps,
// classify distributors, and export tracking CSV.
//
// All analyzers are pure (src/mcp-server/analyzers/bom.ts). The tool layer
// just bridges in the snapshot and serializes results.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';
import {
	buildBom,
	bomToCsv,
	classifyDistributor,
	normalizeMpn,
	type DesignSnapshotMinimal,
} from '../analyzers/bom';

async function fetchSnapshot(bridge: WebSocketBridge, params: any): Promise<DesignSnapshotMinimal> {
	const result = await bridge.send('sch.extract.design', { ...params, _timeoutMs: 120_000 });
	return result as DesignSnapshotMinimal;
}

export function registerBomTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'bom_extract',
		'Build a normalized BOM from the active project. Groups only complete matching part identities and metadata; preserves unknown parts separately, collapses designators, computes qty, classifies distributor by supplier ID pattern, distinguishes DNP, unknown population and BOM exclusion, and identifies gaps (missing MPN/manufacturer/value/footprint/distributor). Pass a snapshot from sch_extract_design as the snapshot field, or omit to fetch fresh.',
		withDocumentParam({
			snapshot: z.any().optional().describe('Pre-fetched snapshot from sch_extract_design'),
			allPages: z.boolean().optional().default(true).describe('Include components from every schematic page'),
		}),
		async ({ snapshot, ...rest }) => {
			const snap = snapshot ?? (await fetchSnapshot(bridge, rest));
			const report = buildBom(snap as DesignSnapshotMinimal);
			return { content: [{ type: 'text', text: JSON.stringify(report) }] };
		},
	);

	server.tool(
		'bom_audit_gaps',
		'Return only the BOM rows that have at least one gap (missing MPN/manufacturer/value/footprint/distributor), sorted by severity. Use this to prioritize cleanup before ordering.',
		withDocumentParam({
			snapshot: z.any().optional(),
		}),
		async ({ snapshot, ...rest }) => {
			const snap = snapshot ?? (await fetchSnapshot(bridge, rest));
			const report = buildBom(snap as DesignSnapshotMinimal);
			const rows = report.rows.filter((r) => r.gaps.length > 0);
			rows.sort((a, b) => b.gaps.length - a.gaps.length || b.qty - a.qty);
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						totalRowsWithGaps: rows.length,
						gapsSummary: report.gapsSummary,
						rows: rows.map((r) => ({
							designators: r.designators,
							qty: r.qty,
							mpn: r.mpn,
							deviceClass: r.deviceClass,
							gaps: r.gaps,
						})),
					}),
				}],
			};
		},
	);

	server.tool(
		'bom_classify_distributors',
		'Audit which distributor each component is sourced from based on supplier ID pattern. Returns counts per distributor and the rows whose distributor is "unknown" (need manual classification).',
		withDocumentParam({
			snapshot: z.any().optional(),
		}),
		async ({ snapshot, ...rest }) => {
			const snap = snapshot ?? (await fetchSnapshot(bridge, rest));
			const report = buildBom(snap as DesignSnapshotMinimal);
			const unknown = report.rows
				.filter((r) => r.distributor === 'unknown')
				.map((r) => ({ designators: r.designators, mpn: r.mpn, supplierId: r.distributorId }));
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						breakdown: report.distributorBreakdown,
						unknown,
					}),
				}],
			};
		},
	);

	server.tool(
		'bom_normalize_mpn',
		'Normalize MPN whitespace and letter case, preserving manufacturer-specific packaging suffixes.',
		{
			mpn: z.string().describe('Manufacturer Part Number to normalize'),
		},
		async ({ mpn }) => {
			return { content: [{ type: 'text', text: JSON.stringify({ input: mpn, normalized: normalizeMpn(mpn) }) }] };
		},
	);

	server.tool(
		'bom_classify_supplier_id',
		'Classify a single supplier ID against known distributor patterns (LCSC C-codes, DigiKey *-ND, Mouser 3-digit prefix, Farnell numeric, etc.).',
		{
			supplier: z.string().optional().describe('Supplier name (e.g. "LCSC")'),
			supplierId: z.string().describe('Supplier-specific part number'),
		},
		async ({ supplier, supplierId }) => {
			return {
				content: [{
					type: 'text',
					text: JSON.stringify(classifyDistributor(supplier, supplierId)),
				}],
			};
		},
	);

	server.tool(
		'bom_export_csv',
		'Export the BOM as a tracking CSV. If outputPath points to an existing file, user-edited columns (Chosen_Distributor, Notes) are preserved by stable component row ID, with Designators as a legacy fallback. Returns the CSV content as a string and writes to disk if outputPath is given.',
		withDocumentParam({
			snapshot: z.any().optional(),
			outputPath: z.string().optional().describe('Absolute path to write the CSV file. If file exists, merge user columns.'),
			includeColumns: z
				.array(z.enum(['lcsc', 'digikey', 'mouser']))
				.optional()
				.default(['lcsc'])
				.describe('Which distributor PN/Stock column pairs to include in the output'),
		}),
		async ({ snapshot, outputPath, includeColumns, ...rest }) => {
			const snap = snapshot ?? (await fetchSnapshot(bridge, rest));
			const report = buildBom(snap as DesignSnapshotMinimal);

			let existingCsv: string | undefined;
			if (outputPath && existsSync(outputPath)) {
				try { existingCsv = await fs.readFile(outputPath, 'utf-8'); } catch { /* ignore */ }
			}
			const csv = bomToCsv(report, { existingCsv, includeColumns });

			if (outputPath) {
				await fs.writeFile(outputPath, csv);
			}

			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						rowCount: report.rowCount,
						bytes: csv.length,
						outputPath: outputPath ?? null,
						gapsSummary: report.gapsSummary,
						distributorBreakdown: report.distributorBreakdown,
						csvPreview: csv.split('\n').slice(0, 6).join('\n'),
					}),
				}],
			};
		},
	);
}
