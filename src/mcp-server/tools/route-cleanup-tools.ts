import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebSocketBridge } from '../bridge';
import { withDocumentParam } from './query-params';

const cleanupParams = {
	net: z.string().optional().describe('Net name whose tracks/arcs to clean. Required unless useSelection:true.'),
	useSelection: z.boolean().optional().describe('Clean the currently selected line/arc primitives instead of a whole net.'),
	snap45: z.boolean().optional().describe('Snap each leg direction to the nearest 45° multiple (endpoints stay pinned to pads/vias).'),
	miter90: z.boolean().optional().describe('Replace right-angle (90°) jogs with two 45° segments, sized by the shorter adjacent leg.'),
	fillet: z.boolean().optional().describe('Round right-angle corners with a quarter-arc fillet (preserves arcAngle sign) instead of a straight miter.'),
	minSegMil: z.number().positive().optional().describe('Minimum segment length in mil; shorter micro-segments are dropped (default ~2 mil).'),
	trimStubs: z.boolean().optional().describe('Remove short dangling stubs (free-ended micro tails).'),
	timeoutMs: z.number().int().positive().optional().describe('Deadline for the create/delete edits.'),
	obstacleCheckTimeoutMs: z.number().int().positive().optional().describe('Deadline for the obstacle preflight.'),
	clearanceMil: z.number().nonnegative().optional().describe('Extra clearance margin for the obstacle preflight (default 6).'),
	ignoreSameNet: z.boolean().optional().describe('Ignore same-net copper in the obstacle preflight (default true).'),
	ignorePrimitiveIds: z.array(z.string()).optional().describe('Extra obstacle IDs to ignore (the originals being replaced are ignored automatically).'),
} as const;

export function registerRouteCleanupTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'pcb_route_cleanup',
		`Clean up route geometry on a net (or the current selection): fix acute angles, miter right-angle jogs to 45 degrees, round corners with arc fillets, snap legs to the 45-degree grid, drop micro-segments and collinear-redundant vertices, and trim dangling stubs.

Chains the net's Line/Arc primitives into ordered polylines, geometry-preserving at the pad/via endpoints (terminals never move). The proposed new copper is preflighted against existing tracks/pads/vias (the originals being replaced are ignored so it never self-collides). When applied it CREATES the new geometry first, then DELETES the originals (create-then-delete: a mid-failure leaves a transient DRC-visible short, never a broken net).

Use pcb_route_geometry_report first to see the issues and planned change without mutating. Keywords: route cleanup, acute angle, right-angle jog, 45-degree miter, arc fillet, micro-segment, collinear vertex, dangling stub, tidy traces, clean up routing.`,
		withDocumentParam({
			...cleanupParams,
			dryRun: z.boolean().optional().default(false).describe('Plan only — return issues + planned spec count + length delta + obstacle report WITHOUT mutating.'),
		}),
		async (params) => {
			const result = await bridge.send('pcb.route.cleanup', params);
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);

	server.tool(
		'pcb_route_geometry_report',
		`Read-only route geometry report for a net (or the current selection). Forces dryRun:true — never mutates the board.

Reports every geometric issue (acute angle <90°, off-45-degree corner, right-angle jog, micro-segment, collinear-redundant vertex, dangling stub), the cleaned-geometry spec count, and the before/after net length so you can decide whether to run pcb_route_cleanup. Keywords: route geometry report, acute angle check, 45-degree grid, miter candidate, right-angle corner audit, jog detection, trace tidiness.`,
		withDocumentParam({
			...cleanupParams,
		}),
		async (params) => {
			const result = await bridge.send('pcb.route.cleanup', { ...params, dryRun: true });
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		},
	);
}
