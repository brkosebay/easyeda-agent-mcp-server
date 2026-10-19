# Multi-agent EasyEDA work

How to run several agents (Claude Code subagents, Codex, scripts) against one EasyEDA instance without them corrupting each other's work, and how much faster it actually gets.

## What parallelism buys

EasyEDA's SDK acts on the **active tab**, so the extension runs every request one at a time, reads included (`createNativeOperationGate` chains everything on one queue). N agents never make EasyEDA itself faster.

What they do overlap:

- **LLM think time.** This dominates. A typical agent turn is seconds of reasoning around ~100 ms of EasyEDA work, so the EasyEDA queue sits idle most of the time with one agent.
- **MCP-side compute.** Analyzers (EMC, power tree, thermal, BOM, functional review), sourcing APIs, datasheets and docgen run in the MCP process, fully in parallel.
- **Context.** Each subagent absorbs its own tool output and returns a short report. The orchestrator's context stays small, which is the main fix for agents that keep compacting.

Rule of thumb: review fan-out scales well (5+ reviewers are fine). Concurrent writers saturate the single EasyEDA thread quickly, so keep them to 2–3.

## Safety layers

| Layer | Scope | Where |
|---|---|---|
| Operation gate | One EasyEDA call at a time; quarantine after a timed-out write | extension, `native-operation-gate.ts` |
| Per-document write lock | One write per document at a time, across all agents | daemon, `lock-manager.ts` |
| **Work lease** | One *task* owns a document (or a declared slice) | daemon, `lease-manager.ts` |

Locks are per call: two agents can take turns on the lock and still undo each other's work. Leases close that gap.

### Why leases are explicit tokens

Claude Code subagents run inside their parent's MCP server process. Verified: a subagent's call creates no new daemon connection. To the daemon, all subagents of a session are one agent. So identity is the **lease id** the caller passes with each call (`execute_tool(…, lease="lease_…")`). An `AsyncLocalStorage` context carries it from `execute_tool` to every bridge call the tool makes.

### Lease rules (enforced in the daemon before a request reaches EasyEDA)

| Situation | Result |
|---|---|
| No leases on the instance | Unchanged behaviour. Single-agent sessions never claim anything. |
| Write with a lease, document in the lease | Allowed. Omitting `document` targets the leased one, never "whatever tab is active". |
| Write with a lease, different document | Refused. |
| Any write under a `read` lease | Refused (enforced read-only reviewers). |
| Write without a lease into a leased document | Refused, with the holder named. Reads are always allowed. |
| Write without a lease and without `document` while any lease is active | Refused. The active tab may belong to another agent. |
| `native_operation_reset` / `reconcile` while leases exist | Refused for lease holders. The orchestrator must pass `override_leases: true`. |
| Lease idle for its TTL (default 15 min), or the claiming MCP process disconnects | Lease released. |

Modes:

- `exclusive`: the sole writer on its documents.
- `shared`: several writers on one document, each declaring `scope` (nets / designators / pages / region). Overlapping claims are refused. The scope is **advisory after the claim**: the daemon cannot see which nets a write touches, so DRC/ERC is the merge gate.
- `read`: enforced read-only, with no document required.

## Patterns

The orchestrator's playbook lives in the `eda-parallel` skill (`.claude/skills/eda-parallel/SKILL.md`). Subagent roles: `.claude/agents/eda-worker.md` and `.claude/agents/eda-reviewer.md`.

1. **Review fan-out.** N `eda-reviewer`s, one per dimension, under read leases. Zero write risk. The daemon caches `sch.extract.design` / `pcb.extract.design`, so N reviewers cost EasyEDA one extract.
2. **Plan in parallel, apply serially.** Workers under read leases return edit plans; the orchestrator applies them, ideally via `pcb_batch_edit`.
3. **Partitioned writers.** Each `eda-worker` gets an exclusive lease on its own document, or a shared lease with a disjoint scope on a common one. The orchestrator runs DRC/ERC on the whole document at the end, then releases leases and saves.

## Tab thrash

When agents work on different documents, every alternating call makes EasyEDA switch tabs and re-render the canvas. That costs time, and it is GPU load on an app with a history of GPU resets. `work_lease {action:"list"}` reports `tabSwitches` vs `rpcs` per instance. If the ratio is high, put workers on the same document (shared scopes) or serialize them. Daemon-side document-affinity scheduling is deliberately not built yet; measure first.

## Limits

- Leases require daemon mode (the default) and dynamic toolsets (the default). With `EDA_DAEMON=0`, `work_lease` and `lease` return an error rather than silently not enforcing.
- Leases live in daemon memory. A daemon restart drops them, and workers then get "unknown or expired" and stop.
- A lease does not make a sequence of calls atomic. Another agent can write to *other* documents in between, and reads of a document leased to someone else can be stale a moment later.
