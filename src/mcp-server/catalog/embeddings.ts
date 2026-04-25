// Lazy-loaded local embeddings via @xenova/transformers (pure JS / ONNX,
// no native deps). Uses Xenova/all-MiniLM-L6-v2 — 384-dim, ~22 MB on first
// download, then cached under ~/.cache/huggingface/transformers/. Embedding
// 80 tools at startup takes ~3 s on first run, ~200 ms on subsequent runs
// once the model is in the disk cache.
//
// We also persist a tiny JSON of {hash, vectors} under .embed-cache.json so
// we can skip re-embedding on every server restart (model load itself stays
// cheap thanks to the HF cache).

import { createHash } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, join, resolve } from 'path';

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

const CACHE_DIR = resolve(process.cwd(), '.cache');
const CACHE_FILE = join(CACHE_DIR, 'tool-embeddings.json');

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
		await writeFile(CACHE_FILE, JSON.stringify(cache));
	} catch {/* best-effort */}
}

export async function embedCorpus(
	entries: Array<{ name: string; text: string }>,
): Promise<Record<string, number[]>> {
	const wantHash = hashCorpus(entries);
	const cached = await loadCache();
	if (cached && cached.hash === wantHash) {
		return cached.vectors;
	}

	const embed = await getEmbedder();
	const vectors = await embed(entries.map((e) => e.text));
	const out: Record<string, number[]> = {};
	for (let i = 0; i < entries.length; i++) out[entries[i].name] = vectors[i];

	await saveCache({ hash: wantHash, vectors: out });
	return out;
}

export async function embedQuery(text: string): Promise<number[]> {
	const embed = await getEmbedder();
	const [v] = await embed(text);
	return v;
}
