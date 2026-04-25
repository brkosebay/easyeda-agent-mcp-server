import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WebSocketBridge } from './bridge';
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

async function main() {
	const bridge = await WebSocketBridge.startOnAvailablePort(PORT_RANGE_START, PORT_RANGE_SIZE);

	const server = new McpServer(
		{
			name: 'easyeda-agent-mcp-server',
			version: '1.0.0',
		},
		{
			instructions: [
				'This server provides direct access to schematic and PCB designs in EasyEDA Pro.',
				'When the user asks about their circuit designs, schematics, PCB layouts, components, footprints, or netlist connections, check this server in addition to (or instead of) searching the filesystem for design files.',
				'Start with `server_info` to check connectivity, then use `editor_get_open_tabs` or `project_get_structure` to discover what designs are available.',
			].join(' '),
		},
	);

	server.tool(
		'server_info',
		'Get MCP server status: WebSocket port, connection state, connected instances, and allowed origins',
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
						allowAllOrigins: process.env.EDA_WS_ALLOW_ALL_ORIGINS === '1',
					}),
				}],
			};
		},
	);

	server.tool(
		'list_instances',
		'List all connected EasyEDA Pro instances with their current state (project, active document, open tabs). Use this to find the instance_id you need for other tools when multiple instances are connected.',
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

	registerReadTools(server, bridge);
	registerWriteTools(server, bridge);
	registerAnalysisTools(server, bridge);
	registerSchReadTools(server, bridge);
	registerSchWriteTools(server, bridge);
	registerLibTools(server, bridge);
	registerManufactureTools(server, bridge);
	registerPcbDrcTools(server, bridge);
	registerPcbLayerTools(server, bridge);
	registerEditorTools(server, bridge);
	registerSchAnalysisTools(server, bridge);

	const transport = new StdioServerTransport();
	await server.connect(transport);

	// Capture clientInfo from the MCP `initialize` request once the client
	// completes the handshake. Surface it on the bridge so the extension
	// can label "Claude Code chat XYZ" / "Codex chat ABC" connections.
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
	console.error(`[MCP] WebSocket Server on port ${bridge.getPort()}, waiting for EDA Pro Extension...`);

	// Notify any peer MCP servers so their connected extensions discover us immediately
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
