# KiCad Happy → EasyEDA MCP Port

Bring the full [aklofas/kicad-happy](https://github.com/aklofas/kicad-happy) feature surface into this MCP server. Implementation is JS/TS only (no Python). EasyEDA's built-in simulator replaces ngspice for the SPICE skill.

Reference bundle: `~/Downloads/aklofas-kicad-happy-2026-04-25T09-42-10.md` (the Python scripts there are the algorithm spec).

---

## Two parallel tracks

This work splits into a **feature track** (porting kicad-happy skills) and an **architecture track** (refactoring the connection model). Tracks land in separate PRs and don't block each other — new analyzer tools are written against the bridge protocol, which the daemon refactor preserves.

## Phase status — Feature track (kicad-happy port)

Consolidated. Paid sourcing dropped (LCSC only — EasyEDA's native distributor).

| Phase | Skill area | Status |
|---|---|---|
| 1 | PCB primitives, DRC, layers, pours | ✅ shipped |
| 2 | Dynamic toolsets, board context, placement, routing helpers | ✅ shipped |
| 3 | Schematic analyzers (power tree, decoupling, passives, connectors, protection, ESD) | ✅ shipped |
| 4 | **BOM + LCSC + Datasheet + Lifecycle + Verification Bundle** — extract/audit BOM, jlcsearch + wmsc.lcsc.com clients, datasheet fetch+cache, EOL/NRND/stock audit, single-ZIP export for external verifier LLMs | ✅ shipped |
| 5 | **EMC pre-compliance (schematic-side, 7 rules) + Thermal (per-component dissipation)** — analyzers + tools shipped, automatically embedded in verification bundle | ✅ shipped (Phase 5a — schematic-side); PCB-side EMC rules deferred until pcb_extract_design exists |
| 6 | SPICE testbench gen → EasyEDA's built-in simulator + Cross-analysis (sch ↔ PCB consistency) + pcb_extract_design (foundation for PCB-side EMC) | 🔜 next |
| 7 | DFM (JLCPCB basic-vs-extended, PCBWay turnkey constraints) + Fab-release-gate + Diff/what-if | pending |
| 8 | kidoc — engineering doc gen (HDD, ICD, design review, EMC report, manufacturing pkg) | pending |

Each phase = one PR. Each phase ships atomic with TOOLS.md update + tag entries in `catalog/tags.ts`.

---

## Architecture track — singleton bridge daemon

### Today's pain (verified in code)

- Every MCP server process spawns its own `WebSocketServer` on a port in 15168..15207 ([bridge.ts](../src/mcp-server/bridge.ts), `startOnAvailablePort`).
- The EasyEDA extension scans the whole range and opens a WebSocket to each MCP server ([ws-client.ts](../src/extension/ws-client.ts), `handleHello` + `pushInstanceInfoToAll`).
- New MCP servers send `newAgent` peer notifications across the port range so the extension picks them up.
- **Per-document write locks live inside each bridge** — so two agents writing the same document via two different MCP processes do **not** actually serialize. Latent corruption bug.
- 4-instance cap per MCP × N MCP processes → reconnect storms when any process dies, stale toasts, heartbeat thrash.

### Target architecture

```
Codex / Claude / scripts          (N agent processes)
        │  stdio MCP
        ▼
MCP server processes              (N, thin — tool schemas + sourcing/file/Java work)
        │  Unix domain socket  (~/.easyeda-mcp/daemon.sock)
        ▼
Singleton bridge daemon           (1 per machine, auto-spawned)
        │  one WebSocket on a fixed port
        ▼
EasyEDA extension                 (1 per browser/window)
        │
        ▼
EasyEDA SDK
```

**Daemon owns**: connection auth, instance registry, per-document write locks (cross-agent now), heartbeat, request routing, log aggregation, datasheet cache (shared across agents).

**MCP processes own**: tool schemas, FreeRouting subprocess, file IO, sourcing API clients, doc-gen pipeline, agent-side state.

**Extension owns**: SDK calls, board snapshot/cache, coordinate transforms, primitive create/edit/delete, screenshots, DRC preflight, dry-run previews. One WebSocket connection. Ever.

### Proposed sub-phases

| Sub-phase | What | Status |
|---|---|---|
| A0 | Daemon scaffold: standalone Node process, auto-spawn from MCP if no daemon detected, lockfile + UDS at `~/.easyeda-mcp/`, version handshake | ✅ shipped |
| A1 | Move WebSocketServer + extension connection management from `bridge.ts` into the daemon. MCP `bridge.ts` becomes a UDS client speaking the same JSON-RPC frames. Extension talks only to the daemon. | ✅ shipped (`src/daemon/index.ts` + `src/mcp-server/daemon-client.ts`) |
| A2 | Move per-document write lock into the daemon — cross-agent serialization for real. | ✅ shipped (`src/daemon/lock-manager.ts`) |
| A3 | Daemon-side instance registry + heartbeat. Subscribers (MCP processes) get pushed `instanceInfo` updates. | ✅ shipped (subscribe `instance_changes`, daemon broadcasts on changes) |
| A4 | Auth: shared secret in `~/.easyeda-mcp/token` (chmod 600), MCP processes prove identity at UDS connect. Prevents random local processes hijacking the daemon. | ✅ shipped (`src/daemon/auth.ts`, constant-time compare) |
| A5 | Daemon log aggregation: rotating log file in `~/.easyeda-mcp/daemon.log`, single source of truth across agents. | ✅ shipped (basic, no rotation yet) |
| A6 | Move shared caches into daemon: datasheet cache, board snapshot cache (read-through, agent-scoped TTL). | partial — board snapshot-derived reads now have a daemon-owned bounded read-through cache keyed by instance + document + version + params; extension also keeps the live SDK snapshot LRU. Datasheet cache is still file-path shared. |
| A7 | Backward-compat shim: `EDA_DAEMON=0` falls back to today's per-MCP bridge for one release cycle. Then remove. | ✅ shipped (`EDA_DAEMON=1` opts INTO daemon, default = legacy bridge) |
| A8 | Work leases for multi-agent / subagent work: daemon-enforced exclusive / shared-scope / read-only leases carried per call (subagents share the parent MCP process, so the lease id is the identity). Write classification unified with the extension (`src/shared/method-classes.ts`, fail-closed); lock keys canonicalized (`uuid` == `uuid@project`); `sch.extract.design` cached. | ✅ shipped (`src/daemon/lease-manager.ts`, `work_lease` tool, [MULTI-AGENT.md](MULTI-AGENT.md), `scripts/multi-agent-lease-smoke.ts`) |

### How to enable

```bash
# In your Claude Code / Codex MCP launch config, add the env var:
EDA_DAEMON=1 node /path/to/dist/mcp-server/index.js
```

The MCP will:
1. Connect to `~/.easyeda-mcp/daemon.sock` over UDS
2. Auto-spawn the daemon if it's not running
3. Authenticate with the shared token at `~/.easyeda-mcp/token`
4. Subscribe to instance changes; tools/calls multiplex through the daemon

The EasyEDA extension only needs to connect to **port 15168** (or wherever `EDA_WS_PORT` points). One connection regardless of how many MCP processes are running. No more port-scan storms; no more N copies of every PCB frame held in memory; per-document write locks now serialize across agents (fixes the latent corruption bug).

### Verification (already done)

Tested in 14:39–14:41: daemon binary builds, UDS auth handshake works, `list_instances` RPC works, MCP `EDA_DAEMON=1` mode connects to daemon, the EasyEDA extension auto-attached to daemon's port 15168 (`Extension 8ea80d57 connected (1 total)` in `~/.easyeda-mcp/daemon.log`).

### Decisions (locked in)

1. **Daemon lifecycle**: auto-spawn on first MCP startup (LSP-style). No install step.
2. **Datasheet cache**: daemon-owned. Shared across agents → cache hit rate goes up, memory footprint goes down (one copy not N).
3. **Windows transport**: `node:net` IPC abstracts UDS / named-pipe. No app code change between OSes.
4. **FreeRouting location**: stays in MCP processes (per-agent, heavy, isolated).
5. **Existing port-scan code**: keep for one release as `EDA_DAEMON=0` fallback (A7), then delete.

---

## Memory-leak / PCB-crash hunt track (M-track)

Symptom: when working on PCB, EasyEDA shows visual artifacts and **EasyEDA + Claude + Codex eventually crash together**. Schematic-only sessions are stable.

The fact that all three crash simultaneously points to coordinated state pressure — most likely the extension's WebSocket fan-out: PCB tools produce huge frames (routing context, screenshots, board snapshots), the extension sends the same frame to every connected MCP server (today's max = 4 per MCP × N MCP processes), and back-pressure isn't handled. V8 heap rises across all consumers.

Top suspects to verify (in priority order):

| # | Suspect | File / area | Fix |
|---|---|---|---|
| M1 | Screenshot PNG buffers held in `pendingRequests` longer than needed; multiple in-flight screenshots compound | `bridge.ts` `pendingRequests`, `pcb_screenshot_*` | Drop response payload from pending entry the moment `handleResponse` resolves; cap concurrent screenshots per agent |
| M2 | Routing-context / board-snapshot fan-out: extension sends N copies of a 1–10MB frame, one per connected MCP | extension `ws-client.ts` send loop; `bridge.ts` `clients` map | **Daemon refactor (A1) deduplicates** — one copy instead of N |
| M3 | Extension-side board cache grows unbounded as PCB writes accumulate | `src/extension/handlers/board-context.ts`, `ws-client.ts` | ✅ bounded LRU keyed by document UUID + mutation version; central PCB-write invalidation |
| M4 | Heartbeat timer in extension not cleared on close → handle leak per reconnect | `ws-client.ts` heartbeat | Audit `closeWs` / `dropConnection` paths to confirm `clearInterval` runs |
| M5 | Peer-notification probes leak sockets if `error` fires before `close` | `bridge.ts` `notifyPeers` | Already has `cleanup()` but verify all paths terminate the WebSocket |
| M6 | Pour / repour / autoroute queue grows if user spams while a job is running | `pour-fill-tools.ts`, `manufacture-tools.ts` autoroute | Reject new request if same-doc job in flight |
| M7 | Large tool responses (`pcb_get_routing_context`, `pcb_get_footprint_map`) allocate a giant string per call; if agent calls in a loop, fragmentation explodes | tool wrappers returning `JSON.stringify(result)` | partial — board-context/extract reads can now be served from a bounded daemon cache; streaming/pagination still pending |

Sub-phases:

| # | What | Status |
|---|---|---|
| M0 | Add memory instrumentation: `process.memoryUsage()` snapshots logged every 30s in MCP + extension; `--memprofile` flag dumps heap snapshots on demand | pending |
| M1 | Audit `pendingRequests` cleanup paths; ensure timers + payloads are dropped on every error/close path | pending |
| M2 | Bound screenshot concurrency (max 1 in-flight per agent), drop payload from request map after delivery | pending |
| M3 | Bounded LRU caches in extension handlers (`board-context`, `trace-obstacles`, `routing`) — eviction by size + age | partial — `board-context` now uses document/version LRU; `trace-obstacles` and `routing` still use live SDK queries |
| M4 | Verify heartbeat timer + peer probe cleanup; add explicit `WeakRef`/`finalizationRegistry` on long-lived objects | pending |
| M5 | Pre-emptively land daemon A1 to deduplicate fan-out (this likely eliminates the multi-process correlation in crashes) | pending |

---

## Architectural conventions

**Source of truth for live design data**: WebSocket bridge to the EasyEDA Pro extension. Don't parse `.epro` files — query via bridge handlers in `src/extension/handlers/`.

**Snapshot-first analyzers**: like Phase 3, every analyzer accepts an optional `snapshot` argument from `sch_extract_design` (or a new `pcb_extract_design`). One round-trip → many analyses.

**Tool layout**:
- `src/extension/handlers/<area>.ts` — runs inside the EasyEDA extension, talks to the live editor
- `src/mcp-server/tools/<area>-tools.ts` — MCP tool wrapper, validates args with zod, calls bridge
- `src/mcp-server/index.ts` — register the new toolset
- `src/mcp-server/catalog/tags.ts` — tag entries so dynamic toolsets surface them

**Pure analyzers** (BOM, EMC, thermal, lifecycle) live in `src/mcp-server/analyzers/<name>.ts` and consume snapshots — no bridge calls. Keeps them unit-testable and side-effect-free.

**Sourcing API clients** live in `src/mcp-server/sourcing/<vendor>.ts` — one client per distributor. Each implements `SourcingClient` interface: `searchByMpn`, `getPricing`, `getDatasheet`, `getLifecycle`.

**Datasheet cache** at `~/.cache/easyeda-mcp/datasheets/<mpn-hash>/` — PDF + extracted JSON + manifest. Reuse across MCP server restarts.

---

## Phase 4 — BOM + LCSC sourcing (next)

**Why first**: builds directly on `sch_extract_design`, LCSC's jlcsearch is free (no auth), highest user value (cost-out, find-replacement workflows).

**New tools**:
- `bom_extract` — produce normalized BOM rows from sch snapshot: `{designator, mpn, manufacturer, value, footprint, supplier, supplierId, deviceClass, qty, dnp}`. Group by MPN. Detect quantity from designator collapsing.
- `bom_audit_gaps` — flag rows missing MPN / footprint / value / supplier; return prioritized fix list.
- `bom_classify_distributors` — detect distributor-prefix patterns in supplier IDs (C\d+ → LCSC, etc.); add canonical `distributor` field.
- `bom_export_csv` — write CSV with merge mode (preserve existing tracking rows like Chosen_Distributor, Notes).
- `sourcing_lcsc_search` — query jlcsearch by MPN or LCSC C-number; return `{stock, price[qty=1,10,100,1000], packageType, datasheetUrl, lifecycle, basicPart}`.
- `sourcing_lcsc_enrich_bom` — for each BOM row with an LCSC ID (or unambiguous MPN), fill in pricing/stock/lifecycle in one batch call.

**Files**:
- `src/extension/handlers/bom-extract.ts` — pulls designator+MPN+value+footprint+DNP from each component (already half-available via `sch.extract.design`; add quantity grouping and DNP detection)
- `src/mcp-server/analyzers/bom.ts` — pure: gap audit, distributor classification, MPN normalization
- `src/mcp-server/sourcing/lcsc.ts` — jlcsearch HTTP client (no auth), retry + rate-limit, response normalizer
- `src/mcp-server/tools/bom-tools.ts` — tool wrappers
- `src/mcp-server/tools/sourcing-tools.ts` — tool wrappers
- Tag entries: `bom`, `sourcing`

**Out of scope for Phase 4**: paid distributor APIs (Phase 5), datasheet download (Phase 6).

---

## Open questions (resolve before Phase 8 / EMC)

- Does the EasyEDA extension expose copper-pour layer-fill data we can query, or do we need to parse a PCB extract? (Affects ground-plane continuity check.)
- What's the schematic simulation API surface in EasyEDA Pro? Need to know what testbench primitives are available before scoping Phase 10.
- Does EasyEDA report per-component thermal dissipation, or do we need to compute from schematic + datasheets? (Affects Phase 9.)
