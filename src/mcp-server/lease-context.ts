// Carries the caller's work lease from `execute_tool` down to every bridge
// call the tool makes, without threading a parameter through 200+ handlers.
// AsyncLocalStorage follows the promise chain, so concurrent tool calls from
// different subagents (same MCP process) each keep their own lease.

import { AsyncLocalStorage } from 'async_hooks';

export interface LeaseCallContext {
	leaseId?: string;
	/** Orchestrator escape hatch: run despite other agents' leases. */
	overrideLeases?: boolean;
}

export const leaseContext = new AsyncLocalStorage<LeaseCallContext>();

let leasesSupported = false;

/** Set by the server bootstrap: only the daemon transport enforces leases. */
export function setLeaseSupport(supported: boolean): void {
	leasesSupported = supported;
}

export function leaseSupportError(): string | undefined {
	return leasesSupported
		? undefined
		: 'Work leases need daemon mode (the default). This MCP server runs with EDA_DAEMON=0, so a lease would not be enforced — remove EDA_DAEMON=0 from its launch config.';
}
