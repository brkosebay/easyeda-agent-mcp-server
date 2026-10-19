import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';
import { trimDrcGroups } from './sch-read-tools';

const RULE_CONFIG_HANDLERS: Record<string, string> = {
	get_current_name: 'pcb.drc.getCurrentRuleConfigName',
	get_by_name: 'pcb.drc.getRuleConfigByName',
	get_all: 'pcb.drc.getAllRuleConfigs',
	save: 'pcb.drc.saveRuleConfig',
	rename: 'pcb.drc.renameRuleConfig',
	delete: 'pcb.drc.deleteRuleConfig',
	get_default_name: 'pcb.drc.getDefaultRuleConfigName',
	set_default: 'pcb.drc.setAsDefaultRuleConfig',
};

const NET_RULES_HANDLERS: Record<string, string> = {
	overwrite_net: 'pcb.drc.overwriteNetRules',
	get_net_by_net: 'pcb.drc.getNetByNetRules',
	overwrite_net_by_net: 'pcb.drc.overwriteNetByNetRules',
	get_region: 'pcb.drc.getRegionRules',
	overwrite_region: 'pcb.drc.overwriteRegionRules',
};

const NET_CLASS_HANDLERS: Record<string, string> = {
	get_all: 'pcb.drc.getAllNetClasses',
	create: 'pcb.drc.createNetClass',
	delete: 'pcb.drc.deleteNetClass',
	rename: 'pcb.drc.modifyNetClassName',
	add_net: 'pcb.drc.addNetToNetClass',
	remove_net: 'pcb.drc.removeNetFromNetClass',
};

const DIFF_PAIR_HANDLERS: Record<string, string> = {
	get_all: 'pcb.drc.getDiffPairs',
	create: 'pcb.drc.createDiffPair',
	delete: 'pcb.drc.deleteDiffPair',
	rename: 'pcb.drc.modifyDiffPairName',
};

const EQUAL_LENGTH_HANDLERS: Record<string, string> = {
	get_all: 'pcb.drc.getEqualLengthGroups',
	create: 'pcb.drc.createEqualLengthGroup',
	delete: 'pcb.drc.deleteEqualLengthGroup',
	rename: 'pcb.drc.modifyEqualLengthGroupName',
	add_net: 'pcb.drc.addNetToEqualLengthGroup',
	remove_net: 'pcb.drc.removeNetFromEqualLengthGroup',
};

const PAD_PAIR_HANDLERS: Record<string, string> = {
	create: 'pcb.drc.createPadPairGroup',
	delete: 'pcb.drc.deletePadPairGroup',
	rename: 'pcb.drc.modifyPadPairGroupName',
};

const boardOutlinePoursSchema = {
	pours: z.array(z.object({
		layer: z.union([z.string(), z.number()]).describe('Copper layer for this pour'),
		net: z.string().describe('Net name for this pour'),
		pourName: z.string().optional(),
		pourPriority: z.number().optional(),
		pourFillMethod: z.enum(['solid', '45grid', '90grid']).optional(),
		preserveSilos: z.boolean().optional(),
		lineWidth: z.number().optional(),
		primitiveLock: z.boolean().optional(),
	})).optional().describe('Layer/net pours to create. Omit for Inner1 GND, Inner2 +3.3V, Top GND, Bottom GND.'),
	replaceExisting: z.boolean().optional().default(false).describe('Delete existing pours with the same net+layer before creating new ones.'),
	pourFillMethod: z.enum(['solid', '45grid', '90grid']).optional(),
	preserveSilos: z.boolean().optional(),
	pourPriority: z.number().optional(),
	lineWidth: z.number().optional(),
	primitiveLock: z.boolean().optional(),
	toleranceMil: z.number().positive().optional().default(0.5).describe('Endpoint matching tolerance for BoardOutline segments.'),
	arcStepDegrees: z.number().positive().optional().default(10).describe('Arc approximation step; smaller is more exact but creates more vertices.'),
	timeoutMs: z.number().int().positive().optional().describe('Per-pour EasyEDA create deadline (default 60000).'),
};

export function registerPcbDrcTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_drc_summarize',
		'Run DRC and return the top-N violation groups. Each group: count, primitiveIds (the offending tracks/vias/pads/pours — the ids to move, delete or reroute), offenderIds (DRC error ids like "err397"; they name the violation, not copper), and sample violations with errorId, primitiveIds, componentRefs, pads ({component, pad}) and coordinates when EasyEDA exposes them. Use this before pcb_run_drc when you only need an overview; pcb_drc_violations_detailed for repair locations.',
		withDocumentParam({
			groupBy: z.enum(['category', 'net', 'component']).optional().default('category').describe('Group axis'),
			top: z.number().int().positive().optional().default(10).describe('Max groups returned'),
			includeSamples: z.boolean().optional().default(true).describe('Include sample violations per group'),
			maxIds: z.number().int().min(0).max(20).optional().default(5).describe('primitiveIds (and offenderIds) kept per group'),
			samplesPerGroup: z.number().int().min(0).max(3).optional().default(1),
		}),
		async ({ maxIds, samplesPerGroup, ...params }) => {
			const result: any = await bridge.send('pcb.drc.summarize', params);
			// The extension returns up to 20 IDs + 3 samples per group; agents in
			// a fix loop call this hundreds of times, so trim to what they act on.
			return { content: [{ type: 'text', text: JSON.stringify(trimDrcGroups(result, maxIds ?? 5, samplesPerGroup ?? 1)) }] };
		},
	);

	server.tool(
		'pcb_drc_violations_detailed',
		'Run PCB DRC and return repair-oriented leaf violations. Each violation has errorId (DRC error id, e.g. "err397"), primitiveIds (the offending primitives to act on), componentRefs and pads ({component, pad}); offenderIds is the raw mixed lookup list. When EasyEDA omits coordinates, resolves primitive IDs/pad labels against the live board so each violation can include a location, offenders, nets, and suggested fix category.',
		withDocumentParam({
			maxViolations: z.number().int().positive().optional().default(50).describe('Max leaf violations to return'),
			resolveLocations: z.boolean().optional().default(true).describe('Resolve missing coordinates from offender primitive IDs/suffixes'),
			includeRaw: z.boolean().optional().default(false).describe('Include raw normalized EasyEDA DRC leaf payloads'),
			pinConcurrency: z.number().int().positive().optional().default(4).describe('Bounded component-pin lookup concurrency while resolving pad locations'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.drc.violationsDetailed', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_board_pour',
		`Create a copper pour bounded by the board outline minus an inset. By default computes bbox from layer-11 (BoardOutline) Line+Arc primitives — pass an explicit \`bbox\` (mil) when auto-detection misfires (non-rectangular boards, arcs that bow outward, unit mismatches). For non-rectangular shapes, fall back to pcb_create_pour with an explicit polygon.

Races EasyEDA's pour-create against a deadline (default 60s) so a misconfigured pour can't lock the editor.`,
		withDocumentParam({
			net: z.string().describe('Net name (typically GND or a power rail)'),
			layer: z.union([z.string(), z.number()]).describe('Copper layer (Top/Bottom/Inner1..30)'),
			inset_mil: z.number().optional().default(20).describe('Margin from board edge (mil); default 20'),
			bbox: z.object({
				minX: z.number(),
				minY: z.number(),
				maxX: z.number(),
				maxY: z.number(),
			}).optional().describe('Explicit board outline bbox (mil). Skips auto-detection — use when arcs bow outward of their endpoints or the outline-layer scan returns a misleading rectangle.'),
			pourFillMethod: z.enum(['solid', '45grid', '90grid']).optional(),
			pourName: z.string().optional(),
			pourPriority: z.number().optional(),
			lineWidth: z.number().optional(),
			preserveSilos: z.boolean().optional(),
			timeoutMs: z.number().int().positive().optional().describe('Deadline for EasyEDA fill engine (default 60000)'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.create.boardPour', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_board_outline_pours',
		`Create one or more copper pours from the actual BoardOutline loop, matching EasyEDA's manual "Use Board Outline" copper-area workflow. This follows layer-11 Line/Arc geometry instead of using a rectangular bbox, then creates a pour for each {layer, net} pair.

If pours is omitted, uses the common 4-layer plan: Inner1=GND, Inner2=+3.3V, TopLayer=GND, BottomLayer=GND. After creation, call pcb_rebuild_all_pours for the Shift+B equivalent.`,
		withDocumentParam(boardOutlinePoursSchema),
		async (params) => {
			const result = await bridge.send('pcb.create.boardOutlinePours', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_create_pour_from_outline',
		`Alias for pcb_create_board_outline_pours, named for agent discoverability. Creates exact board-outline copper pours from layer-11 Line/Arc/Polyline geometry. Omit pours for the standard 4-layer plan: Inner1=GND, Inner2=+3.3V, Top=GND, Bottom=GND.`,
		withDocumentParam(boardOutlinePoursSchema),
		async (params) => {
			const result = await bridge.send('pcb.create.boardOutlinePours', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	const repourSchema = {
		net: z.string().optional().describe('Only repour this net'),
		layer: z.union([z.string(), z.number()]).optional().describe('Only repour pours on this layer'),
		pourIds: z.array(z.string()).optional().describe('Only these pour primitive ids (use for a one-pour smoke test)'),
		perPourTimeoutMs: z.number().int().positive().optional().describe('Per-pour verification budget in ms (default 45000)'),
		totalTimeoutMs: z.number().int().positive().optional().describe('Overall budget in ms (default: 100000, or _timeoutMs-8s; background default 300000). A synchronous call is always capped below the bridge deadline.'),
		onTimeout: z.enum(['continue', 'skip', 'abort']).optional().describe("On an UNCONFIRMED pour (EasyEDA answering, no change seen): 'continue' (default; 'skip' is an alias) or 'abort'. When EasyEDA stops answering the loop always stops."),
		background: z.boolean().optional().describe('Return immediately with a jobId and rebuild in the background; poll pcb_repour_status. Releases the bridge queue at once.'),
		strategy: z.enum(['native', 'rebuild', 'modify']).optional().describe("'native' (default) = EasyEDA's own copper engine, exactly what Shift+B runs. 'rebuild'/'modify' = public-SDK paths that do not fill copper on EasyEDA Pro 2.2.47 (diagnosis only)."),
	};
	const repourDescription = `Rebuild copper pours with EasyEDA's own copper engine — the same events Shift+B (Rebuild All Copper Area) fires, delivered to the PCB tab through the editor's message bridge. No pourIds/net/layer = all pours + plane zones; otherwise only the matching pours. Locked pours are skipped. The result is one undoable "rebuild copper" step; the tab is marked unsaved (save separately).

Results are read back from the editor's copper store, not assumed: per pour status rebuilt (new copper islands) | up-to-date (engine kept identical copper) | empty (rebuild ran but the pour has NO copper — check outline/net/clearance) | unverified | unconfirmed | failed | skipped-locked, with copper.islands and an approximate bbox. Job status is "completed" only when every targeted pour has copper. background:true returns a jobId at once; poll pcb_repour_status. Use pcb_copper_status to read the board's copper without rebuilding.`;

	server.tool(
		'pcb_repour_all',
		repourDescription,
		withDocumentParam(repourSchema),
		async (params) => {
			const result = await bridge.send('pcb.pour.repourAll', params);
			return { content: [{ type: 'text', text: JSON.stringify(honestRepour(result)) }] };
		},
	);

	server.tool(
		'pcb_rebuild_all_pours',
		`Alias for pcb_repour_all (same arguments and result). ${repourDescription}`,
		withDocumentParam(repourSchema),
		async (params) => {
			const result = await bridge.send('pcb.pour.repourAll', params);
			return { content: [{ type: 'text', text: JSON.stringify(honestRepour(result)) }] };
		},
	);

	server.tool(
		'pcb_copper_status',
		'What copper each pour ACTUALLY has right now, read from the editor\'s own copper store (the public SDK cannot see poured copper on this EasyEDA build): per pour hasCopper, islands, style, approximate bbox, priority, lock; summary + emptyPours. Read-only; does not rebuild. Copper reflects the last rebuild — edits made since are only reflected after pcb_repour_all.',
		withDocumentParam({
			net: z.string().optional(),
			layer: z.union([z.string(), z.number()]).optional(),
			maxFillIds: z.number().int().min(0).max(200).optional().describe('Include up to N copper island ids per pour (default 0)'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.copper.status', { ...params, _timeoutMs: params._timeoutMs ?? 30_000 });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_repour_status',
		'Status of the current or last pcb_repour_all job (jobId optional → last job). Answers from the extension\'s in-memory job record without touching the operation queue, so it works while EasyEDA is busy or wedged. probe:true adds a 3 s EasyEDA liveness probe (responsive true/false). Also lists rebuild promises EasyEDA has not settled yet.',
		{
			jobId: z.string().optional().describe('Job id returned by pcb_repour_all (default: last job)'),
			probe: z.boolean().optional().describe('Also run a time-bounded SDK liveness probe'),
			instance_id: z.string().optional(),
		},
		async (params) => {
			const result = await bridge.send('pcb.pour.jobStatus', { ...params, _timeoutMs: 15_000 });
			return { content: [{ type: 'text', text: JSON.stringify(honestRepour(result)) }] };
		},
	);


	server.tool(
		'pcb_connectivity_status',
		'Per-net connectivity from the real copper graph (pad shapes, tracks, arcs, vias): connected (every pad joined by tracks/vias) | incomplete (copper exists but padGroups are not joined; floatingCopper = stubs touching no pad) | pour_dependent (joined only if pour copper links them — confirm with pcb_copper_status/DRC) | unrouted | single_pad. Problems first.',
		withDocumentParam({
			nets: z.array(z.string()).optional().describe('Limit audit to these nets (default: all nets)'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.net.connectivityStatus', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_manage_rule_config',
		`Manage DRC rule configurations. Actions:
- get_current_name: get current active config name
- get_by_name: get config by name (configurationName)
- get_all: get all configs (includeSystem optional)
- save: save config (ruleConfiguration, configurationName; allowOverwrite optional)
- rename: rename config (originalName, newName)
- delete: delete config (configurationName)
- get_default_name: get default config name
- set_default: set as default (configurationName)`,
		withDocumentParam({
			action: z
				.enum([
					'get_current_name', 'get_by_name', 'get_all', 'save',
					'rename', 'delete', 'get_default_name', 'set_default',
				])
				.describe('Action to perform'),
			configurationName: z.string().optional().describe('Config name'),
			ruleConfiguration: z.record(z.string(), z.any()).optional().describe('Rule config object (for save)'),
			allowOverwrite: z.boolean().optional().describe('Allow overwrite (for save)'),
			includeSystem: z.boolean().optional().describe('Include system configs (for get_all)'),
			originalName: z.string().optional().describe('Current name (for rename)'),
			newName: z.string().optional().describe('New name (for rename)'),
		}),
		async ({ action, ...rest }) => {
			const result = await bridge.send(RULE_CONFIG_HANDLERS[action], rest);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_manage_net_rules',
		`Manage net-specific design rules. Actions:
- overwrite_net: overwrite net rules (netRules: array of net rule objects)
- get_net_by_net: get net-by-net clearance rules
- overwrite_net_by_net: overwrite net-by-net rules (netByNetRules: object)
- get_region: get region-specific rules
- overwrite_region: overwrite region rules (regionRules: array of region rule objects)`,
		withDocumentParam({
			action: z
				.enum(['overwrite_net', 'get_net_by_net', 'overwrite_net_by_net', 'get_region', 'overwrite_region'])
				.describe('Action to perform'),
			netRules: z.array(z.record(z.string(), z.any())).optional().describe('Net rules array (for overwrite_net)'),
			netByNetRules: z.record(z.string(), z.any()).optional().describe('Net-by-net rules (for overwrite_net_by_net)'),
			regionRules: z.array(z.record(z.string(), z.any())).optional().describe('Region rules array (for overwrite_region)'),
		}),
		async ({ action, ...rest }) => {
			const result = await bridge.send(NET_RULES_HANDLERS[action], rest);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_manage_net_classes',
		`Manage net classes. Actions:
- get_all: get all net class definitions
- create: create net class (netClassName, nets: string[]; color optional)
- delete: delete net class (netClassName)
- rename: rename net class (originalName, newName)
- add_net: add net(s) to class (netClassName, net: string|string[])
- remove_net: remove net(s) from class (netClassName, net: string|string[])`,
		withDocumentParam({
			action: z
				.enum(['get_all', 'create', 'delete', 'rename', 'add_net', 'remove_net'])
				.describe('Action to perform'),
			netClassName: z.string().optional().describe('Net class name'),
			nets: z.array(z.string()).optional().describe('Net names array (for create)'),
			net: z.union([z.string(), z.array(z.string())]).optional().describe('Net name(s) (for add_net, remove_net)'),
			color: z.record(z.string(), z.any()).optional().describe('Color config (for create)'),
			originalName: z.string().optional().describe('Current name (for rename)'),
			newName: z.string().optional().describe('New name (for rename)'),
		}),
		async ({ action, ...rest }) => {
			const result = await bridge.send(NET_CLASS_HANDLERS[action], rest);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_manage_diff_pairs',
		`Manage differential pair definitions. Actions:
- get_all: get all differential pairs
- create: create diff pair (name, positiveNet, negativeNet)
- delete: delete diff pair (name)
- rename: rename diff pair (originalName, newName)
- modify_nets: modify positive/negative net (name, positiveNet and/or negativeNet)`,
		withDocumentParam({
			action: z
				.enum(['get_all', 'create', 'delete', 'rename', 'modify_nets'])
				.describe('Action to perform'),
			name: z.string().optional().describe('Differential pair name'),
			positiveNet: z.string().optional().describe('Positive signal net'),
			negativeNet: z.string().optional().describe('Negative signal net'),
			originalName: z.string().optional().describe('Current name (for rename)'),
			newName: z.string().optional().describe('New name (for rename)'),
		}),
		async ({ action, name, positiveNet, negativeNet, ...rest }) => {
			if (action === 'modify_nets') {
				const results: Record<string, unknown> = {};
				if (positiveNet !== undefined) {
					results.positive = await bridge.send('pcb.drc.modifyDiffPairPositiveNet', { name, positiveNet, ...rest });
				}
				if (negativeNet !== undefined) {
					results.negative = await bridge.send('pcb.drc.modifyDiffPairNegativeNet', { name, negativeNet, ...rest });
				}
				return { content: [{ type: 'text', text: JSON.stringify(results) }] };
			}
			const result = await bridge.send(DIFF_PAIR_HANDLERS[action], { name, positiveNet, negativeNet, ...rest });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_manage_equal_length_groups',
		`Manage equal-length net groups. Actions:
- get_all: get all equal-length groups
- create: create group (name, nets: string[]; color optional)
- delete: delete group (name)
- rename: rename group (originalName, newName)
- add_net: add net(s) to group (name, net: string|string[])
- remove_net: remove net(s) from group (name, net: string|string[])`,
		withDocumentParam({
			action: z
				.enum(['get_all', 'create', 'delete', 'rename', 'add_net', 'remove_net'])
				.describe('Action to perform'),
			name: z.string().optional().describe('Group name'),
			nets: z.array(z.string()).optional().describe('Net names array (for create)'),
			net: z.union([z.string(), z.array(z.string())]).optional().describe('Net name(s) (for add_net, remove_net)'),
			color: z.record(z.string(), z.any()).optional().describe('Color config (for create)'),
			originalName: z.string().optional().describe('Current name (for rename)'),
			newName: z.string().optional().describe('New name (for rename)'),
		}),
		async ({ action, ...rest }) => {
			const result = await bridge.send(EQUAL_LENGTH_HANDLERS[action], rest);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_setup_routing_rules',
		`Preflight that wires up net classes, per-net track widths, and differential pairs in one call — run this BEFORE pcb_autoroute / DSN export so FreeRouting (or any DRC step) sees the right constraints.

Each entry in classes is:
  { name, nets: [...], trackWidth?, color? }
trackWidth (mil) drives a per-net rule entry (overwriteNetRules) so power rails get fat tracks even if the global default is 10 mil. Use widths like 30-40 mil for +12V/+5V planes, 12-15 mil for filtered rails, default 10 mil for signals.

diffPairs is an array of { name, positiveNet, negativeNet } — created via pcb.drc.createDiffPair. Required for USB/CAN/LVDS routing constraints.

Existing classes/diff-pairs with the same name are left as-is unless replaceExisting is true. Returns per-step results (created, skipped, failed) so you can see exactly what was applied.`,
		withDocumentParam({
			classes: z.array(z.object({
				name: z.string().describe('Net class name (e.g. "Power", "Signal", "USB")'),
				nets: z.array(z.string()).describe('Net names assigned to this class'),
				trackWidth: z.number().positive().optional().describe('Per-net track width in mil (applied as net rule)'),
				color: z.record(z.string(), z.any()).optional().describe('Optional EasyEDA color descriptor'),
			})).optional().default([]).describe('Net classes to create'),
			diffPairs: z.array(z.object({
				name: z.string(),
				positiveNet: z.string(),
				negativeNet: z.string(),
			})).optional().default([]).describe('Differential pairs to declare'),
			replaceExisting: z.boolean().optional().default(false).describe('Delete and recreate classes/pairs that already exist (default false → skip)'),
		}),
		async ({ classes, diffPairs, replaceExisting, ...rest }) => {
			const classResults: Array<Record<string, any>> = [];
			const diffPairResults: Array<Record<string, any>> = [];
			const netRuleAssignments: Array<{ net: string; trackWidth: number; class: string }> = [];

			let existingClasses: any[] = [];
			try { existingClasses = await bridge.send('pcb.drc.getAllNetClasses', rest) as any[] || []; }
			catch {/* listing is optional */ }
			const existingClassNames = new Set(
				(existingClasses || [])
					.map((c) => String(c?.netClassName ?? c?.name ?? ''))
					.filter(Boolean),
			);

			for (const cls of (classes ?? [])) {
				const exists = existingClassNames.has(cls.name);
				if (exists && !replaceExisting) {
					classResults.push({ name: cls.name, action: 'skipped', reason: 'already exists' });
				} else {
					if (exists && replaceExisting) {
						try { await bridge.send('pcb.drc.deleteNetClass', { ...rest, netClassName: cls.name }); }
						catch (err: any) { /* delete is best-effort */ void err; }
					}
					try {
						await bridge.send('pcb.drc.createNetClass', {
							...rest,
							netClassName: cls.name,
							nets: cls.nets,
							color: cls.color,
						});
						classResults.push({ name: cls.name, action: 'created', nets: cls.nets.length });
					} catch (err: any) {
						classResults.push({ name: cls.name, action: 'failed', error: String(err?.message || err) });
						continue;
					}
				}
				if (typeof cls.trackWidth === 'number' && cls.trackWidth > 0) {
					for (const net of cls.nets) {
						netRuleAssignments.push({ net, trackWidth: cls.trackWidth, class: cls.name });
					}
				}
			}

			let netRulesApplied = 0;
			let netRulesError: string | undefined;
			if (netRuleAssignments.length > 0) {
				const netRules = netRuleAssignments.map((a) => ({
					net: a.net,
					trackWidth: a.trackWidth,
				}));
				try {
					await bridge.send('pcb.drc.overwriteNetRules', { ...rest, netRules });
					netRulesApplied = netRules.length;
				} catch (err: any) {
					netRulesError = String(err?.message || err);
				}
			}

			let existingDiffs: any[] = [];
			try { existingDiffs = await bridge.send('pcb.drc.getDiffPairs', rest) as any[] || []; }
			catch {/* */ }
			const existingDiffNames = new Set(
				(existingDiffs || [])
					.map((d) => String(d?.name ?? ''))
					.filter(Boolean),
			);

			for (const dp of (diffPairs ?? [])) {
				const exists = existingDiffNames.has(dp.name);
				if (exists && !replaceExisting) {
					diffPairResults.push({ name: dp.name, action: 'skipped', reason: 'already exists' });
					continue;
				}
				if (exists && replaceExisting) {
					try { await bridge.send('pcb.drc.deleteDiffPair', { ...rest, name: dp.name }); }
					catch (err: any) { void err; }
				}
				try {
					await bridge.send('pcb.drc.createDiffPair', {
						...rest,
						name: dp.name,
						positiveNet: dp.positiveNet,
						negativeNet: dp.negativeNet,
					});
					diffPairResults.push({ name: dp.name, action: 'created' });
				} catch (err: any) {
					diffPairResults.push({ name: dp.name, action: 'failed', error: String(err?.message || err) });
				}
			}

			return { content: [{ type: 'text', text: JSON.stringify({
				classes: classResults,
				diffPairs: diffPairResults,
				netRulesApplied,
				netRulesError,
				netRuleAssignments,
			}) }] };
		},
	);

	server.tool(
		'pcb_manage_pad_pair_groups',
		`Manage pad pair groups for length-matching. Actions:
- create: create group (name, padPairs: [[padId1, padId2], ...])
- delete: delete group (name)
- rename: rename group (originalName, newName)`,
		withDocumentParam({
			action: z
				.enum(['create', 'delete', 'rename'])
				.describe('Action to perform'),
			name: z.string().optional().describe('Pad pair group name'),
			padPairs: z
				.array(z.tuple([z.string(), z.string()]))
				.optional()
				.describe('Pad pair tuples (for create)'),
			originalName: z.string().optional().describe('Current name (for rename)'),
			newName: z.string().optional().describe('New name (for rename)'),
		}),
		async ({ action, ...rest }) => {
			const result = await bridge.send(PAD_PAIR_HANDLERS[action], rest);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}

/**
 * Extensions built before 2026-10-05 count a resolved modify() promise as a
 * rebuilt pour. That promise only proves the property edit was accepted: a
 * live check found NO poured copper on a board whose modify repours all
 * reported "completed". Re-label those results until the extension is
 * reinstalled (newer builds already report "unverified" themselves).
 */
function honestRepour(result: any): any {
	if (!result || result.strategy !== 'modify' || !Array.isArray(result.results)) return result;
	let downgraded = 0;
	const results = result.results.map((p: any) => {
		if (p?.status !== 'rebuilt' || p.confirmedBy !== 'promise') return p;
		downgraded++;
		const { confirmedBy, ...rest } = p;
		return { ...rest, status: 'unverified', error: 'pour edit accepted; refill not observed (a resolved modify() is not evidence of new copper)' };
	});
	if (!downgraded) return result;
	return {
		...result,
		status: result.status === 'completed' ? 'partial' : result.status,
		rebuilt: Math.max(0, (result.rebuilt ?? 0) - downgraded),
		unverified: (result.unverified ?? 0) + downgraded,
		confirmedBy: result.confirmedBy ? { ...result.confirmedBy, promise: Math.max(0, (result.confirmedBy.promise ?? 0) - downgraded) } : result.confirmedBy,
		results,
		notes: [
			...(Array.isArray(result.notes) ? result.notes : []),
			'unverified = EasyEDA accepted the pour edit but the refill cannot be observed on this build. Do not assume copper exists: check pcb_drc_summarize (GND "disconnected" errors drop when pours really fill) or look at the board; Shift+B in EasyEDA rebuilds all copper.',
		],
	};
}
