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
import { embedCorpus, embedQuery, cosine } from './embeddings';
import type { ToolDefinition, ToolHandler, ToolSearchResult } from './types';

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
			server.tool(t.name, t.brief, t.schema, t.handler as any);
		}
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
				limit: z.number().int().positive().optional().default(15).describe('Max results (default 15)'),
			},
			async ({ query, tags, limit }) => {
				const results = await this.search(query ?? '', tags, limit ?? 15);
				return { content: [{ type: 'text', text: JSON.stringify(results) }] };
			},
		);

		server.tool(
			'describe_tools',
			'Get full argument schemas for one or more tools by name (use after search_tools, before execute_tool). Returns {name, brief, tags, parameters} per tool — parameters is a JSON-schema-style description of accepted args.',
			{
				names: z.array(z.string()).min(1).describe('Tool names to describe'),
			},
			async ({ names }) => {
				const out: Array<Record<string, any>> = [];
				for (const name of names) {
					const t = this.tools.get(name);
					if (!t) {
						out.push({ name, error: 'Not found. Use search_tools to discover available tools.' });
						continue;
					}
					out.push({
						name: t.name,
						brief: t.brief,
						tags: t.tags,
						parameters: zodShapeToJsonSchema(t.schema),
					});
				}
				return { content: [{ type: 'text', text: JSON.stringify(out) }] };
			},
		);

		server.tool(
			'execute_tool',
			'Execute a tool from the catalog by name with the appropriate arguments (call describe_tools first if you need the schema). Same response shape as the static tool surface.',
			{
				name: z.string().describe('Tool name (exact match — see search_tools / describe_tools)'),
				args: z.record(z.string(), z.any()).optional().describe('Tool arguments matching its schema'),
			},
			async ({ name, args }) => {
				const t = this.tools.get(name);
				if (!t) {
					return {
						content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}. Use search_tools to discover available tools.` }) }],
						isError: true,
					};
				}
				// Validate args against the tool's schema before dispatching.
				const validation = z.object(t.schema).safeParse(args ?? {});
				if (!validation.success) {
					return {
						content: [{ type: 'text', text: JSON.stringify({
							error: 'Invalid arguments for ' + name,
							issues: validation.error.issues,
							hint: 'Call describe_tools(["' + name + '"]) for the full schema.',
						}) }],
						isError: true,
					};
				}
				try {
					return await t.handler(validation.data);
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
		let candidates = Array.from(this.tools.values());
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
				.map((t) => ({ name: t.name, brief: t.brief, tags: t.tags, score: 0 }));
		}

		// 3. Semantic search.
		try {
			const vectors = await this.ensureVectors();
			const q = await embedQuery(query);
			const scored = candidates.map((t) => ({
				name: t.name,
				brief: t.brief,
				tags: t.tags,
				score: vectors[t.name] ? cosine(q, vectors[t.name]) : 0,
			}));
			scored.sort((a, b) => b.score - a.score);
			return scored.slice(0, limit).map((s) => ({ ...s, score: Number(s.score.toFixed(4)) }));
		} catch (err: any) {
			// Embeddings unavailable — fall back to a keyword scorer so the
			// agent still gets a useful response.
			const q = query.toLowerCase();
			const scored = candidates.map((t) => {
				const hay = `${t.name} ${t.brief} ${t.tags.join(' ')}`.toLowerCase();
				const score = scoreKeyword(q, hay);
				return { name: t.name, brief: t.brief, tags: t.tags, score };
			});
			scored.sort((a, b) => b.score - a.score);
			return scored.slice(0, limit);
		}
	}

	private ensureVectors(): Promise<Record<string, number[]>> {
		if (!this.vectorsPromise) {
			const corpus = Array.from(this.tools.values()).map((t) => ({
				name: t.name,
				text: `${t.name} ${t.brief} tags: ${t.tags.join(' ')}`,
			}));
			this.vectorsPromise = embedCorpus(corpus);
		}
		return this.vectorsPromise;
	}

	/**
	 * Pre-warm embeddings on a background timer (best-effort). Call after
	 * server startup so the first search_tools call doesn't pay the model
	 * load cost in the user's request path.
	 */
	prewarm(): void {
		this.ensureVectors().catch(() => {/* model load failed; we'll fall back to keyword */});
	}
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
function zodShapeToJsonSchema(shape: ZodRawShape): Record<string, any> {
	const out: Record<string, any> = {};
	for (const [key, val] of Object.entries(shape)) {
		out[key] = describeZod(val as ZodTypeAny);
	}
	return out;
}

function describeZod(t: ZodTypeAny): Record<string, any> {
	const def: any = (t as any)._def;
	const desc: string | undefined = (t as any).description ?? def?.description;
	const out: Record<string, any> = {};
	if (desc) out.description = desc;

	// Zod 4 uses lowercase `_def.type` ("optional", "number", "default", ...).
	// Zod 3 used `_def.typeName` ("ZodOptional", "ZodNumber", ...). Normalize.
	const raw: string | undefined = def?.type ?? def?.typeName;
	const tag = (raw ?? '').replace(/^Zod/, '').toLowerCase();

	switch (tag) {
		case 'string': out.type = 'string'; break;
		case 'number': out.type = 'number'; break;
		case 'boolean': out.type = 'boolean'; break;
		case 'enum':
			out.type = 'string';
			out.enum = def.values ?? def.entries ?? Object.values(def.entries ?? {});
			break;
		case 'array':
			out.type = 'array';
			out.items = describeZod(def.type ?? def.element);
			break;
		case 'object':
			out.type = 'object';
			out.properties = zodShapeToJsonSchema(def.shape?.() ?? def.shape ?? {});
			break;
		case 'record':
			out.type = 'object';
			out.additionalProperties = describeZod(def.valueType ?? def.value);
			break;
		case 'optional':
			Object.assign(out, describeZod(def.innerType ?? def.type));
			if (desc) out.description = desc; // restore — assign overwrote it
			out.required = false;
			break;
		case 'default':
			Object.assign(out, describeZod(def.innerType ?? def.type));
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

export const catalog = new ToolCatalog();
