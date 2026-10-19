import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';
import { analyzePlacement, extractPlacementClusters, optimizePlacement, planClusterPlacement, scorePlacement, type PlacementSnapshot } from '../analyzers/placement-review';

const componentTargetSchema = {
	primitiveId: z.string().optional().describe('Component primitiveId. Prefer this when known.'),
	reference: z.string().optional().describe('Component designator/reference, e.g. "U3", "J1".'),
	designator: z.string().optional().describe('Alias for reference.'),
} as const;

const candidateRotationsSchema = z.array(z.number()).optional().describe('Absolute rotations to test in degrees. Default: [0,90,180,270] plus current rotation.');

const placementAnalysisOptions = {
	candidateRotations: candidateRotationsSchema,
	neighborRadiusMil: z.number().positive().optional().default(2500).describe('Suggest tool: scan other components within this radius around the target.'),
	maxContextComponents: z.number().int().positive().optional().default(120).describe('Suggest tool: cap nearby context components whose pins are fetched.'),
	clearanceMil: z.number().nonnegative().optional().default(20).describe('Approximate clearance used for bounding-box collision warnings.'),
	bodyPaddingMil: z.number().nonnegative().optional().default(40).describe('Extra padding around each pin bbox to approximate the component body.'),
	targetPairLimit: z.number().int().nonnegative().optional().default(20).describe('Max nearest-pad target pairs to return for explanation.'),
} as const;

const autoRipFields = {
	autoRipConnectedTracks: z.boolean().optional().default(false).describe('After a successful move/rotation, delete same-net Line endpoints and vias directly attached to the component old pad centers so stale copper is re-queued for routing.'),
	autoRipToleranceMil: z.number().positive().optional().default(25).describe('Pad-center attachment tolerance for auto-rip matching.'),
	maxAutoRipPrimitives: z.number().int().positive().optional().default(100).describe('Safety cap for auto-rip matched Line/Via primitives. Dry-run first on dense boards.'),
	autoRipPreserveLocked: z.boolean().optional().default(true).describe('Skip locked attached Line/Via primitives while auto-ripping.'),
	autoRipAllowOverLimit: z.boolean().optional().default(false).describe('Allow applying auto-rip when matched primitives exceed maxAutoRipPrimitives. Prefer dryRun inspection first.'),
} as const;

export function registerPlacementTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_get_footprint_map',
		`Return a component footprint map: every pad's absolute position, local offset from the component origin, net, layer, side/quadrant, and net/side summaries. Use before routing so the agent can see which side each net exits.`,
		withDocumentParam({
			...componentTargetSchema,
			candidateRotations: candidateRotationsSchema,
			includeCandidatePins: z.boolean().optional().default(false).describe('Include full simulated pin positions for each candidate rotation. Default false for compact output.'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.footprint.map', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_suggest_component_rotation',
		`Score 0/90/180/270 component rotations using approximate same-net ratline length, straight-line crossings, pad-facing direction, and bounding-box collision risk. Use before hand routing dense ICs/connectors.`,
		withDocumentParam({
			...componentTargetSchema,
			...placementAnalysisOptions,
			scanAll: z.boolean().optional().default(false).describe('Ignore neighborRadiusMil and scan all components, still capped by maxContextComponents.'),
			crossingPenaltyMil: z.number().nonnegative().optional().default(250),
			facingAwayPenaltyMil: z.number().nonnegative().optional().default(120),
			collisionPenaltyMil: z.number().nonnegative().optional().default(5000),
		}),
		async (params) => {
			const result = await bridge.send('pcb.placement.suggestRotation', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_review_component_orientations',
		`Scan the board for components that would likely route more cleanly if rotated. Returns the top recommendations with current/recommended scores; apply one at a time and rerun checks.`,
		withDocumentParam({
			...placementAnalysisOptions,
			limit: z.number().int().positive().optional().default(10).describe('Max recommendations to return.'),
			maxComponents: z.number().int().positive().optional().default(200).describe('Max placed components to inspect. Increase on large boards if needed.'),
			pinConcurrency: z.number().int().positive().optional().default(4).describe('Bounded concurrency for pin fetching. Keep small if EasyEDA is busy.'),
			minImprovementPercent: z.number().nonnegative().optional().default(8).describe('Hide recommendations below this percent score improvement unless includeStable is true.'),
			minScoreImprovementMil: z.number().nonnegative().optional().default(75).describe('Hide recommendations below this absolute score improvement unless includeStable is true.'),
			references: z.array(z.string()).optional().describe('Optional candidate designator filter, e.g. ["U1","J2"]. Context components are still used as targets/obstacles.'),
			skipMechanical: z.boolean().optional().default(true).describe('Skip mechanical/fiducial/testpoint designators as recommendation candidates.'),
			respectLocked: z.boolean().optional().default(true).describe('Skip locked components as recommendation candidates.'),
			includeStable: z.boolean().optional().default(false).describe('Also return components where current rotation is best or the gain is below threshold.'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.placement.reviewOrientations', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_apply_component_rotation',
		'Rotate a PCB component by primitiveId or designator. Supports dryRun, locked-component guard, and optional autoRipConnectedTracks to remove stale attached route copper at old pads. Does not reshape connected pours.',
		withDocumentParam({
			...componentTargetSchema,
			rotation: z.number().optional().describe('Absolute target rotation in degrees.'),
			targetRotation: z.number().optional().describe('Alias for rotation.'),
			recommendedRotation: z.number().optional().describe('Alias for rotation, useful with pcb_suggest_component_rotation output.'),
			deltaRotation: z.number().optional().describe('Relative rotation to add to the current rotation.'),
			rotateBy: z.number().optional().describe('Alias for deltaRotation.'),
			x: z.number().optional().describe('Optional new component origin x in mil. Omit to preserve current origin.'),
			y: z.number().optional().describe('Optional new component origin y in mil. Omit to preserve current origin.'),
			primitiveLock: z.boolean().optional().describe('Optional new lock state after rotation.'),
			respectLocked: z.boolean().optional().default(true).describe('Throw if the component is locked. Pass false only intentionally.'),
			dryRun: z.boolean().optional().default(false).describe('Return planned property without modifying the board.'),
			...autoRipFields,
		}),
		async (params) => {
			const result = await bridge.send('pcb.placement.applyRotation', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_check_placement',
		`Check component placement for physical/layout defects: courtyard overlap, tight component-to-component clearance, decoupling caps placed too far from their IC power pins (with a suggested move toward the pin), and connectors/USB connectors that are not on the board edge. Loads a placement snapshot (component positions, rotations, pad extents in mil, board outline) and runs the placement-review rule engine MCP-side. Read-only — emits PLC-001..PLC-004 findings + suggested moves. Apply moves with pcb_set_component_position, then repour and rerun DRC. (For board-level small-move opportunities see pcb_review_placement.)`,
		withDocumentParam({
			...placementAnalysisOptions,
			decouplingMaxMil: z.number().positive().optional().default(150).describe('Max distance (mil) from a decoupling cap to its IC power pad before PLC-003 fires.'),
			edgeMarginMil: z.number().positive().optional().default(250).describe('How close a connector courtyard center must be to the board edge (mil) before PLC-004 fires.'),
			maxComponents: z.number().int().positive().optional().default(500).describe('Max components to load into the placement snapshot.'),
			pinConcurrency: z.number().int().positive().optional().default(4).describe('Bounded concurrency for pin fetching. Keep small if EasyEDA is busy.'),
			timeoutMs: z.number().int().positive().optional().describe('Optional bridge timeout override in milliseconds.'),
		}),
		async ({ bodyPaddingMil, clearanceMil, decouplingMaxMil, edgeMarginMil, timeoutMs, ...rest }) => {
			const payload: Record<string, unknown> = { ...rest };
			const override = Number(timeoutMs);
			payload._timeoutMs = Number.isFinite(override) && override > 0 ? override + 5000 : 180_000;
			const snapshot = (await bridge.send('pcb.placement.review', payload)) as PlacementSnapshot;
			const review = analyzePlacement(snapshot, {
				bodyPaddingMil: typeof bodyPaddingMil === 'number' ? bodyPaddingMil : undefined,
				clearanceMil: typeof clearanceMil === 'number' ? clearanceMil : undefined,
				decouplingMaxMil: typeof decouplingMaxMil === 'number' ? decouplingMaxMil : undefined,
				edgeMarginMil: typeof edgeMarginMil === 'number' ? edgeMarginMil : undefined,
			});
			const bySeverity = { critical: 0, warning: 0, info: 0 } as Record<'critical' | 'warning' | 'info', number>;
			for (const f of review.findings) bySeverity[f.severity] += 1;
			const result = {
				units: 'mil',
				componentCount: review.courtyardCount,
				outlineSource: review.outlineSource,
				bySeverity,
				findings: review.findings,
				suggestions: review.suggestions,
				summary: `${review.findings.length} placement findings: ${bySeverity.critical}C/${bySeverity.warning}W/${bySeverity.info}I. Courtyards are pad-extent approximations; verify against real footprint courtyards.`,
			};
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_score_placement',
		'R2 placement objective report: total HPWL, ratsnest crossing count, top nets by HPWL, and decoupling-distance table. Use before/after placement moves or optimization to measure whether the board became easier to route.',
		withDocumentParam({
			decouplingMaxMil: z.number().positive().optional().default(150).describe('Max cap-to-IC-power-pad distance considered acceptable.'),
			includeSinglePadNets: z.boolean().optional().default(false).describe('Include single-pad/single-component nets in HPWL metrics. Usually false.'),
			maxRatsnestSegments: z.number().int().positive().optional().default(2000).describe('Safety cap for crossing-count ratsnest segments.'),
			maxComponents: z.number().int().positive().optional().default(500).describe('Max components to load into the placement snapshot.'),
			pinConcurrency: z.number().int().positive().optional().default(4).describe('Bounded concurrency for pin fetching. Keep small if EasyEDA is busy.'),
			timeoutMs: z.number().int().positive().optional().describe('Optional bridge timeout override in milliseconds.'),
		}),
		async ({ decouplingMaxMil, includeSinglePadNets, maxRatsnestSegments, timeoutMs, ...rest }) => {
			const payload: Record<string, unknown> = { ...rest };
			const override = Number(timeoutMs);
			payload._timeoutMs = Number.isFinite(override) && override > 0 ? override + 5000 : 180_000;
			const snapshot = (await bridge.send('pcb.placement.review', payload)) as PlacementSnapshot;
			const result = scorePlacement(snapshot, {
				decouplingMaxMil: typeof decouplingMaxMil === 'number' ? decouplingMaxMil : undefined,
				includeSinglePadNets: includeSinglePadNets === true,
				maxRatsnestSegments: typeof maxRatsnestSegments === 'number' ? maxRatsnestSegments : undefined,
			});
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_extract_placement_clusters',
		'R2 cluster extraction: derive IC/regulator clusters with decoupling caps, immediate passives, pin-proximity targets, cluster HPWL, and loose-component count. Use before pcb_place_cluster / global placement optimization.',
		withDocumentParam({
			includeLoosePassives: z.boolean().optional().default(true).describe('Include nearby R/C/L/FB/D parts that share a net with the IC anchor.'),
			maxClusters: z.number().int().positive().optional().default(100),
			maxMembersPerCluster: z.number().int().positive().optional().default(24),
			decouplingMaxMil: z.number().positive().optional().default(150),
			maxComponents: z.number().int().positive().optional().default(500).describe('Max components to load into the placement snapshot.'),
			pinConcurrency: z.number().int().positive().optional().default(4).describe('Bounded concurrency for pin fetching. Keep small if EasyEDA is busy.'),
			timeoutMs: z.number().int().positive().optional().describe('Optional bridge timeout override in milliseconds.'),
		}),
		async ({ includeLoosePassives, maxClusters, maxMembersPerCluster, decouplingMaxMil, timeoutMs, ...rest }) => {
			const payload: Record<string, unknown> = { ...rest };
			const override = Number(timeoutMs);
			payload._timeoutMs = Number.isFinite(override) && override > 0 ? override + 5000 : 180_000;
			const snapshot = (await bridge.send('pcb.placement.review', payload)) as PlacementSnapshot;
			const result = extractPlacementClusters(snapshot, {
				includeLoosePassives: includeLoosePassives !== false,
				maxClusters: typeof maxClusters === 'number' ? maxClusters : undefined,
				maxMembersPerCluster: typeof maxMembersPerCluster === 'number' ? maxMembersPerCluster : undefined,
				decouplingMaxMil: typeof decouplingMaxMil === 'number' ? decouplingMaxMil : undefined,
			});
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_place_cluster',
		'R2 cluster placer for one IC/regulator anchor. In propose mode, plans snapped moves for decoupling caps and immediate passives while skipping locked parts and approximate courtyard collisions. In apply mode, executes accepted component moves via pcb_set_component_position. Routes/pours are not reshaped.',
		withDocumentParam({
			...componentTargetSchema,
			anchor: z.string().optional().describe('Anchor component reference/designator or primitiveId. Alias for reference/primitiveId. If omitted, uses the highest-HPWL extracted cluster.'),
			mode: z.enum(['propose', 'apply']).optional().default('propose').describe('propose is read-only. apply executes accepted moves sequentially.'),
			includeDecouplingCaps: z.boolean().optional().default(true).describe('Move decoupling capacitors in the cluster.'),
			includeImmediatePassives: z.boolean().optional().default(true).describe('Move nearby shared-net R/C/L/FB/D passives in the cluster.'),
			targetDistanceMil: z.number().positive().optional().default(150).describe('Desired max pin-to-pin spacing for decoupling capacitors.'),
			immediatePassiveDistanceMil: z.number().positive().optional().describe('Desired max pin-to-pin spacing for immediate passives. Default: targetDistanceMil * 1.8.'),
			gridMil: z.number().positive().optional().default(25).describe('Snap proposed component origins to this placement grid in mil.'),
			maxMoves: z.number().int().positive().optional().default(12).describe('Max non-anchor cluster members to consider.'),
			respectLocked: z.boolean().optional().default(true).describe('Skip locked components. Pass false only intentionally.'),
			avoidCollisions: z.boolean().optional().default(true).describe('Skip moves whose approximate same-layer courtyards would overlap or violate clearance.'),
			clearanceMil: z.number().nonnegative().optional().default(20).describe('Approximate courtyard clearance threshold for candidate moves.'),
			bodyPaddingMil: z.number().nonnegative().optional().default(40).describe('Padding around pad extents to approximate component courtyards.'),
			decouplingMaxMil: z.number().positive().optional().describe('Decoupling threshold used for before/after scoring and cluster extraction. Defaults to targetDistanceMil.'),
			maxClusters: z.number().int().positive().optional().default(100),
			maxMembersPerCluster: z.number().int().positive().optional().default(24),
			maxRatsnestSegments: z.number().int().positive().optional().default(2000).describe('Safety cap for before/after crossing-count ratsnest segments.'),
			...autoRipFields,
			maxComponents: z.number().int().positive().optional().default(500).describe('Max components to load into the placement snapshot.'),
			pinConcurrency: z.number().int().positive().optional().default(4).describe('Bounded concurrency for pin fetching. Keep small if EasyEDA is busy.'),
			timeoutMs: z.number().int().positive().optional().describe('Optional bridge timeout override in milliseconds.'),
		}),
		async ({ mode, timeoutMs, ...rest }) => {
			const payload: Record<string, unknown> = { ...rest };
			const override = Number(timeoutMs);
			payload._timeoutMs = Number.isFinite(override) && override > 0 ? override + 5000 : 180_000;
			const snapshot = (await bridge.send('pcb.placement.review', payload)) as PlacementSnapshot;
			const plan = planClusterPlacement(snapshot, rest);
			if (mode !== 'apply') return { content: [{ type: 'text', text: JSON.stringify({ ...plan, applied: false }) }] };

			const acceptedMoves = plan.moves.filter((move) => move.status === 'planned');
			const applyResults: Array<Record<string, unknown>> = [];
			for (const move of acceptedMoves) {
				const movePayload: Record<string, unknown> = {
					document: rest.document,
					instance_id: rest.instance_id,
					primitiveId: move.primitiveId,
					x: move.to.x,
					y: move.to.y,
					respectLocked: rest.respectLocked !== false,
					dryRun: false,
					autoRipConnectedTracks: rest.autoRipConnectedTracks === true,
					autoRipToleranceMil: rest.autoRipToleranceMil,
					maxAutoRipPrimitives: rest.maxAutoRipPrimitives,
					autoRipPreserveLocked: rest.autoRipPreserveLocked !== false,
					autoRipAllowOverLimit: rest.autoRipAllowOverLimit === true,
				};
				if (Number.isFinite(override) && override > 0) movePayload._timeoutMs = override + 5000;
				try {
					const result = await bridge.send('pcb.placement.setPosition', movePayload);
					applyResults.push({
						primitiveId: move.primitiveId,
						designator: move.designator,
						applied: true,
						result,
					});
				} catch (err) {
					applyResults.push({
						primitiveId: move.primitiveId,
						designator: move.designator,
						applied: false,
						error: err instanceof Error ? err.message : String(err),
					});
					break;
				}
			}
			const appliedMoveCount = applyResults.filter((row) => row.applied === true).length;
			const result = {
				...plan,
				applied: appliedMoveCount === acceptedMoves.length,
				appliedMoveCount,
				applyResults,
				warning: 'Connected routes and pours are not reshaped. Reroute affected nets, rebuild pours, and rerun DRC/connectivity after moving placed parts.',
			};
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_optimize_placement',
		'R2 global placement optimizer first slice. In propose mode, runs MCP-side coordinate-descent over components, clusters, or mixed groups to reduce weighted HPWL/crossing/decoupling objective while respecting locks, grid snapping, board bounds, and approximate courtyard clearance. In apply mode, executes accepted component moves via pcb_set_component_position. Routes/pours are not reshaped.',
		withDocumentParam({
			mode: z.enum(['propose', 'apply']).optional().default('propose').describe('propose is read-only. apply executes accepted moves sequentially.'),
			groupMode: z.enum(['components', 'clusters', 'mixed']).optional().default('mixed').describe('Optimize individual components, extracted clusters, or clusters plus loose components.'),
			references: z.array(z.string()).optional().describe('Optional designator filter. A cluster is included if any member matches.'),
			primitiveIds: z.array(z.string()).optional().describe('Optional primitiveId filter. A cluster is included if any member matches.'),
			stepMil: z.number().positive().optional().default(100).describe('Initial coordinate-descent step size in mil. Later passes reduce the step.'),
			gridMil: z.number().positive().optional().default(25).describe('Snap proposed component/group centers to this placement grid in mil.'),
			passes: z.number().int().positive().optional().default(2).describe('Coordinate-descent passes.'),
			limit: z.number().int().positive().optional().default(12).describe('Max accepted optimization moves to return/apply.'),
			maxGroups: z.number().int().positive().optional().default(120).describe('Max candidate groups scanned after filtering/sorting.'),
			minImprovementMil: z.number().nonnegative().optional().default(25).describe('Minimum weighted objective improvement required to accept a move.'),
			respectLocked: z.boolean().optional().default(true).describe('Skip locked components/groups. Pass false only intentionally.'),
			skipConnectors: z.boolean().optional().default(true).describe('Do not move connectors in component mode unless false.'),
			skipMechanical: z.boolean().optional().default(true).describe('Do not move mounting holes/fiducials/testpoints/logos in component mode unless false.'),
			avoidCollisions: z.boolean().optional().default(true).describe('Skip moves whose approximate same-layer courtyards would overlap or violate clearance.'),
			avoidBoardEdge: z.boolean().optional().default(true).describe('Skip moves whose approximate courtyards would leave the board outline bbox.'),
			clearanceMil: z.number().nonnegative().optional().default(20).describe('Approximate courtyard clearance threshold for candidate moves.'),
			boardMarginMil: z.number().nonnegative().optional().default(0).describe('Optional inset from the board outline bbox.'),
			bodyPaddingMil: z.number().nonnegative().optional().default(40).describe('Padding around pad extents to approximate component courtyards.'),
			decouplingMaxMil: z.number().positive().optional().default(150).describe('Decoupling threshold used for scoring and cluster extraction.'),
			crossingPenaltyMil: z.number().nonnegative().optional().default(250).describe('Weighted objective penalty per ratsnest crossing.'),
			decouplingPenaltyMil: z.number().nonnegative().optional().default(1000).describe('Weighted objective penalty per decoupling distance issue.'),
			maxRatsnestSegments: z.number().int().positive().optional().default(2000).describe('Safety cap for crossing-count ratsnest segments.'),
			maxClusters: z.number().int().positive().optional().default(100),
			maxMembersPerCluster: z.number().int().positive().optional().default(24),
			...autoRipFields,
			maxComponents: z.number().int().positive().optional().default(500).describe('Max components to load into the placement snapshot.'),
			pinConcurrency: z.number().int().positive().optional().default(4).describe('Bounded concurrency for pin fetching. Keep small if EasyEDA is busy.'),
			timeoutMs: z.number().int().positive().optional().describe('Optional bridge timeout override in milliseconds.'),
		}),
		async ({ mode, timeoutMs, ...rest }) => {
			const payload: Record<string, unknown> = { ...rest };
			const override = Number(timeoutMs);
			payload._timeoutMs = Number.isFinite(override) && override > 0 ? override + 5000 : 180_000;
			const snapshot = (await bridge.send('pcb.placement.review', payload)) as PlacementSnapshot;
			const plan = optimizePlacement(snapshot, rest);
			if (mode !== 'apply') return { content: [{ type: 'text', text: JSON.stringify({ ...plan, applied: false }) }] };

			const applyResults: Array<Record<string, unknown>> = [];
			for (const move of plan.moves) {
				for (const componentMove of move.componentMoves) {
					const movePayload: Record<string, unknown> = {
						document: rest.document,
						instance_id: rest.instance_id,
						primitiveId: componentMove.primitiveId,
						x: componentMove.to.x,
						y: componentMove.to.y,
						respectLocked: rest.respectLocked !== false,
						dryRun: false,
						autoRipConnectedTracks: rest.autoRipConnectedTracks === true,
						autoRipToleranceMil: rest.autoRipToleranceMil,
						maxAutoRipPrimitives: rest.maxAutoRipPrimitives,
						autoRipPreserveLocked: rest.autoRipPreserveLocked !== false,
						autoRipAllowOverLimit: rest.autoRipAllowOverLimit === true,
					};
					if (Number.isFinite(override) && override > 0) movePayload._timeoutMs = override + 5000;
					try {
						const result = await bridge.send('pcb.placement.setPosition', movePayload);
						applyResults.push({
							moveId: move.id,
							primitiveId: componentMove.primitiveId,
							designator: componentMove.designator,
							applied: true,
							result,
						});
					} catch (err) {
						applyResults.push({
							moveId: move.id,
							primitiveId: componentMove.primitiveId,
							designator: componentMove.designator,
							applied: false,
							error: err instanceof Error ? err.message : String(err),
						});
						const appliedComponentCount = applyResults.filter((row) => row.applied === true).length;
						return {
							content: [{
								type: 'text',
								text: JSON.stringify({
									...plan,
									applied: false,
									appliedComponentCount,
									applyResults,
									warning: 'Placement optimization stopped after a component move failed. Connected routes and pours are not reshaped; reroute/rebuild/DRC before continuing.',
								}),
							}],
						};
					}
				}
			}
			const totalComponentMoves = plan.moves.reduce((sum, move) => sum + move.componentMoves.length, 0);
			const appliedComponentCount = applyResults.filter((row) => row.applied === true).length;
			const result = {
				...plan,
				applied: appliedComponentCount === totalComponentMoves,
				appliedComponentCount,
				applyResults,
				warning: 'Connected routes and pours are not reshaped. Reroute affected nets, rebuild pours, and rerun DRC/connectivity after moving placed parts.',
			};
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_set_component_position',
		'Move and/or rotate a PCB component by primitiveId or designator. Set absolute x/y (mil) and/or rotation, or use deltaRotation. Supports dryRun, a locked-component guard, and optional autoRipConnectedTracks to remove stale attached route copper at old pads. Does NOT reshape pours — re-route, repour, and rerun DRC afterward.',
		withDocumentParam({
			...componentTargetSchema,
			x: z.number().optional().describe('Absolute new component origin x in mil. Omit to preserve current x.'),
			y: z.number().optional().describe('Absolute new component origin y in mil. Omit to preserve current y.'),
			rotation: z.number().optional().describe('Absolute target rotation in degrees. Omit to preserve current rotation.'),
			deltaRotation: z.number().optional().describe('Relative rotation to add to the current rotation. Ignored if rotation is given.'),
			primitiveLock: z.boolean().optional().describe('Optional new lock state after the move.'),
			respectLocked: z.boolean().optional().default(true).describe('Throw if the component is locked. Pass false only intentionally.'),
			dryRun: z.boolean().optional().default(false).describe('Return planned property without modifying the board.'),
			...autoRipFields,
			timeoutMs: z.number().int().positive().optional().describe('Optional bridge timeout override in milliseconds.'),
		}),
		async ({ timeoutMs, ...rest }) => {
			const payload: Record<string, unknown> = { ...rest };
			const override = Number(timeoutMs);
			if (Number.isFinite(override) && override > 0) payload._timeoutMs = override + 5000;
			const result = await bridge.send('pcb.placement.setPosition', payload);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}
