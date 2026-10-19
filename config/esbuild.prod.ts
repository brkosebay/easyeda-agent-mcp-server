import esbuild from 'esbuild';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const RELEASE = process.argv.includes('--release');

// Extension build: IIFE for EDA Pro browser environment
const extensionConfig: esbuild.BuildOptions = {
	entryPoints: { 'index': './src/extension/index' },
	entryNames: '[name]',
	bundle: true,
	minify: false,
	outdir: './dist/',
	platform: 'browser',
	format: 'iife',
	globalName: 'edaEsbuildExportName',
	define: {
		// Embed the location only; the credential stays on the local machine.
		// `--release` embeds nothing: the builder's home path must not ship in
		// a published .eext, and the extension derives ~/.easyeda-mcp/token at
		// runtime instead (native-peer.ts derivedTokenPath).
		__NATIVE_DAEMON_TOKEN_PATH__: JSON.stringify(RELEASE ? '' : process.env.EDA_NATIVE_DAEMON_TOKEN_PATH || join(process.env.EDA_DAEMON_DIR || join(homedir(), '.easyeda-mcp'), 'token')),
		// Every packaged version is its own bridge generation, so an in-place
		// upgrade always retires the previous bundle's socket callbacks.
		__EXTENSION_VERSION__: JSON.stringify(JSON.parse(readFileSync('./extension.json', 'utf8')).version),
	},
	treeShaking: true,
	ignoreAnnotations: true,
};

// MCP Server build: CJS for Node.js
//
// Heavy / native deps stay external — they ship native .node binaries that
// esbuild can't bundle. The runtime resolves them from node_modules normally.
const mcpServerConfig: esbuild.BuildOptions = {
	entryPoints: { 'index': './src/mcp-server/index' },
	entryNames: '[name]',
	bundle: true,
	minify: false,
	outdir: './dist/mcp-server/',
	platform: 'node',
	format: 'cjs',
	treeShaking: true,
	external: [
		'@xenova/transformers',
		'onnxruntime-node',
		'onnxruntime-web',
		'sharp',
	],
};

// Daemon build: standalone CJS for Node.js. Runs as a detached subprocess,
// owns the extension WebSocket and the cross-agent write lock. Optional —
// only used when EDA_DAEMON=1 in MCP processes.
const daemonConfig: esbuild.BuildOptions = {
	entryPoints: { 'index': './src/daemon/index' },
	entryNames: '[name]',
	bundle: true,
	minify: false,
	outdir: './dist/daemon/',
	platform: 'node',
	format: 'cjs',
	treeShaking: true,
};

(async () => {
	await esbuild.build(extensionConfig);
	console.log('[esbuild] Extension built');

	await esbuild.build(mcpServerConfig);
	console.log('[esbuild] MCP Server built');

	await esbuild.build(daemonConfig);
	console.log('[esbuild] Daemon built');
})();
