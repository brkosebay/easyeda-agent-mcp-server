import esbuild from 'esbuild';

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

(async () => {
	// Build extension
	await esbuild.build(extensionConfig);
	console.log('[esbuild] Extension built');

	// Build MCP server
	await esbuild.build(mcpServerConfig);
	console.log('[esbuild] MCP Server built');
})();
