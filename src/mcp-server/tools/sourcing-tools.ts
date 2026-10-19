// Sourcing tools — LCSC only (EasyEDA's native distributor).
//
// jlcsearch.tscircuit.com (free, no auth) for fuzzy MPN search.
// wmsc.lcsc.com for authoritative LCSC C-code lookups.
//
// All BOM enrichment for non-LCSC distributors deliberately scoped out —
// EasyEDA users overwhelmingly source through LCSC and we don't want the
// agent to hold paid API keys.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';
import {
	resolveLcsc,
	searchLcsc,
	lookupLcscByCode,
	type LcscPart,
} from '../sourcing/lcsc';
import { buildBom, type DesignSnapshotMinimal } from '../analyzers/bom';

interface EnrichmentResult {
	mpn: string;
	designators: string[];
	qty: number;
	resolved: boolean;
	stock?: number;
	priceTiers?: LcscPart['priceTiers'];
	lcscCode?: string;
	datasheetUrl?: string;
	lifecycle?: string;
	error?: string;
}

async function pMapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let i = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (true) {
			const idx = i++;
			if (idx >= items.length) return;
			out[idx] = await fn(items[idx], idx);
		}
	});
	await Promise.all(workers);
	return out;
}

export function registerSourcingTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'sourcing_lcsc_search',
		'Look up a part on LCSC (via jlcsearch + wmsc.lcsc.com). Accepts an MPN, an LCSC C-code (Cxxxxx), or a free-text query. Returns mpn, manufacturer, lcscCode, stock, priceTiers, datasheetUrl, packageType, basicPart flag, and lifecycle.',
		{
			query: z.string().describe('Manufacturer Part Number, LCSC C-code (Cxxxxx), or free-text search'),
			enrich: z.boolean().optional().default(true).describe('Cross-check authoritative pricing/stock via wmsc.lcsc.com when jlcsearch returns a C-code'),
		},
		async ({ query, enrich }) => {
			const part = await resolveLcsc(query, { enrich });
			if (!part) {
				return { content: [{ type: 'text', text: JSON.stringify({ found: false, query }) }] };
			}
			// Strip the bulky raw response from the response — it's only kept
			// internally for debugging.
			const { raw, ...slim } = part;
			return { content: [{ type: 'text', text: JSON.stringify({ found: true, query, ...slim }) }] };
		},
	);

	server.tool(
		'sourcing_lcsc_enrich_bom',
		'Walk every BOM row with an MPN or LCSC C-code and fill in stock/pricing/lifecycle/datasheetUrl from LCSC in one batch. Returns per-row enrichment results plus aggregate stats. Concurrency-limited so the public API isn\'t hammered.',
		withDocumentParam({
			snapshot: z.any().optional().describe('Pre-fetched snapshot from sch_extract_design'),
			concurrency: z.number().int().min(1).max(8).optional().default(4),
			enrichWithWmsc: z.boolean().optional().default(true).describe('Use wmsc.lcsc.com for authoritative pricing/stock'),
		}),
		async ({ snapshot, concurrency, enrichWithWmsc, ...rest }) => {
			const snap = snapshot ?? (await bridge.send('sch.extract.design', { ...rest, _timeoutMs: 120_000 }));
			const report = buildBom(snap as DesignSnapshotMinimal);

			const candidates = report.rows.filter((r) => r.mpn || r.distributorId);

			const results: EnrichmentResult[] = await pMapWithConcurrency(candidates, concurrency, async (row) => {
				const query = row.distributorId && /^c\d+$/i.test(row.distributorId) ? row.distributorId : row.mpn;
				if (!query) {
					return { mpn: row.mpn, designators: row.designators, qty: row.qty, resolved: false, error: 'no MPN/LCSC code' };
				}
				try {
					const part = await resolveLcsc(query, { enrich: enrichWithWmsc });
					if (!part) return { mpn: row.mpn, designators: row.designators, qty: row.qty, resolved: false };
					return {
						mpn: row.mpn,
						designators: row.designators,
						qty: row.qty,
						resolved: true,
						stock: part.stock,
						priceTiers: part.priceTiers,
						lcscCode: part.lcscCode,
						datasheetUrl: part.datasheetUrl,
						lifecycle: part.lifecycle,
					};
				} catch (err: any) {
					return { mpn: row.mpn, designators: row.designators, qty: row.qty, resolved: false, error: err?.message ?? String(err) };
				}
			});

			const resolved = results.filter((r) => r.resolved).length;
			const lowStock = results.filter((r) => r.resolved && (r.stock ?? Infinity) < 100);
			const noDatasheet = results.filter((r) => r.resolved && !r.datasheetUrl);

			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						rowCount: results.length,
						resolved,
						unresolved: results.length - resolved,
						lowStockCount: lowStock.length,
						noDatasheetCount: noDatasheet.length,
						rows: results,
					}),
				}],
			};
		},
	);

	server.tool(
		'sourcing_lcsc_lifecycle_audit',
		'Highlight BOM rows in risky lifecycle states (NRND, EOL, low stock, basic-vs-extended for JLCPCB assembly). Returns prioritized findings with suggested actions.',
		withDocumentParam({
			snapshot: z.any().optional(),
			lowStockThreshold: z.number().int().min(0).optional().default(500).describe('Stock below this triggers a low-stock warning'),
			concurrency: z.number().int().min(1).max(8).optional().default(4),
		}),
		async ({ snapshot, lowStockThreshold, concurrency, ...rest }) => {
			const snap = snapshot ?? (await bridge.send('sch.extract.design', { ...rest, _timeoutMs: 120_000 }));
			const report = buildBom(snap as DesignSnapshotMinimal);

			const findings: Array<{ severity: 'critical' | 'warning' | 'info'; rule: string; designators: string[]; mpn: string; details: any }> = [];

			const candidates = report.rows.filter((r) => r.mpn || (r.distributorId && /^c\d+$/i.test(r.distributorId)));

			await pMapWithConcurrency(candidates, concurrency, async (row) => {
				const q = /^c\d+$/i.test(row.distributorId) ? row.distributorId : row.mpn;
				const part = await resolveLcsc(q, { enrich: true });
				if (!part) {
					findings.push({ severity: 'warning', rule: 'unresolved', designators: row.designators, mpn: row.mpn, details: { query: q } });
					return;
				}
				if (part.lifecycle && /eol|obsolete|discontinued/i.test(part.lifecycle)) {
					findings.push({ severity: 'critical', rule: 'eol', designators: row.designators, mpn: row.mpn, details: { lifecycle: part.lifecycle, lcscCode: part.lcscCode } });
				}
				if (part.lifecycle && /nrnd|not.recommended/i.test(part.lifecycle)) {
					findings.push({ severity: 'warning', rule: 'nrnd', designators: row.designators, mpn: row.mpn, details: { lifecycle: part.lifecycle, lcscCode: part.lcscCode } });
				}
				if (part.stock < lowStockThreshold) {
					findings.push({ severity: part.stock === 0 ? 'critical' : 'warning', rule: 'low_stock', designators: row.designators, mpn: row.mpn, details: { stock: part.stock, lcscCode: part.lcscCode, threshold: lowStockThreshold } });
				}
				if (part.basicPart === false) {
					findings.push({ severity: 'info', rule: 'extended_part_jlcpcb', designators: row.designators, mpn: row.mpn, details: { lcscCode: part.lcscCode, note: 'Counts as JLCPCB extended part — adds setup fee per unique extended SKU' } });
				}
			});

			const bySeverity = { critical: 0, warning: 0, info: 0 };
			for (const f of findings) bySeverity[f.severity] += 1;

			return {
				content: [{
					type: 'text',
					text: JSON.stringify({ total: findings.length, bySeverity, findings }),
				}],
			};
		},
	);

	// Plumb through the raw helpers in case an agent wants direct access.
	server.tool(
		'sourcing_lcsc_lookup_code',
		'Authoritative LCSC C-code lookup via wmsc.lcsc.com. Returns the same shape as sourcing_lcsc_search but skips jlcsearch.',
		{ lcscCode: z.string().describe('LCSC C-code, e.g. "C12345"') },
		async ({ lcscCode }) => {
			const part = await lookupLcscByCode(lcscCode);
			if (!part) return { content: [{ type: 'text', text: JSON.stringify({ found: false, lcscCode }) }] };
			const { raw, ...slim } = part;
			return { content: [{ type: 'text', text: JSON.stringify({ found: true, ...slim }) }] };
		},
	);
}
