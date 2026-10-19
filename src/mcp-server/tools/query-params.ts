import { z } from 'zod';

const documentDescription =
	'Target document UUID — auto-switches to this document before executing. Get UUIDs from list_instances or editor_get_open_tabs.';

/**
 * Instance ID parameter — added to every tool to support multi-instance routing.
 */
export const instanceParam = {
	instance_id: z
		.string()
		.optional()
		.describe(
			'Target EasyEDA instance ID (8-char hex). Required when multiple instances are connected. Omit when only one instance is connected (auto-selected). Use list_instances to see connected instances.',
		),
	_timeoutMs: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Override the bridge request timeout for this call (ms). Omit to use the tool/server default. For long operations, bump per call or set EDA_WS_TIMEOUT_MS env.',
		),
};

/**
 * Document parameter — required on pcb_* and sch_* tools so agents always
 * declare which document they're targeting, enabling safe multi-agent access.
 */
export const documentParam = {
	document: z.string().describe(documentDescription),
};

/**
 * Optional document parameter — for tools where a document context is useful
 * but not strictly required (e.g. editor tools).
 */
export const optionalDocumentParam = {
	document: z.string().optional().describe(documentDescription),
};

/**
 * Generic query parameters for post-processing results from data-returning tools.
 * These are extracted by the extension's ws-client before dispatching to handlers,
 * then applied as post-processing on the result.
 */
export const queryParams = {
	...instanceParam,
	...documentParam,
	fields: z
		.array(z.string())
		.optional()
		.describe(
			'Project results to only these top-level keys. Response includes _availableFields showing all keys. IMPORTANT: Always specify fields when you know what you need — without it, responses include every property and can be extremely large (100KB+), wasting context.',
		),
	filter: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
		.optional()
		.describe(
			'Keep items matching all conditions (AND). Exact: {key: value}, prefix glob: {key: "R*"}, OR: {key: ["a","b"]}',
		),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe('Truncate result array to at most N items'),
	compact: z
		.boolean()
		.optional()
		.describe(
			'Strip noisy fields and keep only identity + key geometry (primitiveId, net, layer, x, y, designator, padNumber, lineWidth, holeDiameter, diameter). Use whenever you only need IDs or quick verification — drops 80–95% of bytes.',
		),
};

/** Spread into a tool's params object to add query param support (includes required document). */
export function withQueryParams<T extends Record<string, z.ZodTypeAny>>(
	params: T,
): T & typeof queryParams {
	return { ...params, ...queryParams };
}

/** Add instance_id + required document to a tool's params. For pcb/sch tools that don't use withQueryParams. */
export function withDocumentParam<T extends Record<string, z.ZodTypeAny>>(
	params: T,
): T & typeof instanceParam & typeof documentParam {
	return { ...params, ...instanceParam, ...documentParam };
}

/** Add only instance_id to a tool's params. For tools that don't need a document (e.g. lib, editor). */
export function withInstanceParam<T extends Record<string, z.ZodTypeAny>>(
	params: T,
): T & typeof instanceParam {
	return { ...params, ...instanceParam };
}
