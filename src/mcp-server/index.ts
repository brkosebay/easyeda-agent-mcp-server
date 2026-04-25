import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WebSocketBridge } from './bridge';
import { catalog } from './catalog';
import { registerReadTools } from './tools/read-tools';
import { registerWriteTools } from './tools/write-tools';
import { registerAnalysisTools } from './tools/analysis-tools';
import { registerSchReadTools } from './tools/sch-read-tools';
import { registerSchWriteTools } from './tools/sch-write-tools';
import { registerLibTools } from './tools/lib-tools';
import { registerManufactureTools } from './tools/manufacture-tools';
import { registerPcbDrcTools } from './tools/pcb-drc-tools';
import { registerPcbLayerTools } from './tools/pcb-layer-tools';
import { registerEditorTools } from './tools/editor-tools';
import { registerSchAnalysisTools } from './tools/sch-analysis-tools';

const PORT_RANGE_START = Number(process.env.EDA_WS_PORT) || 15168;
const PORT_RANGE_SIZE = Number(process.env.EDA_WS_PORT_RANGE) || 40;
// Dynamic toolsets are the default — 3 meta-tools (search_tools,
// describe_tools, execute_tool) instead of 100+ static schemas in the
// system prompt. Set EDA_DYNAMIC_TOOLSETS=0 to opt out and use the
// static surface (kept as a safety hatch for non-MCP-aware clients).
const DYNAMIC_TOOLSETS = process.env.EDA_DYNAMIC_TOOLSETS !== '0';

async function main() {
	const bridge = await WebSocketBridge.startOnAvailablePort(PORT_RANGE_START, PORT_RANGE_SIZE);

	const server = new McpServer(
		{
			name: 'easyeda-agent-mcp-server',
			version: '1.0.0',
		},
		{
			instructions: DYNAMIC_TOOLSETS
				? [
					'This server exposes EasyEDA Pro through three meta-tools to keep the tool catalog out of context.',
					'1. Call search_tools(query, tags?) to discover relevant tools by intent or tag filter.',
					'2. Call describe_tools(names) to fetch argument schemas for the candidates you picked.',
					'3. Call execute_tool(name, args) to run a tool. Same return shape as the static surface.',
					'Always call wait_for_extension first if you spawned this MCP server fresh.',
				].join(' ')
				: [
					'This server provides direct access to schematic and PCB designs in EasyEDA Pro.',
					'When the user asks about their circuit designs, schematics, PCB layouts, components, footprints, or netlist connections, check this server in addition to (or instead of) searching the filesystem for design files.',
					'Start with `server_info` to check connectivity, then use `editor_get_open_tabs` or `project_get_structure` to discover what designs are available.',
				].join(' '),
		},
	);

	// `server_info` and `list_instances` always stay on the static surface —
	// the agent needs them to bootstrap discovery in either mode.
	server.tool(
		'server_info',
		'MCP server status: WebSocket port, connection state, connected instances, allowed origins.',
		{},
		async () => {
			const instances = bridge.getConnectedInstances();
			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						wsPort: bridge.getPort(),
						extensionConnected: bridge.isConnected(),
						connectedInstanceCount: instances.length,
						instances: instances.map((info) => ({
							instanceId: info.instanceId,
							projectName: info.projectName,
							currentDocument: info.currentDocument,
							documentType: info.documentType,
						})),
						mode: DYNAMIC_TOOLSETS ? 'dynamic_toolsets' : 'static',
						toolCount: catalog.count(),
						allowAllOrigins: process.env.EDA_WS_ALLOW_ALL_ORIGINS === '1',
					}),
				}],
			};
		},
	);

	server.tool(
		'list_instances',
		'List connected EasyEDA Pro instances with their state (project, active document, tabs). Use to find instance_id when multiple are connected.',
		{},
		async () => {
			await bridge.refreshAllInstanceInfo();
			const instances = bridge.getConnectedInstances();

			if (instances.length === 0) {
				return {
					content: [{
						type: 'text' as const,
						text: 'No EasyEDA Pro instances are connected. Please open EasyEDA Pro and click "Connect Claude" in the Claude menu.',
					}],
				};
			}

			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						connectedInstanceCount: instances.length,
						instances: instances.map((info) => ({
							instanceId: info.instanceId,
							projectName: info.projectName,
							currentDocument: info.currentDocument,
							documentType: info.documentType,
							documents: info.documents,
							connectedAt: new Date(info.connectedAt).toISOString(),
						})),
						note: instances.length === 1
							? 'Only one instance connected — instance_id can be omitted from tool calls (auto-selected).'
							: 'Multiple instances connected — pass instance_id to tool calls to target a specific instance.',
					}),
				}],
			};
		},
	);

	// Register every concrete tool against the catalog. Module signatures
	// expect McpServer; the catalog quacks the same `.tool()` shape so a
	// type cast is enough.
	const registrar = catalog as unknown as McpServer;
	registerReadTools(registrar, bridge);
	registerWriteTools(registrar, bridge);
	registerAnalysisTools(registrar, bridge);
	registerSchReadTools(registrar, bridge);
	registerSchWriteTools(registrar, bridge);
	registerLibTools(registrar, bridge);
	registerManufactureTools(registrar, bridge);
	registerPcbDrcTools(registrar, bridge);
	registerPcbLayerTools(registrar, bridge);
	registerEditorTools(registrar, bridge);
	registerSchAnalysisTools(registrar, bridge);

	if (DYNAMIC_TOOLSETS) {
		catalog.attachDynamic(server);
		// Pre-warm the embeddings model in the background so the first
		// search_tools call doesn't pay the load cost in the user's path.
		setTimeout(() => catalog.prewarm(), 50);
	} else {
		catalog.attachStatic(server);
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);

	const underlying = (server as any).server;
	if (underlying) {
		underlying.oninitialized = () => {
			const info = underlying.getClientVersion?.();
			if (info && (info.name || info.version)) {
				bridge.setClientInfo({ name: info.name, version: info.version });
				console.error(`[MCP] Client connected: ${info.name ?? '(unnamed)'} ${info.version ?? ''}`);
			}
		};
	}

	console.error('[MCP] EasyEDA Agent MCP Server started');
	console.error(`[MCP] Mode: ${DYNAMIC_TOOLSETS ? 'dynamic toolsets (3 meta-tools)' : 'static'}, ${catalog.count()} concrete tools in catalog`);
	console.error(`[MCP] WebSocket Server on port ${bridge.getPort()}, waiting for EDA Pro Extension...`);

	bridge.notifyPeers(PORT_RANGE_START, PORT_RANGE_SIZE);

	process.on('SIGINT', async () => {
		await bridge.stop();
		process.exit(0);
	});

	process.on('SIGTERM', async () => {
		await bridge.stop();
		process.exit(0);
	});
}

main().catch((err) => {
	console.error('[MCP] Fatal error:', err);
	process.exit(1);
});
