// Benchmark suite for dynamic toolsets mode. Prints a clean summary so we
// can decide whether to flip dynamic-default in the next release.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = "/Users/berkaykosebay/coding_projects/easyeda-agent-mcp-server/.claude/worktrees/dynamic-toolsets";
const PORT_BASE = 15172;

function newClient(name, env) {
	const client = new Client({ name, version: "1.0" });
	const transport = new StdioClientTransport({
		command: "node",
		args: [`${ROOT}/dist/mcp-server/index.js`],
		env: { ...process.env, ...env },
	});
	return { client, transport };
}

const text = (r) => r.content.map((c) => c.text ?? "").join("");

async function callTool(client, name, args = {}) {
	const r = await client.callTool({ name, arguments: args });
	const t = text(r);
	try { return { json: JSON.parse(t), raw: t, error: r.isError }; }
	catch { return { raw: t, error: r.isError }; }
}

// === Test 1: search-quality matrix ====================================
const SEARCH_CASES = [
	{ q: "create a copper trace between two pads", expectTop: ["pcb_create_track", "pcb_route_orthogonal"] },
	{ q: "list every component on the schematic",     expectTop: ["sch_get_all_components"] },
	{ q: "find DRC violations and group them",        expectTop: ["pcb_drc_summarize", "pcb_run_drc"] },
	{ q: "rebuild every copper pour on the board",    expectTop: ["pcb_repour_all"] },
	{ q: "run the autorouter on this PCB",            expectTop: ["pcb_autoroute"] },
	{ q: "screenshot the PCB canvas",                 expectTop: ["pcb_screenshot_board", "editor_screenshot"] },
	{ q: "look up an LCSC component by its C number", expectTop: ["lib_get_device_by_lcsc"] },
	{ q: "save the current design",                   expectTop: ["pcb_save", "sch_save"] },
	{ q: "analyze the power tree and regulators",     expectTop: ["sch_analyze_power_tree"] },
	{ q: "delete all tracks on the ground net",       expectTop: ["pcb_delete_tracks_by_filter", "pcb_delete_primitives"] },
	{ q: "where is pin 3 of resistor R1 located",     expectTop: ["pcb_get_pad"] },
	{ q: "verify ESD protection on connectors",       expectTop: ["sch_analyze_esd_coverage"] },
];

async function searchQuality(client) {
	console.log("\n=== Search quality matrix ===");
	let pass = 0, top1 = 0, top3 = 0;
	const detail = [];
	for (const { q, expectTop } of SEARCH_CASES) {
		const t0 = Date.now();
		const r = await callTool(client, "search_tools", { query: q, limit: 10 });
		const elapsed = Date.now() - t0;
		const ranked = (r.json ?? []).map((x) => x.name);
		const idx = ranked.findIndex((n) => expectTop.includes(n));
		const ok = idx >= 0;
		if (ok) {
			pass++;
			if (idx === 0) top1++;
			if (idx <= 2) top3++;
		}
		const got = ranked[0] ?? "(none)";
		detail.push({ q: q.slice(0, 45), expect: expectTop[0], got, idx: idx < 0 ? "—" : idx + 1, ms: elapsed });
	}
	console.table(detail);
	console.log(`Found in top-N: ${pass}/${SEARCH_CASES.length}, top-1: ${top1}/${SEARCH_CASES.length}, top-3: ${top3}/${SEARCH_CASES.length}`);
	return { pass, top1, top3, total: SEARCH_CASES.length };
}

// === Test 2: schema fidelity ==========================================
async function schemaFidelity(client) {
	console.log("\n=== Schema fidelity ===");
	const targets = [
		"pcb_create_track",        // mix of strings, numbers, union, optional
		"pcb_create_via_mm",       // numbers + enum-union via viaType
		"pcb_get_all_primitives",  // enum + optional union + defaults
		"pcb_help",                // simple enum
		"sch_extract_design",      // optional bool with default
	];
	const r = await callTool(client, "describe_tools", { names: targets });
	const items = r.json ?? [];
	const checks = [];
	for (const item of items) {
		const params = item.parameters ?? {};
		const hasRequired = Object.values(params).some((v) => v.required === true);
		const hasOptional = Object.values(params).some((v) => v.required === false);
		const hasOneOf = Object.values(params).some((v) => v.oneOf);
		const hasEnum = Object.values(params).some((v) => v.enum);
		checks.push({
			tool: item.name,
			fields: Object.keys(params).length,
			hasRequired, hasOptional, hasOneOf, hasEnum,
			brief: (item.brief ?? "").slice(0, 50),
		});
	}
	console.table(checks);
	const allOk = items.length === targets.length && items.every((i) => i.parameters && Object.keys(i.parameters).length > 0);
	console.log(`All ${targets.length} tools described with non-empty parameters: ${allOk ? "✓" : "✗"}`);
	return allOk;
}

// === Test 3: execute_tool passthrough + error paths ===================
async function executePaths(client) {
	console.log("\n=== Execute paths ===");
	const cases = [];

	// 3a: valid execute (no extension needed)
	let t0 = Date.now();
	let r = await callTool(client, "execute_tool", { name: "pcb_help", args: { topic: "polygon" } });
	cases.push({ test: "execute pcb_help OK", ok: !r.error && /Polygon input/.test(r.raw), ms: Date.now() - t0 });

	// 3b: unknown tool name
	t0 = Date.now();
	r = await callTool(client, "execute_tool", { name: "definitely_not_real", args: {} });
	cases.push({ test: "unknown tool → error", ok: r.error === true && /Unknown tool/.test(r.raw), ms: Date.now() - t0 });

	// 3c: invalid args
	t0 = Date.now();
	r = await callTool(client, "execute_tool", { name: "pcb_help", args: { topic: "nonsense" } });
	cases.push({ test: "bad args → validation error", ok: r.error === true && /Invalid arguments/.test(r.raw), ms: Date.now() - t0 });

	// 3d: tool requiring extension when not connected
	t0 = Date.now();
	r = await callTool(client, "execute_tool", { name: "pcb_get_all_nets", args: { document: "fake-uuid" } });
	cases.push({ test: "ext-needed tool w/o ext → clean error", ok: r.error === true || /not connected/i.test(r.raw), ms: Date.now() - t0 });

	// 3e: missing required arg
	t0 = Date.now();
	r = await callTool(client, "execute_tool", { name: "pcb_create_track", args: {} });
	cases.push({ test: "missing required → validation error", ok: r.error === true && /Invalid arguments/.test(r.raw), ms: Date.now() - t0 });

	console.table(cases);
	const allOk = cases.every((c) => c.ok);
	console.log(`All execute-path checks: ${allOk ? "✓" : "✗"}`);
	return allOk;
}

// === Test 4: end-to-end sequence latency (search → describe → execute) ===
async function sequenceLatency(client) {
	console.log("\n=== End-to-end sequence latency (cached) ===");
	// A realistic 3-step task: find a tool, learn its schema, run it.
	const t0 = Date.now();
	const s = await callTool(client, "search_tools", { query: "show inline help about polygons" });
	const t1 = Date.now();
	const d = await callTool(client, "describe_tools", { names: ["pcb_help"] });
	const t2 = Date.now();
	const e = await callTool(client, "execute_tool", { name: "pcb_help", args: { topic: "polygon" } });
	const t3 = Date.now();
	console.table([
		{ step: "search_tools", ms: t1 - t0, ok: !s.error },
		{ step: "describe_tools", ms: t2 - t1, ok: !d.error },
		{ step: "execute_tool", ms: t3 - t2, ok: !e.error },
		{ step: "TOTAL", ms: t3 - t0, ok: !s.error && !d.error && !e.error },
	]);
	return t3 - t0;
}

// === Test 5: tag-only search ==========================================
async function tagSearch(client) {
	console.log("\n=== Tag-only search (no embedding cost) ===");
	const queries = [
		{ tags: ["sch", "analyze"], expectMin: 5 },
		{ tags: ["pcb", "drc"],     expectMin: 4 },
		{ tags: ["editor"],         expectMin: 5 },
		{ tags: ["lib"],            expectMin: 3 },
		{ tags: ["pcb", "via"],     expectMin: 2 },
	];
	const out = [];
	for (const { tags, expectMin } of queries) {
		const t0 = Date.now();
		const r = await callTool(client, "search_tools", { query: "", tags, limit: 50 });
		const count = (r.json ?? []).length;
		out.push({ tags: tags.join(","), count, expectMin, ok: count >= expectMin, ms: Date.now() - t0 });
	}
	console.table(out);
	return out.every((r) => r.ok);
}

// === Run =================================================================
const { client, transport } = newClient("dynamic-bench", {
	EDA_DYNAMIC_TOOLSETS: "1",
	EDA_WS_PORT: String(PORT_BASE),
	EDA_WS_PORT_RANGE: "10",
});
await client.connect(transport);

// Warm-start: trigger model load + cache once before measuring.
console.log("Warming up embeddings model...");
const warmT = Date.now();
await callTool(client, "search_tools", { query: "warmup", limit: 1 });
console.log(`Warmup: ${Date.now() - warmT}ms\n`);

const summary = {};
summary.search = await searchQuality(client);
summary.schemaOk = await schemaFidelity(client);
summary.executeOk = await executePaths(client);
summary.totalSeqMs = await sequenceLatency(client);
summary.tagOk = await tagSearch(client);

console.log("\n========== SUMMARY ==========");
console.log(`Semantic search: top-1 ${summary.search.top1}/${summary.search.total}, top-3 ${summary.search.top3}/${summary.search.total}, found ${summary.search.pass}/${summary.search.total}`);
console.log(`Schema fidelity: ${summary.schemaOk ? "PASS" : "FAIL"}`);
console.log(`Execute paths:   ${summary.executeOk ? "PASS" : "FAIL"}`);
console.log(`Tag search:      ${summary.tagOk ? "PASS" : "FAIL"}`);
console.log(`Sequence total:  ${summary.totalSeqMs}ms (search → describe → execute)`);

await client.close();
