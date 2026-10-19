// Tool catalog. Modules call `catalog.tool(name, brief, schema, handler)`
// instead of `server.tool(...)`; the catalog then exposes either:
//   - static mode: every tool registered individually on the McpServer
//     (current behavior, default).
//   - dynamic mode: only search_tools / describe_tools / execute_tool
//     registered on the McpServer; the agent discovers tools on demand.
//
// The choice is made at server startup based on EDA_DYNAMIC_TOOLSETS=1.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, ZodRawShape, ZodTypeAny } from 'zod';
import { inferTags, CATEGORY_OVERVIEW } from './tags';
import { embedCorpus, embedQuery, cosine, loadCachedCorpus } from './embeddings';
import type { ToolDefinition, ToolHandler, ToolSearchResult } from './types';
import { leaseContext, leaseSupportError } from '../lease-context';
import { shapeToolResult, readStoredResult, fitToBudget, resolveResultHandles, DEFAULT_MAX_CHARS } from './response-shaper';

// Recovery tools whose output must reach the agent exactly as produced.
const UNSHAPED_TOOLS = /native/;

function shaped<T extends { content?: any[] }>(tool: string, result: T, opts: { maxChars?: number; raw?: boolean } = {}): T {
	if (UNSHAPED_TOOLS.test(tool)) return result;
	return shapeToolResult(result, { tool, ...opts });
}

export class ToolCatalog {
	private tools = new Map<string, ToolDefinition>();
	private vectorsPromise: Promise<Record<string, number[]>> | null = null;

	/**
	 * Register a tool. Same shape as McpServer.tool() so callers can swap
	 * `server` → `catalog` without other changes. `tags` defaults to inferred.
	 */
	tool<TArgs extends ZodRawShape>(
		name: string,
		brief: string,
		schema: TArgs,
		handler: (args: { [K in keyof TArgs]: z.infer<TArgs[K]> } & Record<string, any>) => ReturnType<ToolHandler>,
		tags?: string[],
	): void {
		if (this.tools.has(name)) {
			throw new Error(`Tool already registered: ${name}`);
		}
		this.tools.set(name, {
			name,
			brief,
			tags: tags ?? inferTags(name),
			schema: schema as ZodRawShape,
			handler: handler as unknown as ToolHandler,
		});
	}

	get(name: string): ToolDefinition | undefined {
		return this.tools.get(name);
	}

	all(): ToolDefinition[] {
		return Array.from(this.tools.values());
	}

	count(): number {
		return this.tools.size;
	}

	getCategoryOverview(): string {
		return CATEGORY_OVERVIEW;
	}

	/**
	 * Static mode — register every tool individually on the McpServer.
	 * Same surface as before this refactor.
	 */
	attachStatic(server: McpServer): void {
		for (const t of this.tools.values()) {
			server.tool(t.name, t.brief, t.schema, (async (args: any) => shaped(t.name, await t.handler(args))) as any);
		}
		this.registerReadResult(server);
	}

	/** Pages into results that exceeded the response budget (see response-shaper.ts). */
	private registerReadResult(server: McpServer): void {
		server.tool(
			'read_result',
			'Page into a tool result that was cut to fit the response budget (its "_truncated.handle"). path = dot path into the result (e.g. "nets" or "violations.3.items"); arrays page with offset/limit and can be projected with fields.',
			{
				handle: z.string(),
				path: z.string().optional(),
				offset: z.number().int().min(0).optional(),
				limit: z.number().int().positive().max(500).optional(),
				fields: z.array(z.string()).optional(),
				max_chars: z.number().int().min(0).optional(),
			},
			async ({ handle, path, offset, limit, fields, max_chars }) => {
				try {
					const value = readStoredResult({ handle, path, offset, limit, fields });
					return { content: [{ type: 'text', text: fitToBudget('read_result', value, max_chars ?? DEFAULT_MAX_CHARS) }] };
				} catch (err: any) {
					return { content: [{ type: 'text', text: JSON.stringify({ error: err?.message ?? String(err) }) }], isError: true };
				}
			},
		);
	}

	/**
	 * Dynamic mode — register only the 3 meta-tools. The agent discovers
	 * concrete tools via search_tools, learns their schemas via describe_tools,
	 * then runs them via execute_tool.
	 */
	attachDynamic(server: McpServer): void {
		const overview = this.getCategoryOverview();
		const totalTools = this.tools.size;

		server.tool(
			'search_tools',
			`Search the EasyEDA Pro tool catalog by intent (semantic) or by tag filter. Returns tool names + brief descriptions; call describe_tools to get schemas before execute_tool. ${totalTools} tools total.\n\n${overview}`,
			{
				query: z.string().describe('Natural-language description of what you want to do (semantic search), or empty to list everything.'),
				tags: z.array(z.string()).optional().describe('Filter by tags (AND). Examples: ["pcb","write"], ["sch","analyze"], ["read","drc"]'),
				limit: z.number().int().positive().optional().default(10).describe('Max results (default 10)'),
			},
			async ({ query, tags, limit }) => {
				const results = await this.search(query ?? '', tags, limit ?? 10);
				return { content: [{ type: 'text', text: JSON.stringify(results) }] };
			},
		);

		server.tool(
			'describe_tools',
			'Argument signatures for tools (batch every tool you plan to use into ONE call). Returns {name, args} — one "name?: type = default — note" line per argument. format "json" gives JSON-schema instead.',
			{
				names: z.array(z.string()).min(1).describe('Tool names to describe'),
				format: z.enum(['compact', 'json']).optional(),
			},
			async ({ names, format }) => {
				const out: Array<Record<string, any>> = [];
				for (const name of names) {
					const t = this.tools.get(name);
					if (!t) {
						out.push({ name, error: 'Not found. Use search_tools to discover available tools.' });
						continue;
					}
					// One malformed schema must not fail the whole batch — degrade
					// that single tool to a stub listing its argument names.
					try {
						out.push(format === 'json'
							? { name: t.name, parameters: zodShapeToJsonSchema(t.schema) }
							: { name: t.name, args: zodShapeToSignature(t.schema) });
					} catch (err: any) {
						out.push({
							name: t.name,
							parameters: Object.fromEntries(Object.keys(t.schema ?? {}).map((k) => [k, { type: 'unknown' }])),
							schemaError: err?.message ?? String(err),
						});
					}
				}
				return { content: [{ type: 'text', text: JSON.stringify(out) }] };
			},
		);

		this.registerReadResult(server);

		server.tool(
			'execute_tool',
			'Run a catalog tool. If you already know its args, call it directly — invalid args return the signature, so describe_tools is optional. Big results come back trimmed with a read_result handle.',
			{
				name: z.string().describe('Tool name (exact match — see search_tools / describe_tools)'),
				args: z.record(z.string(), z.any()).optional().describe('Tool arguments matching its schema'),
				_timeoutMs: z.number().int().positive().optional().describe('Per-call deadline in milliseconds. Merged into args and forwarded to the extension; overrides the default bridge timeout for this call.'),
				lease: z.string().optional().describe('Multi-agent only: work lease id (from work_lease claim) this call runs under. Omit when working alone.'),
				override_leases: z.boolean().optional().describe('Orchestrator only: run despite other agents\' active leases.'),
				max_chars: z.number().int().min(0).optional().describe(`Response budget in chars (default ${DEFAULT_MAX_CHARS || 'unlimited'}; 0 = unlimited). Bigger results come back trimmed with a read_result handle.`),
				raw: z.boolean().optional().describe('Exact, unrounded, untrimmed output (scripts that parse full results).'),
			},
			async ({ name, args, _timeoutMs, lease, override_leases, max_chars, raw }) => {
				const t = this.tools.get(name);
				if (!t) {
					return {
						content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}. Use search_tools to discover available tools.` }) }],
						isError: true,
					};
				}
				// `_timeoutMs` is accepted both as a sibling of `args` and inside
				// `args`; the sibling wins. It is not part of any tool's schema, so
				// it is stripped by validation and re-attached afterwards.
				const rawArgs: Record<string, unknown> = { ...(args ?? {}) };
				const inlineTimeout = Number(rawArgs._timeoutMs);
				delete rawArgs._timeoutMs;
				const effectiveTimeoutMs = _timeoutMs != null
					? _timeoutMs
					: (Number.isFinite(inlineTimeout) && inlineTimeout > 0 ? inlineTimeout : undefined);

				// Validate args against the tool's schema before dispatching.
				const validation = z.object(t.schema).safeParse(rawArgs);
				if (!validation.success) {
					return {
						content: [{ type: 'text', text: JSON.stringify({
							error: 'Invalid arguments for ' + name,
							issues: validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
							args: safeSignature(t.schema),
						}) }],
						isError: true,
					};
				}
				const leaseError = (lease || override_leases) ? leaseSupportError() : undefined;
				if (leaseError) {
					return { content: [{ type: 'text', text: JSON.stringify({ error: leaseError, tool: name }) }], isError: true };
				}
				try {
					const data = resolveResultHandles(validation.data as Record<string, unknown>);
					const dispatchArgs = effectiveTimeoutMs != null ? { ...data, _timeoutMs: effectiveTimeoutMs } : data;
					// Every bridge call the handler makes inherits the lease.
					const result = await leaseContext.run({ leaseId: lease, overrideLeases: override_leases }, () => t.handler(dispatchArgs));
					const out = shaped(name, result as any, { maxChars: max_chars, raw });
					// Validation strips keys the schema doesn't know; say so instead of
					// letting a misspelled argument fall back to its default silently.
					const ignored = Object.keys(rawArgs).filter((k) => !(k in t.schema));
					if (ignored.length && Array.isArray((out as any)?.content)) {
						(out as any).content = [...(out as any).content, { type: 'text', text: JSON.stringify({
							ignoredArgs: ignored,
							note: `not parameters of ${name}; they had no effect (describe_tools lists the real ones)`,
						}) }];
					}
					return out;
				} catch (err: any) {
					return {
						content: [{ type: 'text', text: JSON.stringify({ error: err?.message ?? String(err), tool: name }) }],
						isError: true,
					};
				}
			},
		);
	}

	/**
	 * Combined semantic + tag search. Tag filter applies first (AND match
	 * against the tool's tag set). If a query is provided, results are
	 * sorted by cosine similarity against tool embeddings; otherwise by
	 * tool name.
	 */
	async search(query: string, tagFilter: string[] | undefined, limit: number): Promise<ToolSearchResult[]> {
		// 1. Apply tag filter.
		// Legacy traps (e.g. the net-less polyline "track") only surface when asked for by name.
		const wantsLegacy = /legacy|polyline/i.test(query) || (tagFilter ?? []).some((t) => /legacy/i.test(t));
		let candidates = Array.from(this.tools.values()).filter((t) => wantsLegacy || !t.brief.startsWith('[LEGACY]'));
		if (tagFilter && tagFilter.length > 0) {
			const required = new Set(tagFilter.map((t) => t.toLowerCase()));
			candidates = candidates.filter((t) => {
				const set = new Set(t.tags.map((x) => x.toLowerCase()));
				for (const r of required) if (!set.has(r)) return false;
				return true;
			});
		}

		if (candidates.length === 0) return [];

		// 2. If no query, return alphabetical (by name) up to limit.
		if (!query.trim()) {
			return candidates
				.slice()
				.sort((a, b) => a.name.localeCompare(b.name))
				.slice(0, limit)
				.map((t) => ({ name: t.name, brief: firstSentence(t.brief) }));
		}

		// 3. Semantic search.
		try {
			const vectors = await this.ensureVectors();
			const q = await embedQuery(query);
			const scored = candidates.map((t) => ({
				tool: t,
				score: vectors[t.name] ? cosine(q, vectors[t.name]) : 0,
			}));
			scored.sort((a, b) => b.score - a.score);
			return scored.slice(0, limit).map((s) => ({ name: s.tool.name, brief: firstSentence(s.tool.brief) }));
		} catch (err: any) {
			// Embeddings unavailable — fall back to a keyword scorer so the
			// agent still gets a useful response.
			const q = query.toLowerCase();
			const scored = candidates.map((t) => {
				const hay = `${t.name} ${t.brief} ${t.tags.join(' ')}`.toLowerCase();
				return { tool: t, score: scoreKeyword(q, hay) };
			});
			scored.sort((a, b) => b.score - a.score);
			return scored.slice(0, limit).map((s) => ({ name: s.tool.name, brief: firstSentence(s.tool.brief) }));
		}
	}

	private corpus(): Array<{ name: string; text: string }> {
		return Array.from(this.tools.values()).map((t) => ({
			name: t.name,
			text: `${t.name} ${t.brief} tags: ${t.tags.join(' ')}`,
		}));
	}

	private ensureVectors(): Promise<Record<string, number[]>> {
		if (!this.vectorsPromise) this.vectorsPromise = embedCorpus(this.corpus());
		return this.vectorsPromise;
	}

	/**
	 * Best-effort startup warm-up that only reads the shared vector cache. It
	 * never loads the model: every Claude/Codex session with this server
	 * configured starts one, most never search, and a cache miss is
	 * re-embedded on the first real search_tools call instead.
	 */
	prewarm(): void {
		if (this.vectorsPromise) return;
		loadCachedCorpus(this.corpus())
			.then((vectors) => { if (vectors && !this.vectorsPromise) this.vectorsPromise = Promise.resolve(vectors); })
			.catch(() => {/* no cache; first search embeds */});
	}
}

// First sentence of a brief — search results only need the gist; the agent
// gets full schemas from describe_tools.
function firstSentence(brief: string): string {
	const m = brief.match(/^[^.!?]*[.!?]/);
	return (m ? m[0] : brief).trim();
}

// Lightweight keyword scorer used as a fallback if @xenova/transformers fails.
function scoreKeyword(query: string, hay: string): number {
	const terms = query.split(/\s+/).filter(Boolean);
	if (terms.length === 0) return 0;
	let hits = 0;
	for (const term of terms) {
		if (hay.includes(term)) hits++;
	}
	return hits / terms.length;
}

// Convert a Zod shape to a compact JSON-schema-like object the LLM can read.
// We don't need full JSON schema fidelity — just type, optional, default,
// and the description string.
// Boilerplate parameters shared by most tools: their long descriptions were
// re-sent on every describe_tools call (~68% of which re-describe a tool the
// agent already saw). One short gloss each is enough.
const SHARED_PARAM_GLOSS: Record<string, string> = {
	instance_id: '',
	document: 'document UUID (from list_instances)',
	fields: 'project result items to these keys',
	filter: 'exact-match filter on item keys',
	limit: 'max items',
	compact: 'false = full raw objects',
	timeoutMs: 'max wait ms',
	cacheTtlMs: 'reuse board snapshot younger than this',
	forceRefresh: 'rebuild board snapshot first',
	cacheMaxEntries: '',
	pinConcurrency: '',
	snapshot: 'omit (the tool fetches it; daemon-cached) or pass a "res_…" handle — never paste a snapshot',
};
// Accepted by every tool but already a sibling argument of execute_tool.
const SIGNATURE_OMIT = new Set(['_timeoutMs']);

/**
 * TypeScript-style signature, one line per argument:
 *   layer?: "TopLayer"|"BottomLayer" = "TopLayer" — copper layer
 * Roughly half the tokens of the JSON-schema form, and models read it as well.
 */
export function zodShapeToSignature(shape: ZodRawShape): string {
	const schema = zodShapeToJsonSchema(shape);
	return Object.entries(schema).filter(([key]) => !SIGNATURE_OMIT.has(key)).map(([key, spec]) => {
		const optional = spec.required === false ? '?' : '';
		const def = spec.default !== undefined ? ` = ${JSON.stringify(spec.default)}` : '';
		const gloss = key in SHARED_PARAM_GLOSS ? SHARED_PARAM_GLOSS[key] : spec.description;
		return `${key}${optional}: ${renderType(spec)}${def}${gloss ? ` — ${gloss}` : ''}`;
	}).join('\n');
}

function renderType(spec: Record<string, any> | undefined, depth = 0): string {
	if (!spec) return 'any';
	if (Array.isArray(spec.oneOf)) return spec.oneOf.map((o: any) => renderType(o, depth)).join(' | ');
	if (Array.isArray(spec.enum)) return spec.enum.map((v: unknown) => JSON.stringify(v)).join('|');
	switch (spec.type) {
		case 'array': {
			const inner = renderType(spec.items, depth);
			return /[|\s]/.test(inner) && !inner.startsWith('{') ? `(${inner})[]` : `${inner}[]`;
		}
		case 'object':
			if (spec.properties) {
				if (depth >= 3) return 'object';
				const props = Object.entries<any>(spec.properties).map(([k, p]) => {
					const note = p.description && p.description.length <= 90 ? ` /*${p.description}*/` : '';
					return `${k}${p.required === false ? '?' : ''}: ${renderType(p, depth + 1)}${note}`;
				});
				return `{${props.join(', ')}}`;
			}
			if (spec.additionalProperties) return `Record<string, ${renderType(spec.additionalProperties, depth + 1)}>`;
			return 'object';
		default:
			return spec.type ?? 'any';
	}
}

function zodShapeToJsonSchema(shape: ZodRawShape): Record<string, any> {
	const out: Record<string, any> = {};
	for (const [key, val] of Object.entries(shape)) {
		out[key] = describeZod(val as ZodTypeAny);
		// timeoutMs carries the same long description on dozens of schemas —
		// collapse to a short shared one in the dynamic surface.
		if (key === 'timeoutMs' && out[key].description) out[key].description = 'Max wait in ms';
	}
	return out;
}

// A zod schema node is an object carrying `_def`. Zod 4 reuses `_def.type` for
// the type *tag* (a plain string), so any accessor that may hold either a tag
// or a nested schema has to be probed rather than trusted.
function isZodNode(v: any): v is ZodTypeAny {
	return !!v && (typeof v === 'object' || typeof v === 'function') && !!(v as any)._def;
}

function firstZodNode(...candidates: any[]): ZodTypeAny | undefined {
	for (const c of candidates) if (isZodNode(c)) return c;
	return undefined;
}

function zodShapeOf(def: any): ZodRawShape {
	// Zod 3: `_def.shape` is a getter function. Zod 4: it's a plain object.
	const shape = def?.shape;
	if (typeof shape === 'function') {
		try { return shape.call(def) ?? {}; } catch { return {}; }
	}
	if (shape && typeof shape === 'object') return shape as ZodRawShape;
	return {};
}

function describeZod(t: ZodTypeAny | undefined): Record<string, any> {
	if (!isZodNode(t)) return { type: 'unknown' };
	const def: any = (t as any)._def;
	const desc: string | undefined = (t as any).description ?? def?.description;
	const out: Record<string, any> = {};
	if (desc) out.description = desc;

	// Zod 4 uses lowercase `_def.type` ("optional", "number", "default", ...).
	// Zod 3 used `_def.typeName` ("ZodOptional", "ZodNumber", ...). Normalize.
	// Zod 3 stores a nested schema under `_def.type` for some wrappers, so only
	// accept it as the tag when it is actually a string.
	const rawType = typeof def?.type === 'string' ? def.type : undefined;
	const raw: string | undefined = rawType ?? (typeof def?.typeName === 'string' ? def.typeName : undefined);
	const tag = (raw ?? '').replace(/^Zod/, '').toLowerCase();

	switch (tag) {
		case 'string': out.type = 'string'; break;
		case 'number': out.type = 'number'; break;
		case 'boolean': out.type = 'boolean'; break;
		case 'enum':
			out.type = 'string';
			// Zod 3: `_def.values` is an array. Zod 4: `_def.entries` is an object.
			out.enum = Array.isArray(def.values)
				? def.values
				: (def.entries && typeof def.entries === 'object' ? Object.values(def.entries) : []);
			break;
		case 'array':
			out.type = 'array';
			// Zod 4: `_def.element`. Zod 3: `_def.type` holds the element schema.
			out.items = describeZod(firstZodNode(def.element, def.valueType, def.type));
			break;
		case 'object':
			out.type = 'object';
			out.properties = zodShapeToJsonSchema(zodShapeOf(def));
			break;
		case 'record':
			out.type = 'object';
			out.additionalProperties = describeZod(firstZodNode(def.valueType, def.value, def.type));
			break;
		case 'nullable':
		case 'readonly':
			Object.assign(out, describeZod(firstZodNode(def.innerType, def.type)));
			if (desc) out.description = desc;
			break;
		case 'optional':
			Object.assign(out, describeZod(firstZodNode(def.innerType, def.type)));
			if (desc) out.description = desc; // restore — assign overwrote it
			out.required = false;
			break;
		case 'default':
		case 'prefault':
			Object.assign(out, describeZod(firstZodNode(def.innerType, def.type)));
			if (desc) out.description = desc;
			out.default = typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue;
			out.required = false;
			break;
		case 'union': {
			const opts = (def.options ?? []).map((o: ZodTypeAny) => describeZod(o));
			out.oneOf = opts;
			break;
		}
		case 'any':
		case 'unknown':
			out.type = 'any';
			break;
		default:
			out.type = tag || 'unknown';
	}
	if (out.required === undefined && tag !== 'optional' && tag !== 'default') {
		out.required = true;
	}
	return out;
}

function safeSignature(shape: ZodRawShape): string {
	try { return zodShapeToSignature(shape); } catch { return Object.keys(shape ?? {}).join(', '); }
}

export const catalog = new ToolCatalog();
