# AI Autonomous Routing Plan — closing the gap to tight, DRC-clean boards

> **Direction update (2026-10-05).** The model plans each route itself; the MCP is a precise, transactional, verifying *executor* (`pcb_route_path`, extension v2.1.14). FreeRouting is dropped (0 of 10 runs succeeded), and the in-house pathfinder (R3) is a secondary helper. Evidence from 10.4k real tool calls: 55% of committed copper was ripped up in-session, DRC worsened after 102 of 208 post-commit checks, and obstacle checks were disabled on 224 commits because of false positives (pour outlines and rectangular round pads treated as walls). Those root causes are fixed in v2.1.14, along with rule-true clearances everywhere (the old resolver read the differential-pair spacing 0.152 mm as 0.152 mil); see `docs/TOOLS.md` → Recommended PCB agent workflow.

Goal: an AI agent can take an EasyEDA PCB from rough placement to a tight, fully routed,
DRC-clean board without a human hand-feeding waypoints. Quality target is **hand-drawn
tightness**, not autorouter-loose: traces hug obstacles at minimum clearance, minimal vias,
deliberate-looking placement.

## Where we are (verified 2026-07-02)

**Sensing (good foundation):** full geometry snapshot (components/pads/traces/vias/pours/outline,
mil units, 10s TTL cache), `pcb_connectivity_status` (routed/unrouted/pour_only per net),
`pcb_get_net_worklist` (priority-ranked unrouted nets), native DRC via `pcb_drc_summarize`,
region inspection, screenshots (desktop Electron only, flaky on dense boards).

**Actuation (the bottleneck):** `pcb.route.smart` is a *geometric path builder* (straight
segments + optional 45° snap), **not** a pathfinder — it does not route around obstacles, it
only *detects* collisions after the fact (`enforceTraceObstacles`). Single layer only, no
mid-route layer change, no push-and-shove, no rip-up/retry. Diff pairs are routed
independently (spacing measured, never controlled). Obstacle model misses **pours and
keepouts**. Placement is 4-rotation heuristic + manual `setPosition` only — no global
optimizer — and moves don't reshape routes. EasyEDA SDK cannot autoroute PCBs
(`autoRouting` is schematic-only) and cannot read stackup.

**Net effect:** today the LLM must mentally compute every waypoint per net — slow, error-prone,
capping quality at "loose". The dream needs a real router + placement optimizer under the
tools, with the LLM as **strategist** (net ordering, layer plan, corridor hints, cluster
intent, reviewing DRC/screenshots) rather than geometry engine.

## Design decision: hand-quality in-house router, no Freerouting dependence

Freerouting (Specctra DSN → SES) was considered and demoted to an optional appendix: it routes
on a coarse grid and its push-and-shove leaves detour artifacts it never pulls back in —
structurally incapable of the "tight" goal. Hand-drawn tightness comes from three copyable
behaviors: (1) hug obstacles at minimum clearance, (2) minimize vias/direction changes,
(3) follow ratsnest flow. An A\* router with a tuned cost function plus a **pull-tight
(rubber-band) post-pass** — snap each routed net to the shortest legal 45° path against the
obstacle map, like dragging a trace taut by hand — achieves this (same idea as TopoR /
KiCad's interactive router). And routing tightness is mostly decided by placement, so
placement optimization comes **before** the router.

## Phases

### R1 — Trustworthy sensing & obstacle model (prerequisite, ~small)
1. **Unified `ObstacleMap` analyzer** (`src/mcp-server/analyzers/obstacle-map.ts`): per-layer
   spatial index (R-tree or grid bins) built from a snapshot — tracks, arcs, vias, pads
   (real shapes, not just bboxes), **pours (polygons)**, **keepouts**, board outline as hard
   boundary. Per-net clearance/width pulled from `pcb_manage_net_rules`. Single source of
   truth reused by trace-obstacles, route-cleanup, impedance-apply, the placement optimizer,
   and the router.
2. **Fix the 10-mil unit inconsistency**: `pcb_extract_design` pad coords are in 10-mil units
   while board-context normalizes to mil (`normalizePinToMil`); `pcbDecouplingProximity` has a
   latent bug from this. Normalize everything to mil at the extraction boundary.
3. **`pcb_drc_violations_detailed`**: when EasyEDA omits coordinates, resolve them from the
   offending primitive IDs via the snapshot, so every violation is actionable (coords + nets +
   suggested fix category).
4. **A6 + M3 from KICAD-HAPPY-PORT.md**: daemon-shared board snapshot cache, bounded LRU keyed
   by document UUID+version. Iterative place/route→DRC→fix loops re-read the board constantly;
   this is the perf/stability floor.
5. **Keepout query tool** (`pcb_get_keepouts`).

### R2 — Placement optimizer (the higher-leverage half of "tight")
1. **Cluster extraction** — shipped first slice: `pcb_extract_placement_clusters` derives
   IC/regulator anchors with decoupling caps, immediate shared-net passives, pin-proximity
   targets, cluster HPWL, and loose-component counts from the live PCB placement snapshot.
   Next: enrich with schematic functional-group hints. Reuse schematic analyzers
   (`sch_analyze_decoupling`,
   power tree, functional groups) to derive placement clusters — each IC with its decoupling
   caps, crystal, and immediate passives, with pin-proximity targets (cap near the pin it
   decouples). Humans place in clusters; so should the agent.
2. **`pcb_place_cluster`** — shipped conservative first slice: default `mode:"propose"`
   returns snapped moves for decoupling caps and immediate passives around one anchor, with
   locked-component guards, approximate same-layer courtyard collision checks, before/after
   HPWL/crossing/decoupling score estimates, and `mode:"apply"` using the existing safe
   component-move handler. Next: edge/connector constraints and smarter angular packing.
3. **`pcb_optimize_placement`** — shipped first slice: default `mode:"propose"` runs a
   coordinate-descent optimizer over components, clusters, or mixed groups, minimizing weighted
   HPWL + crossing + decoupling-distance objective with hard guards for locked parts,
   approximate courtyard clearance, board-outline bbox containment, and grid snapping.
   `mode:"apply"` uses the existing safe component-move handler. Next: simulated annealing /
   force-directed cluster moves, alignment aesthetics, and stronger connector/edge constraints.
4. **Auto-rip on move** — shipped first slice: `pcb_set_component_position`,
   `pcb_apply_component_rotation`, `pcb_place_cluster(mode:"apply")`, and
   `pcb_optimize_placement(mode:"apply")` accept `autoRipConnectedTracks`, which deletes
   same-net Line endpoints and vias directly attached to the component's old pad centers and
   returns `rerouteNets`. Next: rip longer contiguous attached route branches and explicitly
   enqueue those nets in a durable worklist.
5. **Placement score report** — shipped: `pcb_score_placement` reports HPWL, crossing count,
   top HPWL nets, and decoupling-distance table before/after — the agent's objective feedback loop.

### R3 — Hand-quality router (Engine: A\* + pull-tight, ~the big TS build)
1. **Multi-layer A\*** over the ObstacleMap: 45°-octilinear search (configurable pitch, e.g.
   2–5 mil), layer-change moves with via cost (checks via clearance on *all* spanned layers),
   net-class width/clearance aware, pours as obstacles (same-net pours free). Cost function
   tuned for hand-drawn character: low cost to run parallel-adjacent to existing traces at
   min clearance (bus hugging), high cost for vias and direction flips.
2. **Pull-tight post-pass** — shipped first slice: `pcb_route_pathfind` now defaults to a
   conservative pull-tight shortcut pass that removes legal 45° grid slack against the same
   cached obstacle model, then still verifies with `pcb_check_trace_obstacles` before commit.
   Next: richer rubber-band shortening against exact obstacle geometry and multi-layer via
   legalization.
3. **`pcb_route_net` / `pcb_route_nets`** tools — shipped first slice: `pcb_route_net`
   routes deterministic nearest-neighbor pad-pair connections for one net through the
   pull-tight pathfinder, simulates accepted segments into the working snapshot, defaults to
   `dryRun:true`, and can commit Line primitives. `pcb_route_nets` walks explicit nets or the
   priority worklist with one shared working snapshot, so earlier accepted net plans become
   obstacles for later nets. Next: richer layer plans / corridor hints, plus LLM review with
   DRC + region screenshots between batches.
4. **Rip-up & retry** (poor man's shove) — shipped first slice: `pcb_route_retry_plan`
   reads a failed route result (or runs a fresh dry route), extracts blocking obstacle nets,
   ranks low-cost rip-up candidates, and returns reviewed delete/reroute sequences without
   mutating. Next: guarded apply mode with iteration caps and irreducible-conflict region
   screenshot hints.
5. **True diff-pair routing**: route a single centerline with the pair treated as one fat
   probe, then offset ± gap/2; integrate existing serpentine length-match at the end.
   Replaces "route independently, measure after".
6. **Fanout planner**: multi-pad escape routing for connectors/QFN (ordered stub+via fanout
   that doesn't self-collide), replacing single-pad `autoFanout`.

### R4 — Closure loop & tightness passes
1. **`pcb_route_and_verify` orchestrator** — shipped first slice: runs `pcb_route_nets`,
   then after committed routes refreshes the board snapshot and returns selected-net
   connectivity, compact DRC groups, verdict, and next actions. Next: fold in cluster
   placement → global optimize → power fanout → route worklist → geometry cleanup → pour
   rebuild → fix loop until clean or blocked, per-iteration budget, final report (unrouted,
   violations, HPWL, lengths, skews).
2. **Tightness passes**: track length/skew report per net-class, GND stitching-via placer,
   optional teardrops.
3. **Verification UX**: region screenshots on desktop after each phase; on web fall back to
   `pcb_inspect_area` + DRC deltas.

## Sequencing & effort

| Phase | Depends on | Effort | Payoff |
|---|---|---|---|
| R1 | — | ~2-3 sessions | Every downstream feature; fixes latent unit bug |
| R2 | R1 | ~3-4 sessions | Tightness is mostly decided here; usable standalone |
| R3 | R1 (R2 strongly recommended first) | ~4-6 sessions | Hand-quality per-net routing |
| R4 | R2+R3 | ~2-3 sessions | Autonomous closed loop, the actual dream |

## Appendix: optional Freerouting escape hatch (deferred)
Snapshot→Specctra DSN export + headless Freerouting JAR + SES import remains a possible
"just make it connect" fallback for very dense boards, but is explicitly **not** the quality
path (grid slack, shove artifacts). Only build if R3 proves insufficient on some board class.

## Risks / open questions
- A\* grid memory on large boards — tile the ObstacleMap, route in a corridor window first.
- Pull-tight correctness near arcs/odd pad shapes — start with segment approximation.
- SA placement runtime on 300+ component boards — cluster-level moves keep the state space small.
- EasyEDA fill-engine hangs on pour rebuild (known 60s timeout) — keep pour rebuild last in loop.
- DRC coordinate availability varies by rule type — R1.3 mitigation covers it, but audit per rule.
