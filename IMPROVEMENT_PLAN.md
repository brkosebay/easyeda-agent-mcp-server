# EasyEDA Agent MCP — Improvement & kicad-happy Port Plan

Captured 2026-04-25 after routing the Metrix Control Unit PCB hit limits in the v1.0 server.

## Objectives

1. **Fix v1.0 sharp edges** documented in the improvement log (vias, polygons, layer names, DRC summarization, autoroute).
2. **Port kicad-happy analyzer suite** so EasyEDA Pro designs get the same review depth as KiCad designs.
3. **Bundle FreeRouting** so the round-trip DSN→SES happens without leaving the MCP client.

## Phase 1 — v1.0 Bug Fixes & DX (week 1)

| Item | Fix | Tool surface |
|---|---|---|
| Polygon format opaque | Document `R cx cy w h 0 0` and `L x y x y...` examples; accept `{points: [{x,y},...]}` shape and convert. Add `pcb.MathPolygon` helpers. | `pcb_create_pour`, `pcb_create_fill`, `pcb_create_region` |
| Via units broken | Hard-code valid EasyEDA via mappings; add `pcb_create_via_mm({diameter_mm, drill_mm})` that returns post-create geometry; reject invalid pairs upfront. | new `pcb_create_via_mm`, `pcb_set_via_size_table` |
| Layer name confusion | Normalizer: accept `1`/`"1"`/`"TopLayer"`/`"Top Layer"`; resolve via layer manager. | shared util in `pcb-primitive-tools.ts` |
| `pcb_create_polyline_track` ghost tracks | Default to `pcb_create_track` (real Line primitives). Mark polyline_track as legacy. | tool description tag |
| 60s client timeout on imports | Add `pcb_import_async` returning a job-id, with `pcb_get_job_status`. Bridge `WS_TIMEOUT_MS` env var. | new async path |
| Manual cleanup before autoroute | `pcb_delete_tracks_by_filter({net,layer,class,preserveLocked})` | new tool |
| Pad lookup by ref+pin | `pcb_get_pad({reference, padNumber})` returns `{x,y,layer,net}` directly. | new tool |
| Manhattan multi-segment routes | `pcb_route_orthogonal({fromPad, toPad, layer, width, jogX|jogY})` emits real Line primitives. | new tool |
| Cap response noise | Add `compact:true` flag on every `*_get_*` and `*_create_*` to return only id+key fields. | parameter on all read/write tools |

## Phase 2 — DRC, FreeRouting, SES (week 2)

| Item | Fix |
|---|---|
| DRC summarizer | `pcb_drc_summarize` groups by category × net × component, returns top-N with primitive IDs. |
| Pour rebuild | `pcb_repour_all` (calls EasyEDA `pcb_PrimitivePour.repour`). |
| Connectivity vs unrouted | `pcb_connectivity_status` distinguishes pour-connected pads from genuinely unrouted. |
| Mounting hole helper | `pcb_replace_with_npth({reference, drill_mm, keepout_mm})` for plated→non-plated holes. |
| FreeRouting bundled | Vendor `freerouting-2.x.jar` under `vendor/`. Detect Java; new `pcb_autoroute({preserveLocked, ratLineLimit, timeoutS})` that exports DSN, runs Java, imports SES, runs DRC, returns unrouted count. |
| SES parser fallback | Pure-TS SES parser → call `pcb_create_track` per segment with **numeric layer strings** (per the log). Recreates 833/838 success path. |
| Backup-on-import | Snapshot tracks/vias before SES apply; revert on failure or DRC delta beyond threshold. |

## Phase 3 — kicad-happy Analyzer Port (weeks 3-5)

**Strategy:** ship Python scripts under `python/` in the extension folder, call via `child_process` from TS. Avoids reimplementing 50k+ lines. Python deps: `python>=3.10` and stdlib only (kicad-happy is zero-dep).

Tools to add (1:1 with kicad-happy commands):

- `pcb_analyze_layout` (DFM, copper presence, via fanout, trace impedance, thermal pad vias)
- `sch_analyze_design` (BOM, decoupling, ERC, power tree, regulator detection, diff pairs)
- `analyze_cross` (sch↔pcb sync, ESD coverage, decoupling distance, connector current)
- `analyze_emc` (44-rule pre-compliance score)
- `analyze_thermal` (Tj from package θJA + via correction)
- `simulate_subcircuits` (ngspice — RC filters, dividers, opamps, decoupling, inrush)
- `lifecycle_audit` (DigiKey/LCSC/Mouser/element14)
- `what_if({ref, value})` parameter sweep
- `diff_analysis(prevRunId, currRunId)` for git-style design diffs
- `analysis_cache` — manifest.json under `analysis/<run_id>/`

EasyEDA-specific bridge: extract sch + pcb to a temp KiCad-compatible JSON via `pcb_export({format:'kicad'})` and `sch_get_netlist`, then feed kicad-happy. Where EasyEDA gives more direct data than KiCad (e.g. live net length), prefer the native call.

## Phase 4 — Visual verification (high priority)

- `pcb_screenshot({region?, layers?, scale?})` — grabs the PCB canvas via `canvas.toDataURL('image/png')` from the extension's DOM context, returns `{mimeType:"image/png", base64}`. Claude renders it inline. Need to reverse-engineer the EasyEDA Pro canvas selector via dev tools.
- `pcb_screenshot_pdf` fallback — uses `eda.pcb_ManufactureData.getPdfFile()` (already shipped in the EasyEDA API), then server-side `pdftoppm` to PNG. No DOM hack needed.
- `sch_screenshot` — same approach for schematic editor canvas.
- API discovery cheat: full surface in `node_modules/@jlceda/pro-api-types/index.d.ts` (35K lines). `eda.pcb_*`, `eda.sch_*`, `eda.sys_*`, `eda.lib_*`. Use `grep -nE "^declare class PCB_"` + `sed -n '/class X/,/^}/p'` to enumerate methods.
- `bringup_doc_generate` → produces a BRINGUP.md from analyzer findings (mirrors kicad-happy `kidoc_scaffold`).
- Datasheet sync via DigiKey API caching to `datasheets/`.

## Acceptance / smoke tests

For each tool, add a Vitest test against a fixture EasyEDA project. The `vendor/test_project/` should be the Metrix Control Unit (after we finish routing it) so future regressions surface immediately.
