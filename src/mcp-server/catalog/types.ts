// Tool catalog types. Every tool module registers entries against the catalog;
// static-mode passes them straight to server.tool(...), dynamic-mode keeps
// them internal and exposes only search_tools / describe_tools / execute_tool.

import type { ZodRawShape } from 'zod';

export type ToolHandler<TArgs = any> = (args: TArgs) => Promise<{
	content: Array<
		| { type: 'text'; text: string }
		| { type: 'image'; data: string; mimeType: string }
	>;
	isError?: boolean;
}>;

export interface ToolDefinition {
	/** Stable tool name, e.g. `pcb_create_track`. */
	name: string;
	/** One-line description shown in search results. */
	brief: string;
	/** Tag set for category filtering (e.g. `['pcb','write','primitive']`). */
	tags: string[];
	/** Zod parameter shape. */
	schema: ZodRawShape;
	/** Tool callback. */
	handler: ToolHandler;
}

export interface ToolSearchResult {
	name: string;
	brief: string;
}
