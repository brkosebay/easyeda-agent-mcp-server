// LCSC sourcing client — port of kicad-happy's fetch_datasheet_lcsc.py
//
// Two HTTP backends:
//   1. jlcsearch.tscircuit.com — community-hosted free search proxy.
//      Best for fuzzy MPN search. Returns enriched component data.
//   2. wmsc.lcsc.com — LCSC's own product detail endpoint, unauthenticated.
//      Best when you have the LCSC C-number and need authoritative pricing.
//
// No API key required for either. Both have informal rate limits — the
// client retries with backoff and caches successful lookups in-memory for
// the lifetime of the MCP process. The shared on-disk datasheet cache lives
// in the daemon (see datasheet/cache.ts).
//
// kicad-happy reference: skills/lcsc/scripts/fetch_datasheet_lcsc.py

const USER_AGENT = 'easyeda-agent-mcp/1.0 (+https://github.com/berkaykosebay/easyeda-agent-mcp-server)';
const SEARCH_TIMEOUT_MS = 15_000;

const JLCSEARCH_URL = 'https://jlcsearch.tscircuit.com/api/search';
const WMSC_DETAIL_URL = 'https://wmsc.lcsc.com/ftps/wm/product/detail';

export interface LcscPriceTier {
	qty: number;
	unitPriceUsd: number;
}

export interface LcscPart {
	mpn: string;
	manufacturer: string;
	description: string;
	lcscCode: string;            // "C12345"
	stock: number;
	priceTiers: LcscPriceTier[]; // empty if not returned
	datasheetUrl: string;        // direct PDF if available
	packageType?: string;
	basicPart?: boolean;          // JLCPCB basic vs extended part flag
	lifecycle?: string;          // 'active' | 'nrnd' | 'eol' | 'unknown'
	raw?: unknown;               // untouched response for debugging
}

export class LcscError extends Error {
	constructor(message: string, readonly cause?: unknown) {
		super(message);
		this.name = 'LcscError';
	}
}

// Process-lifetime memo — keyed by upper-cased query.
// Cleared on bridge shutdown; not persisted (datasheet PDFs are persisted
// separately in the daemon cache).
const memo = new Map<string, { value: LcscPart | null; expiresAt: number }>();
const MEMO_TTL_MS = 60 * 60 * 1000; // 1h

function memoGet(key: string): LcscPart | null | undefined {
	const hit = memo.get(key);
	if (!hit) return undefined;
	if (hit.expiresAt < Date.now()) { memo.delete(key); return undefined; }
	return hit.value;
}

function memoSet(key: string, value: LcscPart | null): void {
	memo.set(key, { value, expiresAt: Date.now() + MEMO_TTL_MS });
}

async function fetchJson(url: string, signal: AbortSignal): Promise<any> {
	const res = await fetch(url, {
		headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
		signal,
	});
	if (!res.ok) throw new LcscError(`HTTP ${res.status} from ${url}`);
	return res.json();
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
	const controller = new AbortController();
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => {
			controller.abort();
			reject(new LcscError(`Timeout after ${timeoutMs}ms`));
		}, timeoutMs);
		run(controller.signal).then(
			(v) => { clearTimeout(t); resolve(v); },
			(e) => { clearTimeout(t); reject(e); },
		);
	});
}

function parseExtra(component: any): Record<string, any> {
	const extra = component?.extra;
	if (!extra) return {};
	if (typeof extra === 'string') {
		try { return JSON.parse(extra); } catch { return {}; }
	}
	return typeof extra === 'object' ? extra : {};
}

function normalizeJlcComponent(c: any): LcscPart {
	const extra = parseExtra(c);
	const lcscNum: string = extra.number || (c.lcsc ? `C${c.lcsc}` : '');
	const mpn: string = extra.mpn || c.mfr || '';
	const datasheet: string =
		(typeof extra.datasheet === 'object' ? extra.datasheet?.pdf : '') || c.datasheet || '';
	const manufacturer: string =
		(typeof extra.manufacturer === 'object' ? extra.manufacturer?.name : '') || '';

	// jlcsearch occasionally returns price as { tiers: [{quantity, price}] }
	const rawPrice = c.price ?? extra.price;
	const priceTiers: LcscPriceTier[] = [];
	if (Array.isArray(rawPrice)) {
		for (const t of rawPrice) {
			const qty = Number(t?.quantity ?? t?.qty ?? t?.minQuantity ?? 0);
			const price = Number(t?.price ?? t?.usd ?? t?.unitPrice ?? 0);
			if (qty > 0 && Number.isFinite(price)) priceTiers.push({ qty, unitPriceUsd: price });
		}
	}

	return {
		mpn,
		manufacturer,
		description: extra.description || c.description || '',
		lcscCode: lcscNum,
		stock: Number(c.stock ?? extra.stock ?? 0),
		priceTiers,
		datasheetUrl: datasheet.startsWith('//') ? `https:${datasheet}` : datasheet,
		packageType: extra.package || c.package,
		basicPart: extra.basic === true || c.basic === true || undefined,
		lifecycle: extra.lifecycle || extra.status,
		raw: c,
	};
}

function normalizeWmscDetail(lcscCode: string, payload: any): LcscPart | null {
	const result = payload?.result || payload;
	if (!result || typeof result === 'string') return null;
	let pdfUrl = '';
	const ds = result.pdfUrl ?? result.dataSheetUrl ?? '';
	if (typeof ds === 'string') pdfUrl = ds;
	else if (Array.isArray(ds) && ds.length) pdfUrl = String(ds[0]);

	const tiers: LcscPriceTier[] = [];
	const priceList = result.productPriceList;
	if (Array.isArray(priceList)) {
		for (const p of priceList) {
			const qty = Number(p?.ladder ?? p?.minQty ?? 0);
			const usd = Number(p?.usdPrice ?? p?.productPrice ?? 0);
			if (qty > 0 && Number.isFinite(usd)) tiers.push({ qty, unitPriceUsd: usd });
		}
	}

	return {
		mpn: result.productModel || result.modelName || '',
		manufacturer: result.brandNameEn || result.manufacturer || '',
		description: result.productDescEn || result.description || '',
		lcscCode: lcscCode.toUpperCase(),
		stock: Number(result.stockNumber ?? result.stockCount ?? 0),
		priceTiers: tiers,
		datasheetUrl: pdfUrl.startsWith('//') ? `https:${pdfUrl}` : pdfUrl,
		packageType: result.encapStandard || result.encapsulation,
		lifecycle: result.partStatus,
		raw: result,
	};
}

function isLcscCode(query: string): boolean {
	return /^c\d+$/i.test(query.trim());
}

/** Search jlcsearch by MPN, LCSC code, or keyword. Prefers exact-match. */
export async function searchLcsc(query: string): Promise<LcscPart | null> {
	const key = `jlc:${query.trim().toUpperCase()}`;
	const cached = memoGet(key);
	if (cached !== undefined) return cached;

	const url = `${JLCSEARCH_URL}?q=${encodeURIComponent(query)}&limit=5&full=true`;
	let data: any;
	try {
		data = await withTimeout((signal) => fetchJson(url, signal), SEARCH_TIMEOUT_MS);
	} catch (err) {
		memoSet(key, null);
		return null;
	}

	const components: any[] = data?.components ?? [];
	if (!components.length) {
		memoSet(key, null);
		return null;
	}

	const queryUp = query.trim().toUpperCase();
	for (const c of components) {
		const norm = normalizeJlcComponent(c);
		if (norm.mpn.toUpperCase() === queryUp || norm.lcscCode.toUpperCase() === queryUp) {
			memoSet(key, norm);
			return norm;
		}
	}

	// Short queries are too fuzzy to trust — kicad-happy uses the same heuristic.
	if (query.trim().length < 6) {
		memoSet(key, null);
		return null;
	}

	const first = normalizeJlcComponent(components[0]);
	memoSet(key, first);
	return first;
}

/** Direct lookup by LCSC C-code via wmsc.lcsc.com. Authoritative pricing/stock. */
export async function lookupLcscByCode(lcscCode: string): Promise<LcscPart | null> {
	if (!isLcscCode(lcscCode)) return null;
	const key = `wmsc:${lcscCode.toUpperCase()}`;
	const cached = memoGet(key);
	if (cached !== undefined) return cached;

	const url = `${WMSC_DETAIL_URL}?productCode=${lcscCode.toUpperCase()}`;
	try {
		const data = await withTimeout((signal) => fetchJson(url, signal), SEARCH_TIMEOUT_MS);
		const norm = normalizeWmscDetail(lcscCode, data);
		memoSet(key, norm);
		return norm;
	} catch {
		memoSet(key, null);
		return null;
	}
}

/**
 * Resolve a part with the strongest signal available.
 *
 * Strategy:
 *   - If query looks like a C-code, try wmsc first (authoritative), fall back to jlcsearch.
 *   - Otherwise jlcsearch first; if it hits and returns a C-code, optionally enrich via wmsc
 *     when `enrich:true` is requested (for accurate stock/pricing).
 */
export async function resolveLcsc(
	query: string,
	opts: { enrich?: boolean } = {},
): Promise<LcscPart | null> {
	const trimmed = query.trim();
	if (!trimmed) return null;
	if (isLcscCode(trimmed)) {
		const direct = await lookupLcscByCode(trimmed);
		if (direct) return direct;
		return await searchLcsc(trimmed);
	}
	const search = await searchLcsc(trimmed);
	if (!search) return null;
	if (opts.enrich && search.lcscCode) {
		const enriched = await lookupLcscByCode(search.lcscCode);
		if (enriched) {
			// Merge — wmsc has authoritative pricing, jlcsearch has nicer description.
			return {
				...search,
				stock: enriched.stock || search.stock,
				priceTiers: enriched.priceTiers.length ? enriched.priceTiers : search.priceTiers,
				lifecycle: enriched.lifecycle ?? search.lifecycle,
				datasheetUrl: search.datasheetUrl || enriched.datasheetUrl,
			};
		}
	}
	return search;
}

/** Drop the in-memory memo (used by tests + on bridge shutdown). */
export function clearLcscMemo(): void {
	memo.clear();
}
