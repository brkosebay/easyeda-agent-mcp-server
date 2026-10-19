// Call one catalog tool on a freshly built MCP server (dist/mcp-server/index.js)
// over stdio, so a new build can be tested without reconnecting the session's
// server. The server attaches to the running daemon like any other client.
//   node scripts/mcp-call.cjs TOOL '{"arg":1}' [out.json]
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { writeFileSync } = require('fs');
const { join } = require('path');

const [tool, argsJson = '{}', outFile] = process.argv.slice(2);
if (!tool) {
	console.error('usage: node scripts/mcp-call.cjs TOOL \'ARGS_JSON\' [OUT.json]');
	process.exit(2);
}

(async () => {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [join(__dirname, '..', 'dist', 'mcp-server', 'index.js')],
		env: { ...process.env },
		stderr: 'inherit',
	});
	const client = new Client({ name: 'mcp-call', version: '1.0.0' });
	await client.connect(transport);
	const started = Date.now();
	const res = await client.callTool(
		{ name: 'execute_tool', arguments: { name: tool, args: JSON.parse(argsJson), max_chars: 0 } },
		undefined,
		{ timeout: 60 * 60_000, resetTimeoutOnProgress: true },
	);
	const text = res.content?.map((c) => c.text ?? '').join('\n') ?? '';
	if (outFile) {
		writeFileSync(outFile, text);
		console.log(`${tool}: ${text.length} chars in ${((Date.now() - started) / 1000).toFixed(1)} s -> ${outFile}${res.isError ? ' (isError)' : ''}`);
	} else {
		console.log(text);
	}
	await client.close();
	process.exit(res.isError ? 1 : 0);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
