# Capability test run — extension v2.1.15

A scripted live run that exercises everything shipped on 2026-10-05, in dependency order. Each step lists what must be true; a failure in an early step explains failures later, so stop and fix there.

**Safety first:** export a native backup of the PCB (`document_export_native_source`) before step 3. Run on `PCB_COMPACT` or a copy of it. Don't save until the end; everything here is undoable.

## 0. Install and health

1. Import `build/dist/easyeda-agent-mcp-server_v2.1.15.eext`, then click **Connect Claude**.
2. Restart the daemon (`kill $(cat ~/.easyeda-mcp/daemon.pid)`) and start a **new** agent session.
3. `server_info` must show `daemon.stale: false` and `bridgeGeneration` = the v2.1.15 marker.
4. `pcb_repour_status` → `nativeHost.via` is non-null, and `tabBar`, `windowBridge`, `copperSource`, `messageBus` are all true. If this fails, the native features (repour, copper status, undo, render) fail loudly by design; routing still works.

## 1. Read the truth

| Step | Pass criteria |
|---|---|
| `pcb_copper_status` | One row per pour; after Shift+B, all four GND pours have `hasCopper: true` and islands > 0 |
| `pcb_connectivity_status` | Statuses are `connected` / `incomplete` (with `padGroups`) / `pour_dependent`; no `routed` |
| `pcb_drc_summarize` | Groups carry `primitiveIds` (e.g. `e2463`), not only `err…` ids |
| `pcb_extract_design`, then the SCH↔PCB cross-check | PCB parts now carry `mpn` (from the footprint's manufacturer id), so the MPN-mismatch rule (XREF-003, critical) can fire for the first time: check each hit is a real mismatch, not a field-format difference |
| `pcb_get_routing_context` / a dry-run route | `clearanceSource` is a real rule (`rule:…`), the value is plausible in mil (≈4–8), and `clearanceByKind` is present |

## 2. Native editor

| Step | Pass criteria |
|---|---|
| `pcb_render_image` (no region) | Whole board; your EasyEDA view did not move |
| `pcb_render_image` with a 300 mil region around a known part | That part is inside the frame (validates the approximate crop mapping) |
| `pcb_repour_all` (default native) | `status: completed`, per pour `rebuilt`/`up-to-date` with `copper.islands`; Ctrl+Z in the GUI reverts it as one step |
| `editor_cancel_command` while a routing tool is active | Editor returns to select mode |
| `editor_undo` then `editor_redo` after a harmless edit | `applied` both times, board restored; a second redo gives `no-change` |

## 2b. Coordinate spaces (pour / keepout outlines) — before any routing

The old bug log (pcb_v1_1_work/EASYEDA_MCP_BUGS.md #9/#16) showed live that polygon sources are Y-down (a plain sign flip vs tracks/pads). v2.1.15 applies that to keepouts and pours in the obstacle checker and pathfinder; until now keepouts there were mirrored about y=0. Confirm before trusting any routing step.

| Step | Pass criteria |
|---|---|
| `pcb_get_all_pours` bbox of one pour vs its `pcb_copper_status` bbox | Same region of the board (not mirrored in Y). Outlines are read Y-down from the data origin and mapped to canvas; obstacle checks and the pathfinder now use that mapping too |
| `pcb_check_trace_obstacles` with a segment crossing a known pour of another net (and a keepout, if the board has one) | The plane-cut warning / keepout blocker appears for that segment, and not for the same segment mirrored in Y |

## 3. Routing executor

| Step | Pass criteria |
|---|---|
| `pcb_route_path` dry-run of one 2-pad connection | `dry-run`, legs exactly as planned, `clearance` from the rule |
| Same with `dryRun:false`, `requestId` | `committed`, `verify.routes[0].joined: true` (proves EasyEDA returns just-created copper immediately; if this rolls back with "does not reach", the verifier needs a re-read delay) |
| Repeat the same call | `replayed: true`, no new copper |
| Route through an obstacle | `blocked`, naming leg, obstacle, gap, required clearance; nothing created |
| A section: 3–5 routes in one `routes:[…]` call, incl. one layer change | One transaction, all `joined`; `verify:"drc"` reports `newViolations: 0` (stale connection/pour errors listed separately) |
| `pcb_move_via` on a via of that section | `moved`; its tracks follow; read-back matches; net still connected |
| Rip-up + reroute with `pcb_batch_edit` (deletes + creates, `dryRun:false`) | `committed: true`; the deleted copper did not block the new one |
| `pcb_repour_all`, then `pcb_drc_summarize` + `pcb_connectivity_status` | Section nets `connected`; no new real violations |
| Right after a committed route, `pcb_drc_summarize` grouped by net | Record whether EasyEDA still reports "Connection Error" for the just-routed net (its connection graph is believed stale after API edits until reload). Our copper-graph verdict is independent of this; the result decides whether a connectivity-refresh step is worth building |

## 3a. Pairs and length

| Step | Pass criteria |
|---|---|
| `pcb_route_pair` dry-run on a USB D+/D− pair with a 2–3 point centerline | `dry-run`; `pair` values sourced from the Differential Pair rule (or reported as required); `gap.coupled` equals the rule; skew reported |
| Same with `dryRun:false`, `requestId` | `committed`, both nets `joined`; `measured` lengths present; a GUI DRC shows no pair-spacing errors on it |
| `pcb_length_tune` `matchPartner` on the shorter net's straight leg | `dry-run` plan, then `committed` with the re-measured path grown by the plan (within tolerance); or a clean refusal (`insufficient-space`, `LEG_NOT_ON_PATH`) with attempts |

## 3b. Layers

| Step | Pass criteria |
|---|---|
| `pcb_get_layer_status` | Only used layers + 1/2/11/12; `omitted` count present |
| `pcb_layer_report` (summary, then `detail:"nets"`) | Roles match what you see (e.g. bottom = flood/plane with GND); plane cuts listed with nets; recommendations plausible; `copperIslands.available: true` |
| `pcb_set_inner_layer_type` dry-run on a 4-layer copy | `dry-run` with the refusal/force logic as described; `dryRun:false` re-reads the new type |
| `pcb_move_tracks_to_layer` dry-run, then commit, on one short track whose ends are on vias or TH pads | `moved`, same primitive ids, net still connected. If EasyEDA ignores a layer change via `modify`, it must come back `rolled-back`/`not-verified`, never `moved` |
| `pcb_set_copper_layer_count` dry-run 4→2 on a board with inner copper | `refused`, listing the copper per inner layer |

## 3c. Split pours

| Step | Pass criteria |
|---|---|
| `pcb_plan_split_pours` `split:{axis:"x", at:<board mid>, nets:["+3V3","GND"]}` on an inner/bottom SIGNAL layer | `dry-run`; regions on the board, `gapMil` from the rule; `PAD_IN_FOREIGN_REGION` lists pads on the wrong side |
| `pcb_create_split_pours` same args (on a copy) | `committed`; each pour's outline read back in place (not mirrored: if the tool reports it had to redo a create in data coordinates, record it); per pour islands > 0 and pads reached; Ctrl+Z / `editor_undo` removes them |
| Same on a PLANE-type layer | `invalid` with `LAYER_IS_PLANE` and the `pcb_set_inner_layer_type` hint |

## 4. Documents

| Step | Pass criteria |
|---|---|
| `editor_open_document` schematic page ↔ PCB, several times | Every call succeeds; `alreadyActive` when it was; gate never `reconciliation-required` |
| A PCB/SCH tool with `document` of the other type | Activates and runs; no "Active document changed" error |

## 5. Multi-agent

| Step | Pass criteria |
|---|---|
| `work_lease` read leases + 3 `eda-reviewer` subagents (EMC, power, DFM) in parallel | All finish; daemon log shows one extract per document (cache) |
| 2 `eda-worker`s with shared leases on disjoint net scopes, routing in parallel | Both commit; a write without a lease into the leased PCB is refused; `work_lease list` shows `tabSwitches` |

## 6. Tokens

Compare response sizes against the 2026-10-05 baseline: no single result over ~24k chars without a `_truncated.handle`, and `read_result` pages it.

## Record

For each step: pass/fail, the exact tool output on failure, and wall time. Record wall time for `pcb_route_path` (especially `verify:"drc"`), `pcb_move_via`, `pcb_move_tracks_to_layer` and `pcb_create_split_pours`. They size their verification to the gate deadline; a `committed-unverified` with `skipped:"deadline"` means the board is too slow for full verification in one call — note how often it happens. Failures feed straight back into fixes before the next run.
