// Datasheet cache — shared on-disk store for downloaded PDFs + extracted
// metadata. In the future this lives inside the daemon (one shared cache
// across all MCP processes, see docs/KICAD-HAPPY-PORT.md "Architecture
// track" A6). Today it's a direct on-disk cache under ~/.easyeda-mcp/.
//
// API is daemon-ready: every call returns Promises and uses content-hash
// keys, so swapping the implementation to talk to the daemon over UDS is
// a one-file change.
//
// kicad-happy reference: skills/datasheets/scripts/datasheet_extract_cache.py

import { promises as fs, existsSync } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { dirname, join } from 'path';

const CACHE_ROOT = process.env.EDA_DATASHEET_CACHE_DIR
	|| join(homedir(), '.easyeda-mcp', 'datasheets');

const MANIFEST_FILENAME = 'manifest.json';
const PDF_FILENAME = 'datasheet.pdf';
const META_FILENAME = 'meta.json';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_PDF_BYTES = 50 * 1024 * 1024; // 50MB safety bound

const USER_AGENT = 'easyeda-agent-mcp/1.0';

interface ManifestEntry {
	mpn: string;
	lcscCode?: string;
	url: string;
	sha256: string;
	bytes: number;
	fetchedAt: number;
	pages?: number;
}

interface Manifest {
	version: 1;
	entries: Record<string, ManifestEntry>; // key = normalized MPN or LCSC code
}

let manifestCache: Manifest | null = null;
let manifestPath = join(CACHE_ROOT, MANIFEST_FILENAME);

function normalizeKey(mpnOrCode: string): string {
	return mpnOrCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function partDir(key: string): string {
	const safe = normalizeKey(key);
	// Two-level hash dir to avoid one giant directory
	const h = createHash('sha1').update(safe).digest('hex');
	return join(CACHE_ROOT, h.slice(0, 2), safe);
}

async function ensureRoot(): Promise<void> {
	if (!existsSync(CACHE_ROOT)) {
		await fs.mkdir(CACHE_ROOT, { recursive: true });
	}
}

async function loadManifest(): Promise<Manifest> {
	if (manifestCache) return manifestCache;
	await ensureRoot();
	try {
		const raw = await fs.readFile(manifestPath, 'utf-8');
		manifestCache = JSON.parse(raw) as Manifest;
		if (manifestCache.version !== 1) manifestCache = { version: 1, entries: {} };
	} catch {
		manifestCache = { version: 1, entries: {} };
	}
	return manifestCache;
}

async function saveManifest(): Promise<void> {
	if (!manifestCache) return;
	await fs.writeFile(manifestPath, JSON.stringify(manifestCache, null, 2));
}

export interface CachedDatasheet {
	mpn: string;
	lcscCode?: string;
	url: string;
	pdfPath: string;
	sha256: string;
	bytes: number;
	fetchedAt: number;
	pages?: number;
}

export async function getCachedDatasheet(mpnOrCode: string): Promise<CachedDatasheet | null> {
	const key = normalizeKey(mpnOrCode);
	const manifest = await loadManifest();
	const entry = manifest.entries[key];
	if (!entry) return null;
	const dir = partDir(key);
	const pdfPath = join(dir, PDF_FILENAME);
	if (!existsSync(pdfPath)) {
		// Manifest got out of sync with disk
		delete manifest.entries[key];
		await saveManifest();
		return null;
	}
	return { ...entry, pdfPath };
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<ArrayBuffer> {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), timeoutMs);
	try {
		// LCSC PDFs may use protocol-relative URLs.
		const safeUrl = url.startsWith('//') ? `https:${url}` : url;
		const res = await fetch(safeUrl, {
			headers: { 'User-Agent': USER_AGENT },
			signal: ac.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${safeUrl}`);
		const buf = await res.arrayBuffer();
		if (buf.byteLength > MAX_PDF_BYTES) {
			throw new Error(`Datasheet exceeds ${MAX_PDF_BYTES} byte safety bound`);
		}
		return buf;
	} finally {
		clearTimeout(t);
	}
}

function looksLikePdf(buf: ArrayBuffer): boolean {
	if (buf.byteLength < 5) return false;
	const head = new Uint8Array(buf, 0, 5);
	return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d; // "%PDF-"
}

export interface FetchOptions {
	mpn: string;
	lcscCode?: string;
	url: string;
	force?: boolean;
}

export async function fetchAndCacheDatasheet(opts: FetchOptions): Promise<CachedDatasheet> {
	const key = normalizeKey(opts.lcscCode || opts.mpn);
	const dir = partDir(key);
	const manifest = await loadManifest();
	const existing = manifest.entries[key];

	if (existing && !opts.force) {
		const pdfPath = join(dir, PDF_FILENAME);
		if (existsSync(pdfPath)) {
			return { ...existing, pdfPath };
		}
	}

	if (!opts.url) throw new Error('fetchAndCacheDatasheet: url is required');

	const buf = await fetchWithTimeout(opts.url, FETCH_TIMEOUT_MS);
	if (!looksLikePdf(buf)) {
		throw new Error(`Response from ${opts.url} is not a PDF (${buf.byteLength} bytes)`);
	}

	await fs.mkdir(dir, { recursive: true });
	const pdfPath = join(dir, PDF_FILENAME);
	await fs.writeFile(pdfPath, Buffer.from(buf));

	const sha256 = createHash('sha256').update(Buffer.from(buf)).digest('hex');
	const entry: ManifestEntry = {
		mpn: opts.mpn,
		lcscCode: opts.lcscCode,
		url: opts.url,
		sha256,
		bytes: buf.byteLength,
		fetchedAt: Date.now(),
	};

	const meta = {
		mpn: opts.mpn,
		lcscCode: opts.lcscCode,
		url: opts.url,
		fetchedAt: entry.fetchedAt,
	};
	await fs.writeFile(join(dir, META_FILENAME), JSON.stringify(meta, null, 2));

	manifest.entries[key] = entry;
	await saveManifest();

	return { ...entry, pdfPath };
}

/** Drop one entry from the manifest + disk. */
export async function evictDatasheet(mpnOrCode: string): Promise<boolean> {
	const key = normalizeKey(mpnOrCode);
	const manifest = await loadManifest();
	if (!manifest.entries[key]) return false;
	delete manifest.entries[key];
	await saveManifest();
	const dir = partDir(key);
	try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
	return true;
}

export async function listCachedDatasheets(): Promise<CachedDatasheet[]> {
	const manifest = await loadManifest();
	return Object.entries(manifest.entries).map(([key, entry]) => ({
		...entry,
		pdfPath: join(partDir(key), PDF_FILENAME),
	}));
}

export async function cacheStats(): Promise<{ entries: number; bytes: number; root: string }> {
	const manifest = await loadManifest();
	let bytes = 0;
	for (const e of Object.values(manifest.entries)) bytes += e.bytes;
	return { entries: Object.keys(manifest.entries).length, bytes, root: CACHE_ROOT };
}
