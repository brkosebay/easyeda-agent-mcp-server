---
name: eda-parallel
description: Orchestrate several subagents on one EasyEDA design safely — parallel reviews, parallel planning, or partitioned parallel edits guarded by daemon work leases. Use when the user wants EasyEDA work done faster with subagents, a multi-dimension design review, or several boards/pages/net groups worked on at once.
---

# Parallel EasyEDA work

EasyEDA runs every request one at a time. Parallel agents speed things up by overlapping *thinking* and MCP-side analysis, not by speeding up EasyEDA. Pick the safest pattern that fits:

| Pattern | When | Risk |
|---|---|---|
| **A. Review fan-out** | Design review, audits, BOM/sourcing, "what's wrong" | None. Read-only leases are enforced. |
| **B. Plan in parallel, apply serially** | Edits that interact (placement, dense routing) | Low. Only you write. |
| **C. Partitioned writers** | Independent work: different documents, or disjoint net/part groups | Medium. Scope is checked at claim time only, so DRC/ERC is the merge gate. |

Keep at most **2–3 concurrent writers**. More just queue on the same EasyEDA thread and hit the 60 s lock budget.

## Steps
1. `list_instances` gives you the document UUIDs (PCB, schematic pages). Every lease and every write names a UUID.
2. Claim leases yourself with `work_lease`, then hand the ids out:
   - Reviewer: `{action:"claim", mode:"read", owner:"emc-review"}`. No document needed.
   - Writer on its own document: `{action:"claim", documents:[pcbUuid], owner:"router", task:"…"}` (exclusive).
   - Writers sharing one document: `{action:"claim", mode:"shared", documents:[pcbUuid], owner:"usb", scope:{nets:["USB_D+","USB_D-"]}}`. Overlapping scopes are refused, so re-partition.
3. Spawn every subagent in ONE message, so they run concurrently. Use `eda-reviewer` for A, and `eda-worker` for B (as planners told "plan only, no writes", under read leases) and for C. The prompt template:
   ```
   LEASE: lease_…   DOCUMENT: <uuid>   SCOPE: nets USB_D+, USB_D- / designators U3, R12
   TASK: …          DONE-WHEN: … (e.g. nets routed, DRC clean within scope)
   ```
4. While they run, do not write into a document you leased out. Your own lease-less writes there are refused. If you must, pass `override_leases: true`.
5. Merge gate: run `pcb_drc_summarize` / `sch_drc_summarize` across the whole document. Fix cross-scope conflicts yourself or with one more worker.
6. Release: `work_lease {action:"release", all:true}`. Then save (`pcb_save` / `sch_save`). Only you save.

## Recovery
- A worker reports a timeout or "requires reconciliation": the shared operation queue is wedged for everyone. Check `native_operation_status`. Recovery tools are refused while leases exist. Release them, or pass `override_leases: true` once you've looked.
- While leases exist, writes without a lease must name a `document`. `editor_open_document` takes `documentUuid`, so it is refused too. Pass `override_leases: true` if you really need to switch tabs under running workers.
- A dead or abandoned worker's lease expires after 15 idle minutes. Release it now with `work_lease {action:"release", lease_id}`.
- `work_lease {action:"list"}` shows live leases and `tabSwitches` / `rpcs`. A high ratio means workers on different documents are flipping EasyEDA tabs. Each switch re-renders the canvas, which is heavy on the GPU. Serialize those workers, or give them the same document with shared scopes.

## Token budget
Subagents keep their tool output out of your context. That is half the win, so make them report in ≤15 lines and never paste JSON. Don't re-read what they changed. Trust their report plus the DRC merge gate. Results over ~24k chars come back trimmed with a `read_result` handle, and handles work across subagents: they share one MCP process. A worker can pass a handle up in its report instead of data.
