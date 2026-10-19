// Datasheet tools — fetch + cache PDFs, query the cache, and (in a later
// phase) extract relevant pages / structured features.
//
// PDF parsing/extraction is intentionally out of scope for Phase 4: the
// caching layer ships now so subsequent phases (EMC, SPICE, kidoc) can
// pull a known-good local PDF on demand.
//
// kicad-happy reference: skills/datasheets/scripts/datasheet_extract_cache.py

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import {
	cacheStats,
	evictDatasheet,
	fetchAndCacheDatasheet,
	getCachedDatasheet,
	listCachedDatasheets,
} from '../datasheet/cache';
import { resolveLcsc, lookupLcscByCode } from '../sourcing/lcsc';

export function registerDatasheetTools(server: McpServer, _bridge: WebSocketBridge): void {
	server.tool(
		'datasheet_fetch',
		'Fetch and cache a datasheet PDF for the given MPN or LCSC C-code. Looks the part up via LCSC to find the canonical PDF URL, downloads it, validates it as a PDF, and stores under ~/.easyeda-mcp/datasheets/. Returns the local path. Idempotent — already-cached PDFs are returned without redownloading unless force:true.',
		{
			mpn: z.string().optional().describe('Manufacturer Part Number (used as cache key if no LCSC code)'),
			lcscCode: z.string().optional().describe('LCSC C-code (Cxxxxx). Preferred when known.'),
			url: z.string().optional().describe('Direct PDF URL. If omitted, the URL is looked up via LCSC.'),
			force: z.boolean().optional().default(false).describe('Re-download even if cached'),
		},
		async ({ mpn, lcscCode, url, force }) => {
			if (!mpn && !lcscCode) {
				throw new Error('datasheet_fetch requires at least one of {mpn, lcscCode}');
			}

			let resolvedUrl = url;
			let resolvedMpn = mpn ?? '';
			let resolvedLcsc = lcscCode;

			if (!resolvedUrl) {
				const query = lcscCode || mpn!;
				// Prefer enriched lookup — wmsc.lcsc.com supplies a datasheet URL
				// when jlcsearch's component record doesn't include one.
				const part = await resolveLcsc(query, { enrich: true });
				if (!part) {
					throw new Error(`Could not resolve datasheet URL for "${query}" via LCSC`);
				}
				resolvedUrl = part.datasheetUrl;
				resolvedMpn = resolvedMpn || part.mpn;
				resolvedLcsc = resolvedLcsc || part.lcscCode;
				// If still no URL but we have an LCSC code, try the direct
				// wmsc lookup as a last fallback (some C-codes only resolve
				// with a fresh authoritative request).
				if (!resolvedUrl && resolvedLcsc) {
					const direct = await lookupLcscByCode(resolvedLcsc);
					if (direct?.datasheetUrl) {
						resolvedUrl = direct.datasheetUrl;
						resolvedMpn = resolvedMpn || direct.mpn;
					}
				}
				if (!resolvedUrl) {
					throw new Error(`LCSC has no datasheet URL for "${query}" (tried jlcsearch + wmsc.lcsc.com)`);
				}
			}

			const entry = await fetchAndCacheDatasheet({
				mpn: resolvedMpn,
				lcscCode: resolvedLcsc,
				url: resolvedUrl,
				force,
			});
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						mpn: entry.mpn,
						lcscCode: entry.lcscCode,
						pdfPath: entry.pdfPath,
						bytes: entry.bytes,
						sha256: entry.sha256,
						url: entry.url,
						fetchedAt: new Date(entry.fetchedAt).toISOString(),
					}),
				}],
			};
		},
	);

	server.tool(
		'datasheet_get_cached',
		'Return the cached datasheet entry for an MPN or LCSC C-code, if present. Use this before asking the agent to read a PDF — confirms the local path without triggering a network fetch.',
		{
			mpn: z.string().optional(),
			lcscCode: z.string().optional(),
		},
		async ({ mpn, lcscCode }) => {
			if (!mpn && !lcscCode) throw new Error('datasheet_get_cached requires at least one of {mpn, lcscCode}');
			const entry = await getCachedDatasheet(lcscCode || mpn!);
			if (!entry) return { content: [{ type: 'text', text: JSON.stringify({ cached: false }) }] };
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						cached: true,
						mpn: entry.mpn,
						lcscCode: entry.lcscCode,
						pdfPath: entry.pdfPath,
						bytes: entry.bytes,
						sha256: entry.sha256,
						url: entry.url,
						fetchedAt: new Date(entry.fetchedAt).toISOString(),
					}),
				}],
			};
		},
	);

	server.tool(
		'datasheet_evict',
		'Drop one cached datasheet (PDF + manifest entry). Use to force re-download with corrected URL or after upstream PDF revisions.',
		{
			mpn: z.string().optional(),
			lcscCode: z.string().optional(),
		},
		async ({ mpn, lcscCode }) => {
			if (!mpn && !lcscCode) throw new Error('datasheet_evict requires at least one of {mpn, lcscCode}');
			const ok = await evictDatasheet(lcscCode || mpn!);
			return { content: [{ type: 'text', text: JSON.stringify({ evicted: ok }) }] };
		},
	);

	server.tool(
		'datasheet_list_cache',
		'List every datasheet currently in the local cache, with size and fetch time. Useful for cleanup and to confirm what the agent has access to.',
		{},
		async () => {
			const entries = await listCachedDatasheets();
			const stats = await cacheStats();
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						stats,
						entries: entries
							.sort((a, b) => b.fetchedAt - a.fetchedAt)
							.map((e) => ({
								mpn: e.mpn,
								lcscCode: e.lcscCode,
								bytes: e.bytes,
								pdfPath: e.pdfPath,
								fetchedAt: new Date(e.fetchedAt).toISOString(),
							})),
					}),
				}],
			};
		},
	);
}
