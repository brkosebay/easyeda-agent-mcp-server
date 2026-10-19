import { registerNativeProjectTools } from './tools/native-project-tools';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WebSocketBridge } from './bridge';
import { DaemonClient } from './daemon-client';
import { catalog } from './catalog';
import { setLeaseSupport, leaseSupportError } from './lease-context';
import { registerReadTools } from './tools/read-tools';
import { registerWriteTools } from './tools/write-tools';
import { registerAnalysisTools } from './tools/analysis-tools';
import { registerSchReadTools } from './tools/sch-read-tools';
import { registerSchWriteTools } from './tools/sch-write-tools';
import { registerLibTools } from './tools/lib-tools';
import { registerManufactureTools } from './tools/manufacture-tools';
import { registerPcbDrcTools } from './tools/pcb-drc-tools';
import { registerPourFillTools } from './tools/pour-fill-tools';
import { registerPcbLayerTools } from './tools/pcb-layer-tools';
import { registerEditorTools } from './tools/editor-tools';
import { registerSchAnalysisTools } from './tools/sch-analysis-tools';
import { registerPlacementTools } from './tools/placement-tools';
import { registerBoardContextTools } from './tools/board-context-tools';
import { registerBomTools } from './tools/bom-tools';
import { registerSourcingTools } from './tools/sourcing-tools';
import { registerDatasheetTools } from './tools/datasheet-tools';
import { registerBundleTools } from './tools/bundle-tools';
import { registerEmcTools } from './tools/emc-tools';
import { registerThermalTools } from './tools/thermal-tools';
import { registerPcbExtractTools } from './tools/pcb-extract-tools';
import { registerCrossTools } from './tools/cross-tools';
import { registerPcbEmcTools } from './tools/pcb-emc-tools';
import { registerSpiceTools } from './tools/spice-tools';
import { registerFabReleaseTools } from './tools/fab-release-tools';
import { registerDocgenTools } from './tools/docgen-tools';
import { registerImpedanceTools } from './tools/impedance-tools';
import { registerRouteCleanupTools } from './tools/route-cleanup-tools';
import { registerFunctionalTools } from './tools/functional-tools';
import { registerNativeEditorTools } from './tools/native-editor-tools';
import { registerSplitPourTools } from './tools/split-pour-tools';
import { registerRoutePairTools } from './tools/route-pair-tools';
import { registerNativeAutorouteTools } from './tools/native-autoroute-tools';

const PORT_RANGE_START = Number(process.env.EDA_WS_PORT) || 15168;
const PORT_RANGE_SIZE = Number(process.env.EDA_WS_PORT_RANGE) || 40;
// Dynamic toolsets are the default — 3 meta-tools (search_tools,
// describe_tools, execute_tool) instead of 100+ static schemas in the
// system prompt. Set EDA_DYNAMIC_TOOLSETS=0 to opt out and use the
// static surface (kept as a safety hatch for non-MCP-aware clients).
const DYNAMIC_TOOLSETS = process.env.EDA_DYNAMIC_TOOLSETS !== '0';

// Daemon mode is the DEFAULT (eliminates the N-bridges-per-machine port-scan
// storm + cross-agent doc-lock corruption bug). Set EDA_DAEMON=0 to opt OUT
// and use the legacy per-MCP WebSocketBridge.
const USE_DAEMON = process.env.EDA_DAEMON !== '0';

const PARENT_WATCH_MS = 10_000;

async function main() {
	const bridge: any = USE_DAEMON
		? new DaemonClient()
		: await WebSocketBridge.startOnAvailablePort(PORT_RANGE_START, PORT_RANGE_SIZE);
	if (USE_DAEMON) {
		console.error('[MCP] Daemon mode enabled — connecting to ~/.easyeda-mcp/daemon.sock');
	}

	const server = new McpServer(
		{
			name: 'easyeda-agent-mcp-server',
			version: '1.0.0',
		},
		{
			instructions: DYNAMIC_TOOLSETS
				? [
					'This server exposes EasyEDA Pro through three meta-tools to keep the tool catalog out of context.',
					'1. search_tools(query, tags?) finds tools by intent.',
					'2. describe_tools(names) returns one-line-per-arg signatures — batch every tool you need into ONE call; skip it when you know the args (invalid args return the signature).',
					'3. execute_tool(name, args) runs a tool.',
					'Results over ~24k chars come back trimmed with a "_truncated.handle": page with read_result instead of re-running; never paste big results back as arguments (pass the handle).',
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
			let daemonStatusError: string | undefined;
			if (USE_DAEMON) {
				try {
					await bridge.refreshAllInstanceInfo();
				} catch (err: any) {
					daemonStatusError = err instanceof Error ? err.message : String(err);
				}
			}
			const instances = bridge.getConnectedInstances();
			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						wsPort: bridge.getPort(),
						extensionConnected: bridge.isConnected(),
						daemonMode: USE_DAEMON,
						daemonConnected: USE_DAEMON
							? typeof bridge.isDaemonConnected === 'function' && bridge.isDaemonConnected()
							: undefined,
						daemonStatusError,
						daemon: USE_DAEMON && typeof (bridge as any).getDaemonInfo === 'function'
							? (bridge as any).getDaemonInfo()
							: undefined,
						connectedInstanceCount: instances.length,
						instances: instances.map((info: any) => ({
							instanceId: info.instanceId,
							projectName: info.projectName,
							currentDocument: info.currentDocument,
							documentType: info.documentType,
							connectedAt: info.connectedAt ? new Date(info.connectedAt).toISOString() : undefined,
							bridgeGeneration: info.bridgeGeneration ?? '(pre-2026-09-23 extension — reinstall to get the gate watchdog)',
							// ready | busy | reconciliation-required, with the active
							// EasyEDA call and queue depth. "busy" for a long time means
							// EasyEDA is blocked (dialog / placement mode) — press Esc,
							// then native_operation_reset if requests still time out.
							gate: info.gate,
							health: info.health,
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
						instances: instances.map((info: any) => ({
							instanceId: info.instanceId,
							projectName: info.projectName,
							currentDocument: info.currentDocument,
							documentType: info.documentType,
							documents: info.documents,
							connectedAt: new Date(info.connectedAt).toISOString(),
							gate: info.gate,
							health: info.health,
						})),
						note: instances.length === 1
							? 'Only one instance connected — instance_id can be omitted from tool calls (auto-selected).'
							: 'Multiple instances connected — pass instance_id to tool calls to target a specific instance.',
					}),
				}],
			};
		},
	);

	// Multi-agent coordination — static so an orchestrator can hand out leases
	// without tool discovery. See docs/MULTI-AGENT.md.
	setLeaseSupport(USE_DAEMON);
	server.tool(
		'work_lease',
		'Multi-agent coordination (skip when working alone). claim → lease id that subagents pass as execute_tool(lease=…); writes into a leased document without it are refused. Modes: exclusive (sole writer, default), shared (several writers with disjoint declared scope, checked at claim), read (enforced read-only). Any call under it renews it; default TTL 15 min. list shows leases + tab-switch counts.',
		{
			action: z.enum(['claim', 'renew', 'release', 'list']),
			documents: z.array(z.string()).optional().describe('claim: document UUIDs the lease covers (required unless mode=read)'),
			mode: z.enum(['exclusive', 'shared', 'read']).optional(),
			owner: z.string().optional().describe('claim: short worker label shown to agents that hit the lease'),
			task: z.string().optional(),
			scope: z.object({
				nets: z.array(z.string()).optional(),
				designators: z.array(z.string()).optional(),
				pages: z.array(z.string()).optional(),
				region: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }).optional(),
			}).optional().describe('shared mode: what this worker touches'),
			ttl_minutes: z.number().positive().max(120).optional(),
			lease_id: z.string().optional().describe('renew/release'),
			all: z.boolean().optional().describe('release: drop every lease (orchestrator cleanup)'),
			instance_id: z.string().optional(),
		},
		async ({ action, documents, mode, owner, task, scope, ttl_minutes, lease_id, all, instance_id }) => {
			const unsupported = leaseSupportError();
			const respond = (value: unknown, isError = false) => ({
				content: [{ type: 'text' as const, text: JSON.stringify(value) }],
				...(isError ? { isError: true } : {}),
			});
			if (unsupported) return respond({ error: unsupported }, true);
			try {
				const result = await (bridge as DaemonClient).lease({
					action,
					documents,
					mode,
					owner,
					task,
					scope,
					ttlMs: ttl_minutes != null ? Math.round(ttl_minutes * 60_000) : undefined,
					leaseId: lease_id,
					all,
					instanceId: instance_id,
				});
				return respond(result);
			} catch (err: any) {
				return respond({ error: err?.message ?? String(err) }, true);
			}
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
	registerPourFillTools(registrar, bridge);
	registerPcbLayerTools(registrar, bridge);
	registerEditorTools(registrar, bridge);
	registerNativeProjectTools(registrar, bridge);
	registerSchAnalysisTools(registrar, bridge);
	registerPlacementTools(registrar, bridge);
	registerBoardContextTools(registrar, bridge);
	registerBomTools(registrar, bridge);
	registerSourcingTools(registrar, bridge);
	registerDatasheetTools(registrar, bridge);
	registerBundleTools(registrar, bridge);
	registerEmcTools(registrar, bridge);
	registerThermalTools(registrar, bridge);
	registerPcbExtractTools(registrar, bridge);
	registerCrossTools(registrar, bridge);
	registerPcbEmcTools(registrar, bridge);
	registerSpiceTools(registrar, bridge);
	registerFabReleaseTools(registrar, bridge);
	registerDocgenTools(registrar, bridge);
	registerImpedanceTools(registrar, bridge);
	registerRouteCleanupTools(registrar, bridge);
	registerFunctionalTools(registrar, bridge);
	registerNativeEditorTools(registrar, bridge);
	registerSplitPourTools(registrar, bridge);
	registerRoutePairTools(registrar, bridge);
	registerNativeAutorouteTools(registrar, bridge);

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

	if (!USE_DAEMON) {
		(bridge as WebSocketBridge).notifyPeers(PORT_RANGE_START, PORT_RANGE_SIZE);
	}

	// Live exactly as long as the client. stdin EOF is the normal signal, but a
	// client that dies through a wrapper (Claude Desktop launches servers via a
	// helper) can leave this process reparented to launchd, so also watch the
	// parent pid and stdout. Orphans used to accumulate for days.
	let stopping = false;
	const shutdown = async (reason: string) => {
		if (stopping) return;
		stopping = true;
		console.error(`[MCP] Shutting down: ${reason}`);
		setTimeout(() => process.exit(0), 3_000).unref(); // never hang on a slow bridge stop
		try { await bridge.stop(); } catch {/* exiting anyway */}
		process.exit(0);
	};
	process.stdin.on('end', () => void shutdown('client closed stdin'));
	process.stdin.on('close', () => void shutdown('client closed stdin'));
	process.stdout.on('error', (err: NodeJS.ErrnoException) => {
		if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') void shutdown('client closed stdout');
	});
	const parentPid = process.ppid;
	setInterval(() => {
		if (process.ppid !== parentPid) void shutdown(`parent process ${parentPid} exited`);
	}, PARENT_WATCH_MS).unref();
	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('SIGHUP', () => void shutdown('SIGHUP'));
}

main().catch((err) => {
	console.error('[MCP] Fatal error:', err);
	process.exit(1);
});
