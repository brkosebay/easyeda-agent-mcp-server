# Changelog

Versions follow the extension package (`extension.json`). Earlier history is in the git log.

## 2.1.21 — 2026-10-19

First public release. Adds support for EasyEDA Pro 3.x; details in
[docs/EASYEDA-3X-MIGRATION.md](docs/EASYEDA-3X-MIGRATION.md).

### EasyEDA Pro 3.x compatibility (verified on 3.2.206)
- Bridge handshake works without `crypto.subtle`, using a pure-JS HMAC-SHA256 fallback. Misleading "different token"
  hints now appear only on a real token mismatch.
- Component-pin coordinates (10-mil on 2.x, mil on 3.x) are detected at runtime. Before this, 3.x pad positions were
  10× off and every routed net looked broken.
- `pcb_save` refuses to save when the requested PCB isn't the active one, because 3.x `save()` ignores its uuid.
- Physical stackup reads report `supported:false` (the 3.x getter is a stub) instead of throwing.
- The schematic netlist is read through the fast manufacture export, with both netlist formats handled (2.x `pins`,
  3.x v2.0.0 `pinInfoMap`). Schematic pin, trace-net, connectivity and BOM tools no longer stall for minutes.
- `sch_get_all_wires` net filtering is done client-side; the 3.x native filter returns nothing.
- `engines.eda` widened to `>=2.3.0`.

### Bridge and release
- The bridge generation now comes from the extension version, so an in-place upgrade always replaces the previous
  bundle's socket handlers.
- A stale probe timer can no longer close a newer socket that reuses the same WebSocket id.
- Release builds (`npm run build:release`) embed no local paths. The extension derives `~/.easyeda-mcp/token` at
  runtime from the Documents folder.

### Added
- Experimental `pcb_native_autoroute` / `pcb_native_auto_job_status` for EasyEDA's built-in autorouter
  (3.2.150+). It is fire-and-verify and **not yet live-tested**.
- Local daemon with HMAC-authenticated native channel, document locks and multi-agent work leases.
- Analyzers: functional review, EMC, BOM semantics, thermal, placement review, impedance.
- Routing: `pcb_route_path` exact execution with verification, route pairs, length tuning, split pours.
- Dynamic toolsets (three meta-tools) by default.
