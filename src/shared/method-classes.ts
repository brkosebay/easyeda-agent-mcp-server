// Single source of truth for how bridge RPC methods are classified. Shared by
// the extension (operation gate, selection guard) and the daemon (write lock,
// board-cache invalidation, work leases), so the two can never drift: a method
// the daemon treated as a read but the extension treated as a write used to
// skip the daemon lock and leave stale board-cache entries behind.
//
// Fail-closed: any method NOT listed as a read is a write.

// Answered outside the extension's operation gate (they must work while a
// hung EasyEDA call holds the queue). The daemon never takes a document lock
// for them either — a wedged write holding that lock is exactly when the
// recovery methods are needed.
export const GATE_BYPASS_METHODS = new Set<string>([
	'instance.getInfo',
	'editor.native.operationStatus',
	'editor.native.inspectUncertain',
	'editor.native.reconcile',
	'editor.native.resetQueue',
	// Reports the in-memory repour job record; its optional SDK probe is
	// time-bounded, so it can never hold anything.
	'pcb.pour.jobStatus',
	// Escape for the editor: must work while something holds the queue.
	'editor.native.cancelCommand',
]);

// Gate-recovery methods that change state for EVERY agent (they un-wedge or
// clear the extension's shared operation queue). Under work leases only the
// orchestrator may call them, and only with `force` while other work is leased.
export const ADMIN_METHODS = new Set<string>([
	'editor.native.reconcile',
	'editor.native.resetQueue',
	// Document history is shared: an undo can revert another agent's work.
	'editor.native.undo',
	'editor.native.redo',
]);

// Methods that don't mutate the document.
export const READ_METHODS = new Set<string>([
	'instance.getInfo',
	// PCB reads
	'pcb.getAll.component', 'pcb.get.component', 'pcb.component.getPins', 'pcb.component.findByDesignator',
	'pcb.getAll.line', 'pcb.get.line',
	'pcb.getAll.polyline', 'pcb.get.polyline',
	'pcb.getAll.via', 'pcb.get.via',
	'pcb.getAll.pad', 'pcb.get.pad', 'pcb.pad.findByRef',
	'pcb.getAll.pour', 'pcb.get.pour', 'pcb.pour.inspect', 'pcb.copper.status', 'pcb.splitPour.plan', 'pcb.layer.report',
	'pcb.getAll.fill', 'pcb.get.fill',
	'pcb.getAll.arc', 'pcb.get.arc',
	'pcb.getAll.region', 'pcb.get.region',
	'pcb.net.getAllNames', 'pcb.net.getPrimitives', 'pcb.net.getLength',
	'pcb.net.connectivityStatus',
	'pcb.footprint.map', 'pcb.placement.suggestRotation', 'pcb.placement.reviewOrientations',
	'pcb.trace.checkObstacles',
	'pcb.board.refreshCache', 'pcb.routing.presets',
	'pcb.context.routing', 'pcb.context.netWorklist', 'pcb.context.inspectArea',
	'pcb.context.keepouts', 'pcb.context.obstacleMap',
	'pcb.placement.suggestMove', 'pcb.placement.reviewPlacement',
	'pcb.drc.check', 'pcb.drc.summarize', 'pcb.drc.violationsDetailed',
	'pcb.drc.getCurrentRuleConfigName', 'pcb.drc.getRuleConfiguration',
	'pcb.drc.getRuleConfigByName', 'pcb.drc.getAllRuleConfigs',
	'pcb.drc.getDefaultRuleConfigName', 'pcb.drc.getNetRules',
	'pcb.drc.getNetByNetRules', 'pcb.drc.getRegionRules',
	'pcb.drc.getAllNetClasses', 'pcb.drc.getDiffPairs',
	'pcb.drc.getEqualLengthGroups',
	'pcb.layer.getAll', 'pcb.layer.getStatus', 'pcb.layer.physical.get',
	'pcb.document.navigateTo', 'pcb.document.navigateToRegion',
	'pcb.document.getPrimitiveAtPoint', 'pcb.document.getPrimitivesInRegion',
	'pcb.document.zoomToBoardOutline', 'pcb.document.getCanvasOrigin',
	'pcb.document.convertCanvasToData', 'pcb.document.convertDataToCanvas',
	'pcb.document.getCanvasFilter',
	'pcb.select.getAll',
	// SCH reads
	'sch.connectivity.get', 'sch.netlist.get', 'sch.drc.check', 'sch.drc.summarize',
	'editor.sch.pages',
	'sch.component.findPin',
	'sch.component.get', 'sch.component.getAll', 'sch.component.getAllPins', 'sch.component.listNetSymbols',
	'sch.wire.get', 'sch.wire.getAll',
	'sch.primitive.get', 'sch.primitive.getType', 'sch.primitive.getBBox',
	'sch.select.getAll', 'sch.select.getAllIds',
	'sch.extract.design',
	'pcb.extract.design',
	// Native source read: never queue it behind a document lock — it is the
	// operator's evidence path when a write is wedged.
	'editor.native.getSource', 'editor.native.operationStatus', 'editor.native.cancelCommand',
	'pcb.native.renderImage',
	// Editor / project reads + screenshots
	'editor.project.getStructure', 'editor.getCurrentDocument', 'editor.getOpenTabs',
	'editor.screenshot', 'pcb.screenshot.board', 'pcb.screenshot.closeup',
	'editor.zoomToRegion', 'editor.zoomTo', 'editor.zoomToAllPrimitives', 'editor.zoomToSelected',
	// Library reads (most lib operations are search/lookup)
	'lib.getAll', 'lib.search', 'lib.get', 'lib.getByLcsc', 'lib.getSystemUuid',
]);

export function isReadMethod(method: string): boolean {
	if (READ_METHODS.has(method)) return true;
	// Permissive heuristic: lib.* defaults to read. Anything else is a write.
	if (method.startsWith('lib.')) return true;
	return false;
}

/** Writes that serialize on the daemon's per-document lock (gate-bypass methods never do). */
export function isLockedWrite(method: string): boolean {
	return !isReadMethod(method) && !GATE_BYPASS_METHODS.has(method);
}

/** EasyEDA tab ids are `<docUuid>@<projectUuid>`; the bare UUID identifies the document. */
export function canonicalDocumentId(value: string): string {
	return String(value).trim().split('@')[0];
}
