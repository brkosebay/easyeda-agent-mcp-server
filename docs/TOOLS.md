# EasyEDA Agent MCP — Tool Reference

This server bridges Claude (or any MCP client) to the EasyEDA Pro extension running inside the editor. The MCP server is a Node process; the extension runs in EasyEDA's JS sandbox. They talk over a local WebSocket.

```
Claude  ──MCP stdio──▶  mcp-server  ──WebSocket──▶  EasyEDA extension  ──▶  eda.* APIs
```

## Tool surface — dynamic toolsets (default)

The agent sees only **3 meta-tools** in the system prompt:

- `search_tools(query, tags?)` — semantic search across the catalog (local MiniLM embeddings, sub-200 ms cached). Returns ranked tool names + briefs.
- `describe_tools(names[])` — JSON-schema-style parameter info for the tools you picked. Schemas are 60-80% of static-toolset token cost; lazy-loading them is the biggest saving.
- `execute_tool(name, args, _timeoutMs?, lease?, override_leases?)` — validates args against the tool's Zod shape and runs the underlying handler. Same return shape as the static surface; keys that are not parameters of the tool come back as an extra `{ignoredArgs, note}` content item instead of being dropped silently. `_timeoutMs` may be passed as a sibling of `args` (or inside `args`; the sibling wins); it is merged into the dispatched arguments and forwarded to the extension handler, with the bridge timer sized 5 s above it. `lease` runs the call under a work lease (see [MULTI-AGENT.md](MULTI-AGENT.md)); `override_leases` is the orchestrator's escape hatch.

The 100+ concrete tools live in a server-side catalog. The first `search_tools` call takes ~2 s while the embedding model loads (Xenova/all-MiniLM-L6-v2, ~22 MB); subsequent calls are sub-200 ms with vectors cached at `.cache/tool-embeddings.json`. Falls back to keyword scoring if the model can't load.

**Opt-out**: set `EDA_DYNAMIC_TOOLSETS=0` to expose every tool individually (the legacy ~108-tool static surface). Useful for older MCP clients that don't handle meta-tool discovery.

### Dynamic-mode workflow

```
1. search_tools({query: "create a track"}) → ranked tool names + briefs
2. describe_tools({names: ["pcb_route_path"]}) → one-line-per-argument signatures
3. execute_tool({name: "pcb_route_path", args: {...}}) → same shape as static
```

Optional: `search_tools({tags: ["pcb","write"]})` for tag-only filtering, or pass both `query` and `tags`.

## Setup

1. Build: `npm run build` — produces `dist/` and a packaged extension archive.
2. Install the extension in EasyEDA Pro (Extensions → Load).
3. Start a Claude session with this MCP server configured (`npm run start`).
4. In EasyEDA Pro, click **Claude → Connect Claude**. The extension connects to the active MCP server (single-primary; new sessions auto-promote).

## Conventions

| Concept | Detail |
|---|---|
| Units | MCP-normalized PCB coordinates and lengths are in **mil** (1 mil = 0.0254 mm). Component-pin coordinates are 10-mil units on EasyEDA Pro 2.x and mil on 3.x; the extension detects which at runtime (`pin-units.ts`) and always returns mil, stating `units` once per response. DRC violation coordinates are scaled from 10-mil (not yet re-verified on 3.x). Pad geometry is normalized per field, not per record: a pad's `pad` extent tuple is already mil on every EasyEDA API, while its `hole` tuple is 10-mil units on every API (including the otherwise-mil standalone-pad path) and is scaled to mil by the server. Pad `rotation` is reported in radians (component `rotation` is degrees) and is converted before any bounding-box maths. Schematic uses 0.01 inch. Use `pcb_create_via_mm` for mm input. |
| Layers | Numeric IDs (1=Top, 2=Bottom, 11=BoardOutline, 15..44=Inner1..30, 71..100=Custom1..30) or names ("TopLayer", "Inner1", "BoardOutline"). Case-insensitive. |
| Polygon | Pours/fills/regions accept `{points:[{x,y},...]}`, `[{x,y},...]`, `["L",x1,y1,...]`, or `["R",centerX,centerY,w,h,rot,radius]`. Auto-closes rings and converts to EasyEDA's native polygon source. |
| Trace widths | Routing tools accept `lineWidth` in mil. Smart routing also accepts `width_mil`, `trace_width_mil`, and `lineWidthByNet` for easy per-net widths. |
| viaType | Number (`0`/`1`/`2`) or string (`"Through"`/`"BlindBuried"`/`"Suture"`). |
| Documents | Most pcb_* / sch_* tools take `document` (UUID). Use `editor_get_open_tabs` to discover. |
| Multi-instance | When >1 EasyEDA window is open, pass `instance_id` (8-hex). Single window auto-selects. |
| Compact mode | All `getAll`-style read tools default to `compact:true` — identity + key geometry only. Pass `compact:false` for full data including geometry source. |
| Field projection | `fields:["a","b"]` projects to those keys. `filter:{net:"GND"}` filters items. `limit:N` truncates. `filter` is applied **before** `limit`, so a filtered query never hides matches behind the cutoff. |
| Envelopes | `getAll`-style tools return `{total, matched, returned, truncated, items}`. `total` = everything the underlying query matched; `matched` = survivors of `filter`; `returned` = items after `limit`; `truncated` is true only when items were actually cut off. |
| Coordinate space | Geometry-bearing responses carry `coordinateSpace: "canvas-mil-negY"` — mil, Y growing upward (negative below origin), matching track/pad/via getters. Pour/region polygon summaries are mapped into this space from EasyEDA's positive-down, data-origin source arrays using the runtime's own data→canvas affine (probed via `convertDataOriginToCanvasOrigin`, falling back to `getCanvasOrigin`), so a non-zero canvas origin is handled on both axes. If that origin cannot be read, the summary carries the untouched source numbers stamped `coordinateSpace: "data-space-untransformed"` instead of half-converted values. |
| Timeout | Fast tools (primitive-lookup + pad lookup) default to 5 s. Zoom tools default to 30 s (override with `timeoutMs`). Long tools default to 120 s unless overridden. Use `_timeoutMs` per call for slower workflows (e.g. 300000 for 5 min) — it is forwarded to the extension handler *and* raises the bridge timer (value + 5 s), and it overrides the 5 s fast-tool cap. Global defaults via `EDA_WS_TIMEOUT_MS` and quick defaults via `EDA_WS_QUICK_TIMEOUT_MS` env. |
| Wait for ready | When spawning a fresh MCP server from a script, call `wait_for_extension` first. The extension may take 1–5 s to attach (peer notification or live-mode tick). |
| Help inline | `pcb_help(topic)` returns long-form docs on demand for `polygon`, `layer`, `viaType`, `compact`, `units`, `primitives`, `timeout`. |

## Recommended PCB agent workflow

The model plans each route; the MCP executes it exactly and proves the result (`pcb_route_path`). This mirrors the only pipeline that produced an accepted board in past sessions: plan per section, exact pads, shape-true clearance, one commit per section, read back, repour, DRC.

1. **Sense:** `pcb_get_routing_context` / `pcb_inspect_area` for the section (API-frame coordinates, pads, existing copper, rules). Use `pcb_get_footprint_map` for dense parts.
2. **Plan:** for each connection, choose the terminals (pad ref, existing via/track) and the interior points (45 degree legs; a point with `layer` places a via).
3. **Dry-run:** `pcb_route_path` with `routes:[...]` for the whole section. Fix whatever it refuses (codes like `NOT_OCTILINEAR`, `LAYER_MISMATCH`, `FREE_END`; blockers name the obstacle, gap and required clearance).
4. **Commit:** the same call with `dryRun:false` and a `requestId`. It is all-or-nothing, reuses identical copper, and verifies that every route joins its terminals (or removes itself).
5. **Close the section:** `pcb_repour_all`, then `pcb_drc_summarize` and `pcb_connectivity_status` (real copper graph: `connected` / `incomplete` / `pour_dependent`).
6. **Rip-up and retry:** `pcb_batch_edit` (transactional) with deletes plus new tracks, or `pcb_route_path` with `ignorePrimitiveIds` for copper you are replacing.

`pcb_route_smart` (re-synthesizes geometry) and the grid pathfinder family (`pcb_route_pathfind` / `pcb_route_net(s)` / `pcb_route_and_verify`) remain as helpers, not the main path. All of them use the board's DRC rules (per-net clearance by obstacle kind, track width, via size) unless you pass an override. Between two nets the larger of their rules applies (`clearanceSource` names the deciding net when the other side's rule wins); net-less copper uses the default rule.

## Server / instance

| Tool | What |
|---|---|
| `server_info` | WebSocket port, connection state, allowed origins. |
| `list_instances` | All connected EasyEDA instances with active document and tab list. |
| `work_lease` | Multi-agent coordination: `claim` / `renew` / `release` / `list` work leases (exclusive, shared-with-scope, read-only). See [MULTI-AGENT.md](MULTI-AGENT.md). |

## Editor / project

| Tool | What |
|---|---|
| `project_get_structure` | Boards, schematics, PCBs, panels, focused doc. |
| `editor_get_current_document` | Active doc with parent context. |
| `editor_open_document` | Open a doc by UUID. |
| `editor_get_open_tabs` | Open tabs and split-screen tree. |
| `editor_screenshot` | PNG of current canvas (desktop Electron only — web app returns undefined). Downscaled to `maxWidth` (default 1280; `0` = full resolution); returns `width`/`height`/`scaledFrom`. |
| `pcb_screenshot_board` | One-shot: refresh + zoom-fit board + capture PNG. Same `maxWidth` downscale. |
| `pcb_screenshot_closeup` | Zoom to a point, region, or trace segment and capture a close-up PNG. The zoom is dispatched without awaiting EasyEDA's never-settling promise; the response carries `zoom: {dispatched, confirmed}` (`confirmMs` tunes the confirmation poll, default 4000 ms for this tool). The capture waits for the viewport to confirm the move and retries the zoom once; if it still cannot confirm, the response sets `regionApplied` to `false` (probe worked, canvas did not move) or `"unknown"` (this build also never resolves the read-only viewport probe) plus a `warning` — treat `region` as requested, not applied. Regions use canvas space with negative Y below the origin, so `top` is the greater Y value. |
| `wait_for_extension` | Block until the extension has attached. Use at the start of ad-hoc scripts. |
| `editor_zoom_to_region` | Zoom to a rectangle. EasyEDA's `zoomToRegion` promise never settles, so the call is dispatched and the viewport polled: returns `{dispatched:true, confirmed, viewportBefore, viewportAfter}` and never hangs. `confirmMs` optional (default 1500). |
| `editor_zoom_to` | Center on (x,y) with optional scale. `timeoutMs` optional (handler default 30000). |
| `editor_zoom_to_all` | Fit all primitives. `timeoutMs` optional (handler default 30000). |
| `editor_zoom_to_selected` | Fit selection. `timeoutMs` optional (handler default 30000). |
| `editor_add_markers` | Draw arrows/boxes on canvas. |
| `editor_clear_markers` | Remove all markers. |

## PCB read

| Tool | What |
|---|---|
| `pcb_get_all_primitives` | List by type (`component`/`track`/`polyline`/`via`/`pad`/`pour`/`fill`/`arc`/`region`) with net/layer filters. `region`, `pour` and `polyline` items include a `summary` (mode, bbox, `pointCount`, first 8 points) so their polygon geometry survives compact mode. |
| `pcb_get_primitives_by_id` | Look up by ID. `region`/`pour`/`polyline` results carry the same polygon `summary`. |
| `pcb_get_all_nets` | Every net name. |
| `pcb_get_net_primitives` | Primitives belonging to a net. `types` is case-insensitive and aliased to runtime names (`line`/`trace`/`wire` → `Track`, `copperArea` → `Pour`, `footprint` → `Component`); accepted values are `Track`, `Via`, `Arc`, `Polyline`, `Pour`, `Poured`, `Fill`, `Region`, `Pad`, `Hole`, `Component`, `Text`, and an unknown value errors with the list. `Pad` is served by a component-pin scan (pads are not stored on the net). |
| `pcb_get_net_length` | Total routed mil length. |
| `pcb_get_design_rules` / `pcb_get_net_rules` | Active DRC config. |
| `pcb_get_pad` | Lookup by `reference` + `padNumber` → `{x,y,layer,net}`. `pad` and `hole` shape tuples are scaled to mil alongside the coordinates. |
| `pcb_get_component_pins` | Every pin of a component. Coordinates plus the `pad`/`hole` shape tuples are normalized to mil. |
| `pcb_refresh_board_cache` | Rebuild the extension-side spatial snapshot used by routing context/pathfinding/worklists. |
| `pcb_get_routing_presets` | Recommended trace width, via size, clearance, and via strategy by net. |
| `pcb_get_routing_context` | One-call task context packet: board/layers/rules, nets, endpoints, pads, nearest pairs, routes, vias, and area primitives. |
| `pcb_get_net_worklist` | Rank nets by routing priority/difficulty so agents route the highest-impact nets first. |
| `pcb_inspect_area` | Cached area inspection: components, pads, tracks, vias, pours, keepout candidates, nets, plus a ready `pcb_screenshot_closeup` hint. |
| `pcb_get_keepouts` | List DRC region primitives that look like keepout/no-route/no-copper constraints. |
| `pcb_get_obstacle_map_summary` | Per-layer obstacle-map summary from the live board cache or a supplied snapshot. Board-outline counts and bounds include layer-11 polylines as well as lines; `boardOutline` carries `segmentCount`, `polylineCount` and per-polyline summarized points/bbox. |
| `pcb_get_footprint_map` | Footprint-aware pad map: local offsets, side/quadrant, net summary, and candidate rotation geometry. |
| `pcb_suggest_component_rotation` | Score 0/90/180/270 rotations for one component using ratline length, crossings, pad-facing direction, and collision risk. |
| `pcb_review_component_orientations` | Board-level scan for components that likely route cleaner if rotated. |
| `pcb_suggest_component_move` | Suggest small component moves that reduce routing span while avoiding approximate component collisions. |
| `pcb_review_placement` | Board-level placement review for move opportunities. |
| `pcb_score_placement` | R2 objective report: total HPWL, ratsnest crossing count, top HPWL nets, and decoupling-distance table. |
| `pcb_extract_placement_clusters` | R2 cluster extraction: IC/regulator anchors with decoupling caps, immediate passives, pin-proximity targets, cluster HPWL, and loose-component count. |
| `pcb_place_cluster` | R2 cluster placement proposal/apply tool. Default `mode:"propose"` returns snapped decoupling/passive moves with lock and courtyard-collision guards. |
| `pcb_optimize_placement` | R2 global placement optimizer. Default `mode:"propose"` runs coordinate-descent over components/clusters to reduce weighted HPWL/crossing/decoupling objective with grid, lock, courtyard, and board-bounds guards. |
| `pcb_check_trace_obstacles` | Dry-run a trace segment/path against existing tracks, vias, standalone pads, component pads, pours, keepout candidates, and board-boundary escapes before creating copper. Pads are checked as rotated rectangles and `distanceMil` is edge-to-edge; all values are mil. Clearance comes from the active DRC rule configuration / per-net rules unless `clearanceMil` is passed — the response reports `clearanceSource` (`param:clearanceMil`, `rule:<name>`, `rule:netRule:<net>`, or `default`), with `; larger-of-nets: …` when the obstacle's net rule decided. Component pads are checked once (`checked.componentPadDuplicatesSkipped`). |
| `pcb_extract_design` | One-shot PCB snapshot: components, nets (members + `pinCount` + power/ground tagging), layer stack, by-layer counts. Net membership and `pinCount` are always computed; `includeAllPads` only gates the flat pad listing (pad entries carry mil-scaled `pad`/`hole` shape tuples). `fields:["nets","stats"]` projects the snapshot to those top-level keys (response keeps `_availableFields`); `filter:{net:"GND"}` / `{net:"VCC*"}` / `{net:["GND","VCC"]}` restricts it to matching nets. |
| `pcb_run_drc` | Run DRC; verbose:true returns violation list. |
| `pcb_get_selected` | Currently selected primitives. |
| `pcb_help(topic)` | Inline reference for tool conventions. |
| `pcb_get_layer_status` | Per-layer visibility/lock/transparency, slim: `{layers, omitted, note}` with only layers in use plus 1/2/11/12, default `locked:false`/`transparency:0` dropped. `full:true` returns the old bare array. |
| `pcb_layer_report` | **Layer optimisation** (read-only). Per copper layer: role (signal / signal+flood / flood / plane / unused), tracks, length, nets, via transitions, pours (net, priority, area %, native islands), and plane integrity on plane layers (other-net cuts per net, antipads, longest cut, `likelySplit`). `netIssues`: nets whose reference plane is cut or missing under the route. `recommendations` (heuristics with sev/conf/why/fix): `PLANE_CUT`, `SPLIT_REFERENCE`, `WEAK_REFERENCE`, `NO_ADJACENT_PLANE`, `EMPTY_LAYER`, `NEARLY_EMPTY_LAYER`, `VIA_BOUNCE`, `STUB_VIA`, `LAYER_COUNT(_HS)`, `STACKUP`, `INNER_TYPE`. `detail:"nets"` adds per-net rows, `"full"` adds ids. |
| `pcb_get_canvas_filter` | Current canvas primitive-type filter. |

## PCB write

| Tool | What |
|---|---|
| `pcb_route_path` | **Primary routing tool.** Commits exactly the model-planned path (pads / via / track / T-junction terminals, interior points, layer-change vias) as one transaction, or nothing. Refuses net mismatches, non-45 degree legs, acute turns, layer discontinuities, and free ends. Clearance comes from the board DRC rules (pours = plane-cut warnings). Verifies that the new copper joins every route terminal pair in the real copper graph (`verify:"drc"` also requires no new real violations), otherwise rolls back. Reuses identical copper; `requestId` makes retries idempotent; `units:"mm"`. |
| `pcb_move_via` | Move a via and drag the track ends attached to it (rubber-band, like a GUI drag) instead of stranding them. Dry-run by default; refuses blocked or too-short legs; transactional with read-back (EasyEDA silent no-ops roll back); undoes the move if the net splits into more pad groups. Attached arcs are refused. |
| `pcb_create_track` | Single Line track between two points (mil). |
| `pcb_create_polyline_track` | **LEGACY** Polyline graphic; doesn't carry a net. Prefer pcb_create_track. |
| `pcb_create_via` | Via in mil. |
| `pcb_create_via_mm` | Via in mm (`diameter`/`holeDiameter`, alias `drill`). Refuses no annular ring and diameters over 6.35 mm (probably mil). Returns resolved mil values. `pcb_create_via` also takes `drill`, `drill_mm`, `diameter_mm`. |
| `pcb_stitch_perimeter` | Place same-net stitching vias along the BoardOutline at a pitch/inset, with dry-run support. |
| `pcb_create_arc` | Arc track. |
| `pcb_create_pad` | Standalone pad. |
| `pcb_create_pour` | Copper pour. polygon: see `pcb_help("polygon")`. |
| `pcb_create_fill` | Fill region. |
| `pcb_place_cluster` | With `mode:"apply"`, sequentially applies accepted `pcb_place_cluster` component moves via the existing locked-component-safe move handler. Optional `autoRipConnectedTracks` removes old attached route stubs/vias. |
| `pcb_optimize_placement` | With `mode:"apply"`, sequentially applies accepted global placement optimizer moves through the locked-component-safe move handler. Optional `autoRipConnectedTracks` removes old attached route stubs/vias. |
| `pcb_create_region` | DRC region (keepout/constraint). |
| `pcb_route_orthogonal` | Manhattan path with real Line primitives (1/2/3 segments + jog). |
| `pcb_route_smart` | Pad/point-to-pad/point routing with 45-degree miter option, optional fanout/in-pad vias, explicit trace widths, and dry-run. |
| `pcb_route_pathfind` | Obstacle-aware grid pathfinder (`start`/`end` objects or `startX/startY/endX/endY`); plans around different-net tracks/vias/pads/pours/keepout candidates, pull-tight shortcuts legal 45-degree grid slack by default, and can commit Line primitives. |
| `pcb_route_net` | First-slice net router; routes deterministic nearest-neighbor pad pairs for one net through `pcb_route_pathfind`, simulates accepted segments into the working snapshot, defaults to `dryRun:true`, and can commit Line primitives. |
| `pcb_route_nets` | First-slice worklist router; routes explicit nets or priority worklist nets using a shared working snapshot so earlier accepted net plans become obstacles for later nets. Defaults to `dryRun:true`. |
| `pcb_route_and_verify` | R4 first-slice closure loop; runs `pcb_route_nets`, then after committed routes refreshes the snapshot and returns selected-net connectivity plus compact DRC verdict/next actions. Defaults to `dryRun:true`. |
| `pcb_route_retry_plan` | Read-only rip-up/retry planner; extracts blocking nets from a failed route result or fresh dry-run route, ranks low-cost rip-up candidates, and returns reviewed delete/reroute sequences without mutating. |
| `pcb_auto_fanout` | Single-pad fanout via + stub with configurable direction, offset, via size, and trace width. |
| `pcb_route_pair` | **Primary diff-pair tool.** You plan the centerline (`centerline:[{x,y,layer?}]`, `p`/`n` terminals, `pair` or `pNet`/`nNet`); each net is offset by ±(width+gap)/2 with miter joins, so the coupled gap is exact through 45°/90° corners. 45° pad fan-ins; a `layer` point places paired vias at `viaPitch`. Width/gap default to the board's Differential Pair rule. P–N spacing checked over the whole plan, then both nets commit through `pcb_route_path` as one transaction (N fails ⇒ P removed). Reports `skew` (incl. per-corner part) and, after commit, `measured` pad-to-pad lengths. `dryRun` defaults to true. |
| `pcb_length_tune` | Meander ONE straight leg so the net's real signal path (shortest copper path between its endpoints) grows by exactly `addLength` / to `targetLength` / to `matchNet` / to `matchPartner`, or refuse. `coupled:true` tunes both legs of a pair with the gap kept. Refuses stubs (`LEG_NOT_ON_PATH`), touching runs, cut-off branches; `insufficient-space` lists every attempt. Commit = meander + leg delete in one transaction, then re-measured; restored if the path did not grow by the plan. `dryRun` defaults to true. |
| `pcb_route_diff_pair` | LEGACY (commits immediately, spacing drifts in turns) — use `pcb_route_pair`. |
| `pcb_length_match` | LEGACY (can add copper without adding path length) — use `pcb_length_tune`. |
| `pcb_batch_edit` | Preflight and optionally commit multiple create/modify/delete edits as one batch. Defaults to `dryRun:true`. Transactional (`atomic`, default): creates/edits first, deletes last; on failure, rolls back creates/edits and always reports created/modified/deleted ids. Clearance from board rules (larger of the two nets' rules); copper deleted in the same batch does not block. Accepts `edits` for `operations`, delete `primitiveIds`/`primitiveId`/`id`, track `width`; unknown keys, missing nets and non-numeric coordinates are errors before anything runs. |
| `pcb_delete_tracks_by_filter` | Bulk-delete tracks by net/layer. preserveLocked option. |
| `pcb_lock_by_filter` | Bulk lock/unlock tracks, vias, arcs, polylines, pours, fills, and regions by net/layer/type. Useful before autoroute. |
| `pcb_move_component` | Move/rotate/flip/lock/rename a component. |
| `pcb_apply_component_rotation` | Apply a footprint-aware rotation recommendation by primitiveId/designator, with dry-run, locked-component guard, and optional `autoRipConnectedTracks`. |
| `pcb_set_component_position` | Move/rotate placed components by primitiveId/designator with dry-run, locked guard, and optional `autoRipConnectedTracks` to delete same-net Line endpoints/vias attached to old pad centers. |
| `pcb_modify_track` | Modify a Line; returns `{modified, persisted, after, attempted}` (re-fetches to verify). |
| `pcb_modify_primitive` | Generic modify — type-tagged. |
| `pcb_delete_primitives` | Generic delete by type + IDs. |
| `pcb_save` | Save the PCB document. Resolves the active PCB uuid when omitted (`save(uuid)` requires it), waits ≤ `timeoutMs` (30 s) and returns `status` `saved`/`failed`/`pending`/`previous-save-pending`; never stacks a second save on an unanswered one (`force:true` overrides). |

## PCB DRC / rules

| Tool | What |
|---|---|
| `pcb_drc_summarize` | Top-N violation groups by category/net/component. |
| `pcb_drc_violations_detailed` | Repair-oriented DRC leaf violations with resolved locations/offenders when EasyEDA omits coordinates. |
| `pcb_repour_all` | Rebuild pours with **EasyEDA's own copper engine** (v2.1.12 `strategy:"native"`, default): publishes the same events as Shift+B (`rebuildCopper` + `rebuildPlane`, or `rebuildSingleCopper` for `pourIds`/`net`/`layer`) into the PCB tab through the editor's message bridge, never awaits the editor, and reads the result back from the editor's copper store. Per pour: `rebuilt` (new islands) / `up-to-date` (identical copper kept) / `empty` (rebuild ran, pour has **no** copper) / `unverified` / `unconfirmed` / `failed` / `skipped-locked`, with `copper.islands` + approximate bbox. Job `completed` only when every targeted pour has copper. One undoable "rebuild copper" step; tab marked unsaved. `background:true` returns a `jobId`. `strategy:"rebuild"`/`"modify"` are the public-SDK paths, which do not fill copper on EasyEDA Pro 2.2.47 (diagnosis only). |
| `pcb_rebuild_all_pours` | Alias of `pcb_repour_all` (same arguments/result). |
| `pcb_repour_status` | Current/last repour job from the extension's in-memory record — answers without the operation queue, even while EasyEDA is wedged. `probe:true` adds a 3 s liveness probe; lists rebuild promises EasyEDA has not settled. Also reports `nativeHost` (whether the editor bridge is reachable). |
| `pcb_copper_status` | What copper each pour **actually** has, from the editor's copper store (the SDK cannot see poured copper on this build): per pour `hasCopper`, `islands`, style, approximate bbox, priority, lock; `summary` + `emptyPours`. Read-only. Reflects the last rebuild. |
| `pcb_plan_split_pours` | Dry-run of a **split plane**: several pours of different nets on one copper layer (e.g. +3V3 left, GND right of Inner2). `regions:[{net, polygon\|rect, priority?}]` or `split:{axis, at, nets:[low,high]}` (cuts the board outline with `gapMil`, default the board clearance rule). Checks layer type (PLANE refused), board bounds, gaps/overlaps (overlaps need explicit, different priorities), which pads/vias each region serves, own-net pads in a foreign region (`PAD_IN_FOREIGN_REGION`), dead regions, overlapping existing pours. Read-only. |
| `pcb_create_split_pours` | Commits the same plan: creates every pour, reads each outline back, applies priorities, optionally deletes the layer's old pours **after** the new ones verify (`replaceExisting`), rebuilds natively and reads back islands + pads/vias reached per pour. Any failure deletes everything the call created (`rolled-back`). `committed-unverified` when the copper store can't be read. Pours deleted by `replaceExisting` are only recoverable with `editor_undo`. |
| `pcb_render_image` | Offscreen PNG render by EasyEDA's own renderer: your view does not move. No region = whole design (exact framing); `left/right/top/bottom` = close-up crop (framing approximate, margin added). Replaces zoom-and-capture for visual checks. |
| `editor_undo` / `editor_redo` | EasyEDA history step(s) on the active PCB (= Ctrl+Z / Ctrl+Y), with before/after board fingerprint (`applied` vs `no-change`). Document-wide, so refused while other agents hold leases (orchestrator: `override_leases`). |
| `editor_cancel_command` | Back to the select tool (= Esc): ends a stuck routing/placement/drawing mode. Bypasses the request queue. Does not close dialogs. |
| `pcb_create_board_outline_pours` | Create one or more pours from the actual BoardOutline loop, matching manual “Use Board Outline”. Omit `pours` for Inner1=GND, Inner2=+3.3V, Top=GND, Bottom=GND. |
| `pcb_create_pour_from_outline` | Alias for `pcb_create_board_outline_pours`; kept under the wishlist name for agents. |
| `pcb_create_board_pour` | Copper pour bounded by the board-outline bbox minus an inset (default 20 mil). For exact outline pours, use `pcb_create_board_outline_pours`. |
| `pcb_connectivity_status` | Real per-net connectivity from the copper graph: `connected` / `incomplete` (with `padGroups`, `floatingCopper`) / `pour_dependent` / `unrouted` / `single_pad`. |
| `pcb_manage_rule_config` | Get/save/rename/delete DRC rule configs. |
| `pcb_manage_net_rules` | Net-rules / net-by-net / region rules. |
| `pcb_manage_net_classes` | Net classes (CRUD + add/remove members). |
| `pcb_manage_diff_pairs` | Differential pair definitions. |
| `pcb_manage_equal_length_groups` | Equal-length net groups. |
| `pcb_manage_pad_pair_groups` | Pad-pair length constraints. |

## PCB layer / canvas

| Tool | What |
|---|---|
| `pcb_manage_layers` | Get all / select / show / hide / lock / unlock / set copper count (guarded like `pcb_set_copper_layer_count`, `force` to override; applies immediately) / modify color etc. |
| `pcb_set_copper_layer_count` | Change the copper layer count (2..32, even). Dry-run by default; reducing refuses while the inner layers that would go still carry copper (listed per layer with nets) unless `force`. Verified by re-reading the layer list. |
| `pcb_set_inner_layer_type` | Inner layer SIGNAL ↔ PLANE (+ optional rename). Dry-run by default; SIGNAL→PLANE refuses while the layer has tracks unless `force`. Verified by re-read. Pours and split pours need SIGNAL. |
| `pcb_move_tracks_to_layer` | Move tracks/arcs to another copper layer in place (ids kept) by `trackIds` or `net`+`fromLayer`+`region`; supply `vias` where ends need a layer change. Dry-run by default. Refuses `PAD_LAYER` / `ORPHANED` / `VIA_NOT_AT_ENDPOINT`; warns `VIA_IN_PAD` / `PLANE_CUT`; target-layer clearance `blocking[]`. Commit = modify → read back → per-net pad-group compare; any failure or worse connectivity restores everything (`rolled-back`). |
| `pcb_zoom_to_board` | Fit to board outline. |
| `pcb_refresh_canvas` | Cycle ratline calc + zoom — forces visual redraw when canvas seems stale after batch routing. |
| `pcb_navigate_to` | Center canvas on (x,y). |
| `pcb_navigate_to_region` | Pan to region. EasyEDA's `navigateToRegion` promise never settles, so the call is dispatched and the viewport polled: returns `{dispatched:true, confirmed, viewportBefore, viewportAfter}` and never hangs. `confirmMs` optional (default 1500). |
| `pcb_get_primitive_at_point` | Hit-test a coordinate. |
| `pcb_get_primitives_in_region` | Primitives inside a rect (mil, canvas space). Served from the `getAll*` APIs and bbox-filtered server-side — the SDK's `getPrimitivesInRegion` never resolves. Returns the standard envelope plus `countsByType`, `selectionMode`, and per-item `bbox`. `leftToRight:true` = fully inside, otherwise intersecting; optional `types` (Line/Arc/Pad/Via/Component/String/Fill/Region/Polyline/Pour) and `maxItems` (default 200). Each source is fetched concurrently under its own `sourceTimeoutMs` deadline (default 3000 ms) — some builds never settle `pcb_PrimitiveString.getAll()`, so it lands in `skippedTypes` instead of hanging the whole query. |
| `pcb_canvas_origin` | Get/set the canvas/data origin offset. |
| `pcb_convert_coordinates` | Canvas↔data coordinate conversion. |
| `pcb_clear_selection` | Deselect all. |

## Schematic analyzers (kicad-happy port — Phase 3)

These tools turn the schematic into actionable findings. `sch_extract_design` produces a normalized snapshot once; every other analyzer accepts that snapshot via the `snapshot` field to avoid re-fetching, or fetches fresh if omitted.

| Tool | What |
|---|---|
| `sch_extract_design` | One-shot snapshot: components (designator, MPN, value parsed for R/C/L, footprint, position, deviceClass, pin→net), nets (members + power/ground tagging), stats by deviceClass. `fields` projects the output; `pinIndex` only on request. Foundation for the rest. |
| `sch_analyze_power_tree` | Detects regulators (LDO/buck/boost) by MPN, walks feedback dividers, computes Vout = Vref / (R2/(R1+R2)). Hierarchical — child rails nest under their input rail. |
| `sch_analyze_decoupling` | Per-rail cap inventory, total capacitance, warnings (no caps on a power rail, fewer caps than IC pins on the rail). |
| `sch_analyze_passive_networks` | RC filter detection (computes fc), voltage divider (computes ratio + mid net), crystal load caps (computes effective CL). |
| `sch_analyze_connectors` | Pin count, signal:ground ratio, warnings (no GND pin, ratio >3:1). |
| `sch_analyze_protection` | Fuses/PTCs (with rail), TVS clamps (with protected net), reverse-polarity diodes. |
| `sch_analyze_esd_coverage` | Per-connector audit: every signal pin must have a TVS clamp on its net. Flags gaps. |

## Schematic

| Tool | What |
|---|---|
| `sch_get_all_components` / `sch_get_component` | Component listing / lookup. |
| `sch_get_all_wires` / `sch_get_wire` | Wires. |
| `sch_get_component_pins` | Pins of a component (with current net assignment). |
| `sch_get_netlist` | Full netlist. |
| `sch_set_netlist` | Push a netlist (e.g. after refactoring). |
| `sch_get_connectivity` | Net-by-net connectivity tree. |
| `sch_get_primitive` / `sch_get_primitive_type` / `sch_get_primitive_bbox` | Generic primitive ops. |
| `sch_get_selected` / `sch_get_selected_ids` / `sch_select_primitives` | Selection. |
| `sch_create_component` | Place a component from library. |
| `sch_modify_component` / `sch_delete_component` | Edit / remove. |
| `sch_create_wire` / `sch_modify_wire` / `sch_delete_wire` | Wires. |
| `sch_create_net_flag` / `sch_create_net_port` | Net flags & ports (batch supported). |
| `sch_run_drc` | Schematic ERC. |
| `sch_save` | Save schematic. |
| `sch_import_changes` / `pcb_import_changes` | Cross-import schematic ↔ PCB. `pcb_import_changes`: the Pro API has no options — EasyEDA opens its "Confirm importing changes" dialog ("Also update track's net" ticked by default) and returns no change list. The tool waits `waitMs` (5 s) and otherwise returns `status:"awaiting-gui-confirmation"` without holding the bridge queue; a human must untick "Also update track's net" when components were added, then Apply. |

## Library

| Tool | What |
|---|---|
| `lib_get_all_libraries` | All libraries (system + user). |
| `lib_get_system_library_uuid` | Resolve "system" library UUID. |
| `lib_search_device` | Search by keyword/MPN. |
| `lib_get_device` / `lib_get_device_by_lcsc` | Device lookup. |

## Manufacture

| Tool | What |
|---|---|
| `pcb_export` | Export gerber / bom / pick-and-place / 3D / pdf / netlist / dxf / altium / pads / autoroute_json / autolayout_json / dsn. Saves to `~/.easyeda-mcp/exports/` and returns `{path, fileName, size}` (`inline:true` for Base64 `data`). |
| `pcb_import` | Import autoroute_json / autolayout_json / autoroute_ses (fastroute / FreeRouting result) from base64 data. For `autoroute_ses`, default `strategy:"direct"` parses SES `network_out` and creates Line/Via primitives directly, avoiding EasyEDA's hanging SES importer. Wiring marked `(type protect)` (copper the board already had at DSN export) is skipped unless `includeFixedWiring:true`. `replaceNets` deletes those nets' unlocked tracks/arcs/vias first (pass a reroute result's `replaceNets`). Pass `strategy:"easyeda"` to call EasyEDA's native importer. |
| `pcb_import_file` | Import autoroute_json / autolayout_json / autoroute_ses directly from a local file path. For `.ses`, default `strategy:"direct"`. The direct strategy returns a `measurement` block with the exact conversion formula, skips `(type protect)` wiring unless `includeFixedWiring:true`, and with `replaceNets` deletes those nets' unlocked copper before importing. |
| `pcb_autoroute` | DSN export → router → SES validation/completion analysis → return `.ses` path. EasyEDA Pro's built-in autorouter is **not exposed via the extension API**. `router:"auto"` (default) uses **fastroute** when installed (`bash scripts/install-fastroute.sh` → `vendor/fastroute/fastroute`, or `FASTROUTE_BIN`), else FreeRouting (Java 11+, `vendor/freerouting.jar` or `FREEROUTING_JAR`). With fastroute and `rules:"easyeda"` the board's rules are applied: net classes rebuilt from the Track / Safe Spacing / Differential Pair rules (EasyEDA's exported classes match no net), diff pairs → `--pairs` (gap = pair spacing, skew = pair length tolerance), equal-length groups → `--tune` (`lengthToleranceMm`, EasyEDA stores none), pair nets keep full width at pins, Safe Spacing *Board Outline* → copper-to-edge clearance, layer heights from `layerHeightsMm` or a preset. `diffPairs` / `lengthGroups` override the board's lists. Copper pours are passed as planes (`pours:"planes"`): pads a pour already joins are not routed, and a solid trace-free inner pour becomes a plane layer no signal crosses (calibrated against vias present in both EasyEDA and the DSN). `reroute:"signals"` lets every net without a pour (not in `keepNets`, no locked copper) be ripped up and rerouted; `reroute:"best"` keeps fastroute's version only for nets that come out better (fewer unrouted connections, else length + `viaCostMm` per via lower by `minGainPct`), verified by routing again with every other net fixed; both return `comparison` (per-net before/after) and `replaceNets`, and an import deletes those nets' unlocked copper first, then re-pours (`repourAfterImport`) and runs DRC. `maxTimeSeconds` stops softly and keeps the best result; at `timeoutSeconds` fastroute is stopped and its best checkpoint returned. The result's `rules` block says what was applied and from which rule, `report` lists unrouted connections by net and new clearance violations. By default it does **not** import into EasyEDA. Pass `importMode:"attempt"` only when you want the tool to import too; default import strategy is the direct SES parser. |

### Autoroute result interpretation

`pcb_autoroute` can legitimately return `routingCompletion.status:"partial"`. That means the router produced a useful `.ses`, but some endpoints were not connected by the SES route graph. It is not a tool failure. Import the SES with `pcb_import_file({format:"autoroute_ses", path: sesFile, strategy:"direct"})`, then manually finish the nets in `routingCompletion.manualRouteCandidates`.

fastroute units: fastroute converts mm with the assumption that the DSN is in microns (KiCad's `(resolution um 10)`), and its meanders, pair pieces and margins are hardcoded in mm. EasyEDA's DSN says `(resolution mil 1000)` but is written in 10-mil units, so every fastroute length would be 254× off. `pcb_autoroute` therefore hands fastroute a copy rescaled to real microns (`board.um.dsn`) and scales its SES back to EasyEDA units (`sesFile`); the conversions below apply unchanged. The rescale is a positional whitelist per Specctra keyword; anything numeric it does not know is listed in `warnings`.

Direct SES import measurement conversion:

- EasyEDA DSN exports numeric coordinates in 10 mil units.
- FreeRouting SES stores those DSN numbers multiplied by the SES resolution, normally `(resolution mil 1000)`.
- The direct importer defaults to `coordinateMode:"canvas_to_data"`: first `canvasMil = sesCoordinate / sesResolution * coordinateScaleToMil`, then EasyEDA's own `convertCanvasOriginToDataOrigin` mapping is used to derive the correct data-origin X/Y transform.
- `coordinateMode:"scale_only"` is the manual fallback. In that mode, Y is inverted by default: `yMil = -sesY / sesResolution * coordinateScaleToMil`. Use `yAxis:"same"` only if the SES source already uses EasyEDA signed-Y coordinates.
- Widths and via diameters stay positive: `mil = sesValue / sesResolution * scale`, default `scale = 10`.
- Example scale step: `sesX=104410` → `1044.1 canvas mil`; `sesY=228000` → `2280 canvas mil`; final X/Y are whatever EasyEDA's canvas-to-data transform returns for that canvas point. `sesWidth=1010` → `10.1 mil`; `via circle 2400` → `24 mil`.

## Help and discovery

- `pcb_help("polygon" | "layer" | "viaType" | "compact" | "units" | "primitives" | "timeout")` — inline reference.
- `editor_get_open_tabs` — discover document UUIDs.
- `list_instances` — discover instance IDs when multiple EasyEDA windows are connected.

## Token-saving tips

The server enforces most of this itself. The **response governor** (`src/mcp-server/catalog/response-shaper.ts`):
- rounds floats (4 decimals at magnitude ≥ 1, 6 significant digits below 1) and drops null fields;
- cuts any result over `EDA_RESPONSE_MAX_CHARS` (default 24,000 chars, about 7k tokens) to a same-shaped preview. Long arrays and id-keyed maps keep their first items plus a marker naming the `read_result` call that pages the rest. Nothing is re-queried from EasyEDA. The full result stays available for ~45 min (last 24 results).

On real captured payloads this cut output by 91% (1.03M → 91K chars across the 11 heaviest tools).

1. Page trimmed results with `read_result(handle, path, offset, limit, fields)` instead of re-running the tool.
2. Don't paste a big result back as an argument. Analyzer `snapshot` args accept the `res_…` handle, and a pasted preview is swapped for the full stored value automatically. Better still, omit `snapshot`: extracts are daemon-cached.
3. Batch every tool you plan to use into ONE `describe_tools` call, or skip it: invalid args return the signature.
4. `execute_tool(..., max_chars: N)` raises the budget for one call. `raw: true` returns exact, untrimmed output for scripts. `EDA_RESPONSE_MAX_CHARS=0` disables trimming server-wide.
5. Narrow at the source: `fields`, `filter`, `limit`, region bounds. `pcb_get_routing_context` / `pcb_inspect_area` clamp `maxItems` to 400.
6. Prefer summaries: `pcb_drc_summarize` (10 groups, 5 IDs, 1 sample by default; act on `primitiveIds`, the offending copper — `offenderIds` are DRC error ids) over `pcb_run_drc` (pass/fail unless `verbose`). Use `pcb_connectivity_status` over per-net queries.
7. File outputs: `pcb_export` and `sch_get_netlist` save to `~/.easyeda-mcp/exports/` and return the path (`pcb_export inline:true` for Base64). Files older than 7 days are swept and the folder is capped at 200 files; an explicit `outputDir` is never pruned.
8. Delegate: a subagent absorbs its own tool output and returns a short report (see [MULTI-AGENT.md](MULTI-AGENT.md)).

## Connection model — daemon, locks and work leases

Every MCP server process (one per agent session) connects over a Unix socket to a single local daemon (`~/.easyeda-mcp/daemon.sock`, auto-spawned). The daemon owns the one WebSocket to the EasyEDA extension, so any number of agents share one connection.

- **Inside EasyEDA everything is serial.** The extension's operation gate runs one request at a time, reads included, because the SDK acts on the active tab. Parallel agents overlap their thinking and MCP-side analysis, not EasyEDA calls.
- **Per-document write lock (daemon).** Writes to the same document serialize across all agents and processes. Write classification is shared with the extension (`src/shared/method-classes.ts`, fail-closed: anything not a known read is a write).
- **Work leases (daemon).** A lock covers a single call; a lease covers a whole task. Subagents share their parent's MCP process, so the lease id passed with each call is what tells them apart. While a document is leased, writes without that lease are refused before reaching EasyEDA. Read leases are enforced read-only. Details and orchestration patterns: [MULTI-AGENT.md](MULTI-AGENT.md).

Pass `instance_id` to a tool when more than one EasyEDA window is connected. Single-window auto-selects.

## Environment

| Var | Default | Effect |
|---|---|---|
| `EDA_WS_PORT` | 15168 | First port the MCP server tries to bind. |
| `EDA_WS_PORT_RANGE` | 40 | Number of ports to try (15168..15207). |
| `EDA_MAX_INSTANCE_CONNECTIONS` | 4 | Maximum number of EasyEDA windows/instances this MCP server accepts simultaneously. Exceeding this returns `4002 Too many instances`. |
| `EDA_WS_TIMEOUT_MS` | 120000 | Default per-call bridge timeout for non-fast tools (overridable per-call with `_timeoutMs`). |
| `EDA_WS_QUICK_TIMEOUT_MS` | 5000 | Default timeout override for quick tools (`editor_zoom_*`, `pcb_zoom_to_board`, point/region queries, pad lookup). |
| `EDA_DAEMON_BOARD_CACHE_TTL_MS` | 10000 | Daemon read-through TTL for board snapshot-derived reads when daemon mode is enabled. |
| `EDA_DAEMON_BOARD_CACHE_ENTRIES` | 16 | Max daemon board-cache entries across instances/documents/params. |
| `EDA_DAEMON_BOARD_CACHE_BYTES` | 33554432 | Max daemon board-cache payload bytes before LRU eviction. |
| `EDA_WS_ALLOW_ALL_ORIGINS` | unset | Set `1` to allow non-EasyEDA WS origins (dev only). |
| `maxConnectedAgents`* | 4 | Extension-side cap for simultaneous MCP sockets discovered by EasyEDA. Set in extension user config (`setExtensionUserConfig`) if you need more or fewer concurrent MCP servers. |
| `JAVA_BIN` | `java` | Java binary used by `pcb_autoroute`. |
| `FASTROUTE_BIN` | `vendor/fastroute/fastroute`, then `PATH` | Path to the fastroute binary used by `pcb_autoroute` (`scripts/install-fastroute.sh` installs it). |
| `FREEROUTING_JAR` | `vendor/freerouting.jar` | Path to the FreeRouting jar. |

\* Not an environment variable. Set via extension user config key `maxConnectedAgents` (for extension builds/scripts only).
