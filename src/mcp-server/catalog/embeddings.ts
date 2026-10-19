// Lazy-loaded local embeddings via @xenova/transformers (pure JS / ONNX,
// no native deps). Uses Xenova/all-MiniLM-L6-v2 — 384-dim, ~22 MB on first
// download, then cached under ~/.cache/huggingface/transformers/. Embedding
// 80 tools at startup takes ~3 s on first run, ~200 ms on subsequent runs
// once the model is in the disk cache.
//
// We also persist {hash, vectors} in ONE shared cache file under the daemon
// directory, so every MCP process — whatever its working directory — reuses
// the same vectors instead of re-embedding the corpus.
//
// Memory: the corpus is embedded in small, length-sorted batches. One batch of
// all ~230 tools (padded to the longest description) made onnxruntime's CPU
// arena peak at ~7 GB, and the arena keeps its peak for the life of the
// process — every MCP server that missed the cache sat at 6.5 GB.

import { createHash } from 'crypto';
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';

const EMBED_BATCH = 8;

let pipelinePromise: Promise<any> | null = null;

async function getEmbedder(): Promise<(text: string | string[]) => Promise<number[][]>> {
	if (!pipelinePromise) {
		pipelinePromise = (async () => {
			// Dynamic import — keeps the SDK out of the static graph so static-mode
			// startups don't pay the load cost.
			const t = await import('@xenova/transformers');
			// Xenova ships pre-quantized ONNX models. all-MiniLM-L6-v2 is the
			// canonical small sentence encoder.
			const pipe = await t.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
			return async (text: string | string[]) => {
				const out = await pipe(text, { pooling: 'mean', normalize: true });
				// out.data is a Float32Array; out.dims describes shape.
				if (Array.isArray(text)) {
					const [n, d] = out.dims as [number, number];
					const flat = Array.from(out.data as Float32Array);
					const vecs: number[][] = [];
					for (let i = 0; i < n; i++) vecs.push(flat.slice(i * d, (i + 1) * d));
					return vecs;
				} else {
					return [Array.from(out.data as Float32Array) as number[]];
				}
			};
		})();
	}
	return pipelinePromise;
}

export function cosine(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0;
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	// Vectors are L2-normalized by the pipeline; cosine == dot.
	return dot;
}

const CACHE_FILE = join(process.env.EDA_DAEMON_DIR || join(homedir(), '.easyeda-mcp'), 'cache', 'tool-embeddings.json');

interface EmbeddingsCache {
	hash: string;
	vectors: Record<string, number[]>;
}

function hashCorpus(entries: Array<{ name: string; text: string }>): string {
	const h = createHash('sha256');
	for (const e of entries) h.update(`${e.name}\0${e.text}\n`);
	return h.digest('hex').slice(0, 16);
}

async function loadCache(): Promise<EmbeddingsCache | null> {
	try {
		const raw = await readFile(CACHE_FILE, 'utf8');
		const parsed = JSON.parse(raw) as EmbeddingsCache;
		if (parsed && parsed.hash && parsed.vectors) return parsed;
	} catch {/* missing or invalid */}
	return null;
}

async function saveCache(cache: EmbeddingsCache): Promise<void> {
	try {
		await mkdir(dirname(CACHE_FILE), { recursive: true });
		// Write-then-rename: concurrent MCP processes never read a torn file.
		const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify(cache));
		await rename(tmp, CACHE_FILE);
	} catch {/* best-effort */}
}

/** Cached corpus vectors if the shared cache matches, without loading the model. */
export async function loadCachedCorpus(
	entries: Array<{ name: string; text: string }>,
): Promise<Record<string, number[]> | null> {
	const cached = await loadCache();
	return cached && cached.hash === hashCorpus(entries) ? cached.vectors : null;
}

export async function embedCorpus(
	entries: Array<{ name: string; text: string }>,
): Promise<Record<string, number[]>> {
	const cached = await loadCachedCorpus(entries);
	if (cached) return cached;

	const embed = await getEmbedder();
	const out: Record<string, number[]> = {};
	// Similar lengths per batch keep padding (and the attention tensors) small.
	const ordered = entries.slice().sort((a, b) => a.text.length - b.text.length);
	for (let i = 0; i < ordered.length; i += EMBED_BATCH) {
		const batch = ordered.slice(i, i + EMBED_BATCH);
		const vectors = await embed(batch.map((e) => e.text));
		batch.forEach((e, j) => { out[e.name] = vectors[j]; });
	}

	await saveCache({ hash: hashCorpus(entries), vectors: out });
	return out;
}

export async function embedQuery(text: string): Promise<number[]> {
	const embed = await getEmbedder();
	const [v] = await embed(text);
	return v;
}
