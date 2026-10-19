// Smoke test for describe_tools (catalog/index.ts describeZod).
//
// Registers every tool module against the real catalog with a stub bridge,
// then describes EVERY registered tool. Fails if any tool throws, degrades to
// a stub (`schemaError`), or produces an empty/unknown-only parameter set.
//
// Run: npx ts-node --compiler-options '{"module":"commonjs"}' scripts/describe-tools-smoke.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { catalog } from '../src/mcp-server/catalog';
import { registerReadTools } from '../src/mcp-server/tools/read-tools';
import { registerWriteTools } from '../src/mcp-server/tools/write-tools';
import { registerAnalysisTools } from '../src/mcp-server/tools/analysis-tools';
import { registerSchReadTools } from '../src/mcp-server/tools/sch-read-tools';
import { registerSchWriteTools } from '../src/mcp-server/tools/sch-write-tools';
import { registerLibTools } from '../src/mcp-server/tools/lib-tools';
import { registerManufactureTools } from '../src/mcp-server/tools/manufacture-tools';
import { registerPcbDrcTools } from '../src/mcp-server/tools/pcb-drc-tools';
import { registerPourFillTools } from '../src/mcp-server/tools/pour-fill-tools';
import { registerPcbLayerTools } from '../src/mcp-server/tools/pcb-layer-tools';
import { registerEditorTools } from '../src/mcp-server/tools/editor-tools';
import { registerSchAnalysisTools } from '../src/mcp-server/tools/sch-analysis-tools';
import { registerPlacementTools } from '../src/mcp-server/tools/placement-tools';
import { registerBoardContextTools } from '../src/mcp-server/tools/board-context-tools';
import { registerBomTools } from '../src/mcp-server/tools/bom-tools';
import { registerSourcingTools } from '../src/mcp-server/tools/sourcing-tools';
import { registerDatasheetTools } from '../src/mcp-server/tools/datasheet-tools';
import { registerBundleTools } from '../src/mcp-server/tools/bundle-tools';
import { registerEmcTools } from '../src/mcp-server/tools/emc-tools';
import { registerThermalTools } from '../src/mcp-server/tools/thermal-tools';
import { registerPcbExtractTools } from '../src/mcp-server/tools/pcb-extract-tools';
import { registerCrossTools } from '../src/mcp-server/tools/cross-tools';
import { registerPcbEmcTools } from '../src/mcp-server/tools/pcb-emc-tools';
import { registerSpiceTools } from '../src/mcp-server/tools/spice-tools';
import { registerFabReleaseTools } from '../src/mcp-server/tools/fab-release-tools';
import { registerDocgenTools } from '../src/mcp-server/tools/docgen-tools';
import { registerImpedanceTools } from '../src/mcp-server/tools/impedance-tools';
import { registerRouteCleanupTools } from '../src/mcp-server/tools/route-cleanup-tools';
import { registerNativeProjectTools } from '../src/mcp-server/tools/native-project-tools';
import { registerFunctionalTools } from '../src/mcp-server/tools/functional-tools';
import { registerNativeEditorTools } from '../src/mcp-server/tools/native-editor-tools';
import { registerSplitPourTools } from '../src/mcp-server/tools/split-pour-tools';
import { registerRoutePairTools } from '../src/mcp-server/tools/route-pair-tools';

const bridge: any = new Proxy({}, { get: () => async () => ({}) });
const registrar = catalog as unknown as McpServer;

const registrars = [
	registerReadTools, registerWriteTools, registerAnalysisTools, registerSchReadTools,
	registerSchWriteTools, registerLibTools, registerManufactureTools, registerPcbDrcTools,
	registerPourFillTools, registerPcbLayerTools, registerEditorTools, registerSchAnalysisTools,
	registerPlacementTools, registerBoardContextTools, registerBomTools, registerSourcingTools,
	registerDatasheetTools, registerBundleTools, registerEmcTools, registerThermalTools,
	registerPcbExtractTools, registerCrossTools, registerPcbEmcTools, registerSpiceTools,
	registerFabReleaseTools, registerDocgenTools, registerImpedanceTools, registerRouteCleanupTools,
	registerFunctionalTools, registerNativeProjectTools, registerNativeEditorTools,
	registerSplitPourTools, registerRoutePairTools,
];
for (const register of registrars) register(registrar, bridge);

async function main(): Promise<void> {
	// Drive the real describe_tools handler by capturing it off a fake server.
	let describeHandler: ((args: any) => Promise<any>) | undefined;
	const fakeServer = {
		tool(name: string, _brief: string, _schema: any, handler: any) {
			if (name === 'describe_tools') describeHandler = handler;
		},
	} as unknown as McpServer;
	catalog.attachDynamic(fakeServer);
	if (!describeHandler) throw new Error('describe_tools was not registered');

	const names = catalog.all().map((t) => t.name);
	const response = await describeHandler({ names, format: 'json' });
	const described: Array<Record<string, any>> = JSON.parse(response.content[0].text);
	const compactResponse = await describeHandler({ names });
	const compact: Array<Record<string, any>> = JSON.parse(compactResponse.content[0].text);

	const failures: string[] = [];
	for (const entry of described) {
		if (entry.schemaError) failures.push(`${entry.name}: degraded to stub — ${entry.schemaError}`);
		if (entry.error) failures.push(`${entry.name}: ${entry.error}`);
		const params = entry.parameters ?? {};
		for (const [key, spec] of Object.entries<any>(params)) {
			if (spec?.type === 'unknown') failures.push(`${entry.name}.${key}: type resolved to "unknown"`);
			if (spec?.type === 'array' && (!spec.items || spec.items.type === 'unknown')) {
				failures.push(`${entry.name}.${key}: array items unresolved`);
			}
		}
	}

	for (const entry of compact) {
		if (typeof entry.args !== 'string') failures.push(`${entry.name}: compact signature missing`);
		else if (/\bunknown\b/.test(entry.args)) failures.push(`${entry.name}: compact signature has unknown type`);
	}
	const jsonChars = response.content[0].text.length, compactChars = compactResponse.content[0].text.length;
	console.log(`describe size, all tools: json ${jsonChars} chars → compact ${compactChars} chars (${Math.round(100 - (100 * compactChars) / jsonChars)}% smaller)`);

	const fanout = described.find((d) => d.name === 'pcb_auto_fanout');
	if (!fanout) failures.push('pcb_auto_fanout was not described');
	else if (!fanout.parameters || Object.keys(fanout.parameters).length === 0) {
		failures.push('pcb_auto_fanout yielded an empty schema');
	}

	console.log(`described ${described.length}/${names.length} tools`);
	if (fanout) console.log('pcb_auto_fanout:', compact.find((d) => d.name === 'pcb_auto_fanout')?.args);
	if (failures.length > 0) {
		console.error(`FAIL (${failures.length}):`);
		for (const f of failures) console.error('  - ' + f);
		process.exit(1);
	}
	console.log('PASS — every registered tool described with a real schema');
}

main().catch((err) => {
	console.error('FAIL — describe_tools threw:', err);
	process.exit(1);
});
