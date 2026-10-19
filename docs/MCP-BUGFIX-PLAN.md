# MCP Bugfix Plan — v1.1 bug log remediation

Source: bug log from the v1.1 layout session (12 defects). Root causes located 2026-07-25.
Execution: 3 Opus 5 agents — Wave 1 runs A + B in parallel (disjoint files), Wave 2 runs C
(shares `catalog/index.ts`, `ws-client.ts`, `_utils.ts`, `pour-fill.ts` with B).

## Workstream A — obstacle checker geometry & rules (bugs 1, 2)

Files: `src/extension/handlers/trace-obstacles.ts`, `src/mcp-server/analyzers/obstacle-map.ts`,
`src/mcp-server/tools/write-tools.ts` (clearance default only).

1. **Pads as rotated rectangles, not point+radius.**
   - `padToObstacle()` (trace-obstacles.ts:429-459) collapses width/height to
     `max(w,h)/2` circle and never reads `rotation`. Replace with a 4-corner rotated
     rect fed through the existing polygon path (`polygonObstacleHit` :513-546,
     `nearestPointOnRect` :662, `lineIntersectsRect` :741). Distance = edge-to-edge.
   - Same fix in `obstacle-map.ts` `padObstacle()` (:214-235).
2. **Unit normalization.** `normalizeComponentPinToMil()` (:669-676) scales only
   coordinate fields ×10, not width/height → pad radius 10× too small; standalone
   pads (:229-235) get no scaling; vias (:204-210) raw. Normalize ALL dimensions of
   component pads (coords + width/height ×10) and document each source's units in one
   place. Output envelope must be uniformly mil (it claims `units:'mil'` at :342 —
   make that true, including segment coordinates).
3. **Real design rules instead of hard-coded margins.** Kill/demote
   `DEFAULT_CLEARANCE_MIL=6`, `DEFAULT_PAD_RADIUS_MIL=18`, inline via `24`
   (:45-48, :210). Resolve per-net clearance via the existing precedent:
   `board-context.ts` `safeRuleContext()` (:1285-1303) / `findRuleNumberForNet`,
   backed by `drc.ts` `pcb.drc.getRuleConfiguration` (:87-150). Fall back to defaults
   only when rules are unreadable, and say so in the response (`clearanceSource:
   "rule:<name>" | "default"`).
4. **Phantom pad `e0`.** :440-441 lets an object with no x/y borrow startX/startY;
   skip obstacles with no finite primary coordinates instead of fabricating them, and
   never synthesize ids for pads (obstacle-map.ts `idOf` :291-293).

Acceptance: response reports per-obstacle `distanceMil` measured edge-to-edge,
`requiredMil` traceable to a named rule, all values in mil, no obstacle without real
geometry.

## Workstream B — timeouts, zoom, repour, impedance (bugs 3, 4, 5, 6)

Files: `src/mcp-server/catalog/index.ts` (execute_tool schema only),
`src/mcp-server/bridge.ts`, `src/mcp-server/tools/editor-tools.ts`,
`src/mcp-server/tools/impedance-tools.ts`, `src/extension/handlers/editor.ts`,
`src/extension/handlers/impedance.ts`, `src/extension/handlers/pour-fill.ts`,
`src/extension/handlers/_utils.ts` (withTimeout only), `src/extension/ws-client.ts`
(param forwarding only).

1. **Bug 6 — `_timeoutMs` plumbing.**
   - `catalog/index.ts:115-149`: accept optional `_timeoutMs` as a sibling of `args`
     in the execute_tool schema and merge it into `args` before validation/dispatch.
   - `bridge.ts:406-409`: `send()` currently strips `_timeoutMs` (bridge timer only);
     forward it to the extension too, and size the bridge timer ≥ forwarded value + margin.
   - `bridge.ts:16-28`: `QUICK_METHOD_TIMEOUT_MS=5000` must not cap a call that
     carries an explicit `_timeoutMs`.
2. **Bug 5 — zoom timeout.**
   - `editor-tools.ts:187,203`: zod injects `timeoutMs` default 5000 which always wins
     over `_timeoutMs` (editor.ts:9-15 prefers `timeoutMs`). Drop the zod default (or
     raise to 30s) and make `setTimeoutParam` (:9-17) respect user-provided values
     instead of overwriting. Handler default 30s.
3. **Bug 4 — repour timeout/abort.**
   - `pour-fill.ts:620-711`: raise `DEFAULT_PER_POUR_MS` to 120s and honor
     `_timeoutMs`/`perPourTimeoutMs` from params (only `perPourTimeoutMs` read today
     at :617). Change `onTimeout` default from `'abort'` to `'continue'` so one stuck
     pour doesn't zero the run.
   - Count `rebuildCopperRegion()` resolving `undefined` (:684) as completed-unknown,
     not silently dropped; report it distinctly.
4. **Bug 3 — impedance apply repour.**
   - `impedance.ts` (:153-171, :271-273): add `repour: boolean` (default **true**)
     to `pcb.impedance.applyWidth` and `applyDiffPair`; after successful width
     changes, invoke `pourFillHandlers['pcb.pour.repourAll']` and include its result
     in the response. Expose the flag in `impedance-tools.ts` schemas (:107-228).

Acceptance: `execute_tool({name,args,_timeoutMs})` demonstrably changes the deadline
end-to-end; zoom callable with 25s budget; repour completes or reports per-pour
failures without aborting the batch; impedance apply leaves no stale pour by default.

## Workstream C — data extraction & introspection (bugs 7–12) — AFTER B lands

Files: `src/mcp-server/catalog/index.ts` (describeZod), `src/extension/ws-client.ts`
(compactItem/applyQueryParams), `src/extension/handlers/pcb-primitive.ts`,
`src/extension/handlers/_utils.ts` (HEAVY_FIELDS/envelope), `src/extension/handlers/net.ts`,
`src/extension/handlers/pcb-extract.ts`, `src/mcp-server/tools/pcb-extract-tools.ts`,
`src/mcp-server/tools/read-tools.ts`, `src/extension/handlers/pour-fill.ts` (Y metadata).

1. **Bug 7 — describe_tools crash.** `catalog/index.ts:284` does
   `def.shape?.()` but zod 4 `_def.shape` is a plain object → TypeError. Handle both
   (function in zod 3, object in zod 4). Also fix :280 array introspection
   (`def.type` is the string "array" in zod 4 → items become "unknown"; use the zod 4
   element accessor). Wrap per-tool describe in try/catch so one bad tool can't fail
   the whole call.
2. **Bug 8 — region geometry.** Regions' only geometry is `complexPolygon`, which is
   stripped twice: `HEAVY_FIELDS` (`_utils.ts:309-316`, applied :341,:353) and the
   `compactItem` whitelist (`ws-client.ts:64-84`). For region primitives, emit a
   summarized geometry (bbox + point count + first N points, like
   `summarizePolygonSource` in pour-fill.ts:10-95) instead of dropping it, and add
   `regionName`/`ruleType` to the compact whitelist.
3. **Bug 9 — Y-sign convention.** Pour/region polygon source arrays are passed
   through verbatim (positive Y) while tracks/pads/vias use canvas getters (negative
   Y). Normalize pour/region summarized geometry to the canvas convention (same sign
   as tracks) at the summarize step, and stamp every geometry-bearing envelope with
   `coordinateSpace: "canvas-mil-negY"`. Do not touch the SES import inverter
   (manufacture-tools.ts:869).
4. **Bug 10 — net primitives type mapping.** `net.ts:6-8` forwards `types` verbatim
   to `getAllPrimitivesByNet` (runtime names differ: Line→"Track", pads not returned
   at all). Add a case-insensitive alias map (line/track→Track, via→Via, etc.),
   **error** on unrecognized values listing accepted ones, and for pad requests fall
   back to the component-pin scan already used elsewhere (see net.ts:30-35 notes).
5. **Bug 11 — extract_design fields/filter + empty nets.**
   `pcb-extract-tools.ts:15-19` uses `withDocumentParam` so `fields`/`filter` are
   zod-stripped. Add them to the schema and implement top-level `fields` projection +
   net-name `filter` inside the handler (`pcb-extract.ts`). Fix net membership:
   `:231` gates pin iteration behind `includeAllPads` — compute `netMembers` /
   `pinCount` (:246-247, :288-291) unconditionally; `includeAllPads` should only gate
   the pad *listing*, not net stats.
6. **Bug 12 — envelope totals.** `ws-client.ts:114-119` recomputes `returned` after
   filtering but keeps pre-filter `total` → `truncated:true` lies. Report
   `matched` (post-filter), keep `total` as unfiltered-with-that-name semantics
   documented, and set `truncated` = matched > returned. Also `_utils.ts:376-379`
   applies `limit` BEFORE downstream filtering — filter first, then limit.

Acceptance: `describe_tools` works for every registered tool (loop over the full
catalog in a smoke test); region query returns usable geometry; documented single Y
convention; `pcb_get_net_primitives` returns data or a helpful error; extract_design
honors fields/filter and reports real pinCount/members; envelopes never claim
truncation when nothing was cut.

## Workstream D — hole scaling + polyline/outline geometry (bugs 13, 15)

Files: `src/extension/handlers/trace-obstacles.ts`, `component.ts`, `drc.ts`,
`board-context.ts`, `placement.ts`, `pcb-extract.ts`, `pcb-primitive.ts`, `track.ts`,
`src/mcp-server/analyzers/obstacle-map.ts`.

1. **Bug 13 — `hole` tuple unscaled.** `normalizeComponentPinToMil`
   (trace-obstacles.ts:779-787) scales scalar length keys and the `pad` tuple but has
   no `out.hole` branch — the `["SLOT", w, h]` tuple from `getState_Hole` passes
   through at 1/10 mil. Scale it exactly like `pad` (`scalePadShapeToMil`). Sweep the
   sibling normalizers with the same omission: component.ts:30-39, drc.ts:711-718,
   board-context.ts:657-661, placement.ts:673, pcb-extract.ts:107-110,
   pcb-primitive.ts:158-177 (findByRef scales x/y only — `pad`/`hole` both raw there).
2. **Bug 15 — polyline geometry / board outline.** `flattenState` strips `polygon`,
   so `IPCB_PrimitivePolyline.getState_Polygon()` never reaches output. Give polyline
   handlers (track.ts:121-129) the same summarized-geometry treatment regions got
   (`attachPolygonSummaries`/`summarizePolygonSource` from pour-fill.ts + coordinate
   space stamp; `compactItem` already whitelists `summary`). Load layer-11 polylines
   into the board-context snapshot (board-context.ts:476-486 loads only
   pcb_PrimitiveLine; see pour-fill.ts:861 for the working polyline getAll) so
   `boardOutlineSegments`/`boardOutline` (board-context.ts:545-565, :2002-2020;
   obstacle-map.ts:107-128) count outline polylines, not just lines.

## Workstream E — region-tool hangs + affine Y transform (bugs 14, 16)

Files: `src/extension/handlers/document.ts`, `editor.ts`, `pour-fill.ts`,
`src/mcp-server/tools/editor-tools.ts`, `analysis-tools.ts`, `pcb-document-tools.ts`,
`src/mcp-server/bridge.ts` (QUICK_METHOD list only).

1. **Bug 14 — region SDK promises never settle.** `navigateToRegion`,
   `getPrimitivesInRegion` (document.ts:96-122) and `zoomToRegion`
   (editor.ts:203-225) await EasyEDA APIs that hang forever; the timeout is the only
   thing that returns, at any budget.
   - `pcb_get_primitives_in_region`: reimplement WITHOUT the hanging SDK call — fetch
     via `getAll*` and bbox-filter server-side (the `pcb_inspect_area` precedent,
     board-context.ts:180-202), honoring the same type filters and envelope shape.
   - `navigateToRegion` / `zoomToRegion` / `pcb_screenshot_closeup`: fire the SDK
     call without awaiting it to completion — race a short confirmation poll (canvas
     origin/scale change) and return `{dispatched: true, confirmed: boolean}` instead
     of throwing after the deadline. Never hang the caller for an unresolvable
     promise.
   - Deduplicate the double registration of `pcb_get_primitives_in_region`
     (analysis-tools.ts:148 and pcb-document-tools.ts:97).
   - Remove the now-pointless 5s defaults (document.ts:3-4, editor-tools.ts:131,
     analysis-tools.ts / pcb-document-tools.ts schema defaults) and drop the region
     methods from bridge QUICK_METHOD_TIMEOUT_METHODS.
2. **Bug 16 — affine Y, unknown-origin X.** `toCanvasY = -y` (pour-fill.ts:15-17) is
   wrong: polygon sources are in document/data space, which differs from canvas
   space by sign AND the canvas origin offset (the observed 39.37 mil = 1 mm
   residual). Use the runtime origin — `eda.pcb_Document.getCanvasOrigin()` /
   `convertDataOriginToCanvasOrigin` (document.ts:128-142; SDK index.d.ts:3314-3368)
   — to build a proper data→canvas affine for BOTH axes in
   `summarizePolygonSource`/`summarizeLinePoints`, cached per call. Keep the
   `coordinateSpace: "canvas-mil-negY"` stamp only when the transform actually
   succeeded; fall back to raw source values with `coordinateSpace:
   "data-space-untransformed"` if the origin is unreadable — never silently emit
   half-transformed numbers.

## Shared constraints (all agents)

- TypeScript strict; run `npx tsc --noEmit` (or the repo's build script) before finishing.
- Do not change tool names or break existing arg shapes — additive changes only.
- Update `docs/TOOLS.md` entries for any tool whose behavior/args changed.
- Do not bump versions or commit; leave the working tree for review.
