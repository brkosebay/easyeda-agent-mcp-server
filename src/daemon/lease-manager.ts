// Work leases — the coordination layer for running several agents (or
// subagents) against one EasyEDA instance at the same time.
//
// The per-document LockManager only serializes individual RPCs; it says
// nothing about *tasks*. Two agents can each hold the lock in turn and still
// trample each other's work (one re-places parts the other is routing to).
// A lease reserves a document (or a declared slice of one) for a task:
//
//   exclusive — sole writer on the documents. Default for workers.
//   shared    — several writers on one document, each declaring a scope
//               (nets / designators / region / pages). Claims with overlapping
//               scopes are refused. Scope is checked at CLAIM time only — the
//               daemon cannot see which nets a write touches, so DRC/ERC is
//               the merge check.
//   read      — an enforced read-only token for reviewer agents: any write
//               carried under it is rejected.
//
// Leases are bearer tokens. Claude Code subagents share their parent's MCP
// process (one daemon connection), so the daemon cannot tell them apart by
// socket — the lease id passed with each call is the identity.

import { randomBytes } from 'crypto';

export type LeaseMode = 'exclusive' | 'shared' | 'read';

export interface LeaseScope {
	nets?: string[];
	designators?: string[];
	pages?: string[];
	/** Board-space bounding box (same units as the PCB tools). */
	region?: { x1: number; y1: number; x2: number; y2: number };
}

export interface Lease {
	leaseId: string;
	instanceId: string;
	/** Canonical document UUIDs (no `@project` suffix). Empty only for read leases. */
	documents: string[];
	mode: LeaseMode;
	owner: string;
	task?: string;
	scope?: LeaseScope;
	ttlMs: number;
	createdAt: number;
	expiresAt: number;
	lastUsedAt?: number;
	writes: number;
	rejected: number;
	/** Daemon connection that claimed it — its leases die with it. */
	creatorAgentId: string;
}

export class LeaseError extends Error {}

export const LEASE_DEFAULT_TTL_MS = 15 * 60_000;
const LEASE_MIN_TTL_MS = 10_000;
const LEASE_MAX_TTL_MS = 2 * 60 * 60_000;
const MAX_LEASES = 64;

export interface ClaimRequest {
	instanceId: string;
	documents: string[];
	mode: LeaseMode;
	owner: string;
	task?: string;
	scope?: LeaseScope;
	ttlMs?: number;
	creatorAgentId: string;
}

export class LeaseManager {
	private leases = new Map<string, Lease>();

	constructor(private readonly now: () => number = Date.now) {}

	claim(req: ClaimRequest): { lease: Lease; warnings: string[] } {
		this.prune();
		const owner = String(req.owner ?? '').trim().slice(0, 64);
		if (!owner) throw new LeaseError('owner is required (a short label such as "router-usb" — it is shown to agents that hit the lease).');
		if (!['exclusive', 'shared', 'read'].includes(req.mode)) throw new LeaseError(`mode must be exclusive, shared or read (got ${JSON.stringify(req.mode)}).`);
		const documents = [...new Set(req.documents.filter(Boolean))];
		if (req.mode !== 'read' && documents.length === 0) throw new LeaseError(`A ${req.mode} lease must name at least one document UUID.`);
		if (req.mode === 'shared' && !hasScope(req.scope)) throw new LeaseError('A shared lease must declare a scope (nets, designators, pages or region) so overlapping claims can be refused.');
		if (this.leases.size >= MAX_LEASES) throw new LeaseError(`Too many active leases (${MAX_LEASES}). Release finished work first.`);

		const warnings: string[] = [];
		if (req.mode !== 'read') {
			for (const other of this.leases.values()) {
				if (other.instanceId !== req.instanceId || other.mode === 'read') continue;
				const sharedDocs = other.documents.filter((d) => documents.includes(d));
				if (sharedDocs.length === 0) continue;
				if (req.mode === 'exclusive' || other.mode === 'exclusive') {
					throw new LeaseError(`Document ${sharedDocs[0]} is already leased (${describe(other, this.now())}). Wait for it, pick other work, or have the orchestrator release it.`);
				}
				const overlap = scopeOverlap(req.scope!, other.scope!);
				if (overlap.overlaps) {
					throw new LeaseError(`Scope overlaps ${describe(other, this.now())} on ${overlap.detail}. Narrow the scope or wait.`);
				}
				if (!overlap.comparable) {
					warnings.push(`Scope declares different dimensions than ${other.owner}'s lease (${dimensions(other.scope)}); disjointness could not be checked.`);
				}
			}
		}

		const ttlMs = clampTtl(req.ttlMs);
		const now = this.now();
		const lease: Lease = {
			leaseId: 'lease_' + randomBytes(6).toString('hex'),
			instanceId: req.instanceId,
			documents,
			mode: req.mode,
			owner,
			task: req.task ? String(req.task).slice(0, 200) : undefined,
			scope: req.mode === 'exclusive' ? undefined : normalizeScope(req.scope),
			ttlMs,
			createdAt: now,
			expiresAt: now + ttlMs,
			writes: 0,
			rejected: 0,
			creatorAgentId: req.creatorAgentId,
		};
		this.leases.set(lease.leaseId, lease);
		return { lease, warnings };
	}

	/** Live lease by id, or undefined if unknown/expired. */
	get(leaseId: string): Lease | undefined {
		const lease = this.leases.get(leaseId);
		if (!lease) return undefined;
		if (lease.expiresAt <= this.now()) { this.leases.delete(leaseId); return undefined; }
		return lease;
	}

	renew(leaseId: string, ttlMs?: number): Lease {
		const lease = this.get(leaseId);
		if (!lease) throw new LeaseError(`Lease ${leaseId} is unknown or expired.`);
		if (ttlMs !== undefined) lease.ttlMs = clampTtl(ttlMs);
		lease.expiresAt = this.now() + lease.ttlMs;
		return lease;
	}

	release(leaseId: string): Lease | undefined {
		const lease = this.leases.get(leaseId);
		this.leases.delete(leaseId);
		return lease;
	}

	releaseWhere(pred: (lease: Lease) => boolean): Lease[] {
		const out: Lease[] = [];
		for (const lease of [...this.leases.values()]) {
			if (pred(lease)) { this.leases.delete(lease.leaseId); out.push(lease); }
		}
		return out;
	}

	/**
	 * Record use. Any call under the lease slides the expiry forward, so a
	 * worker that reads and plans for a while never loses it mid-task; only an
	 * abandoned lease (dead subagent) ages out.
	 */
	touch(lease: Lease, write: boolean): void {
		const now = this.now();
		lease.lastUsedAt = now;
		if (write) lease.writes++;
		lease.expiresAt = Math.max(lease.expiresAt, now + lease.ttlMs);
	}

	/** Live write-capable leases covering a document. */
	writersOn(instanceId: string, document: string): Lease[] {
		this.prune();
		return [...this.leases.values()].filter((l) => l.instanceId === instanceId && l.mode !== 'read' && l.documents.includes(document));
	}

	active(instanceId?: string): Lease[] {
		this.prune();
		return [...this.leases.values()].filter((l) => !instanceId || l.instanceId === instanceId);
	}

	view(lease: Lease): Record<string, unknown> {
		const now = this.now();
		return {
			leaseId: lease.leaseId,
			owner: lease.owner,
			mode: lease.mode,
			task: lease.task,
			instanceId: lease.instanceId,
			documents: lease.documents,
			scope: lease.scope,
			expiresInS: Math.max(0, Math.round((lease.expiresAt - now) / 1000)),
			idleS: lease.lastUsedAt ? Math.round((now - lease.lastUsedAt) / 1000) : undefined,
			writes: lease.writes,
			rejected: lease.rejected || undefined,
		};
	}

	private prune(): void {
		const now = this.now();
		for (const [id, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(id);
	}
}

export function describe(lease: Lease, now = Date.now()): string {
	const mins = Math.max(0, Math.round((lease.expiresAt - now) / 60_000));
	return `${lease.mode} lease by "${lease.owner}"${lease.task ? ` for "${lease.task}"` : ''}, expires in ~${mins} min`;
}

function clampTtl(ttlMs?: number): number {
	const n = Number(ttlMs);
	if (!Number.isFinite(n) || n <= 0) return LEASE_DEFAULT_TTL_MS;
	return Math.min(LEASE_MAX_TTL_MS, Math.max(LEASE_MIN_TTL_MS, Math.round(n)));
}

function hasScope(scope?: LeaseScope): boolean {
	if (!scope) return false;
	return !!(scope.nets?.length || scope.designators?.length || scope.pages?.length || scope.region);
}

function normalizeScope(scope?: LeaseScope): LeaseScope | undefined {
	if (!hasScope(scope)) return undefined;
	const list = (v?: string[]) => (v?.length ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))] : undefined);
	const r = scope!.region;
	return {
		nets: list(scope!.nets),
		designators: list(scope!.designators),
		pages: list(scope!.pages),
		region: r ? { x1: Math.min(r.x1, r.x2), y1: Math.min(r.y1, r.y2), x2: Math.max(r.x1, r.x2), y2: Math.max(r.y1, r.y2) } : undefined,
	};
}

function dimensions(scope?: LeaseScope): string {
	if (!scope) return 'none';
	return (['nets', 'designators', 'pages', 'region'] as const).filter((k) => k === 'region' ? !!scope.region : !!scope[k]?.length).join('/') || 'none';
}

/**
 * Two shared scopes overlap if ANY dimension both declare intersects. When they
 * share no dimension (one lists nets, the other designators) disjointness is
 * unknowable here — allowed, with a warning.
 */
export function scopeOverlap(a: LeaseScope, b: LeaseScope): { overlaps: boolean; comparable: boolean; detail?: string } {
	let comparable = false;
	for (const key of ['nets', 'designators', 'pages'] as const) {
		const av = a[key], bv = b[key];
		if (!av?.length || !bv?.length) continue;
		comparable = true;
		const set = new Set(av.map((x) => x.toLowerCase()));
		const hit = bv.find((x) => set.has(x.toLowerCase()));
		if (hit) return { overlaps: true, comparable, detail: `${key} "${hit}"` };
	}
	if (a.region && b.region) {
		comparable = true;
		const ra = a.region, rb = b.region;
		const intersects = Math.min(ra.x1, ra.x2) <= Math.max(rb.x1, rb.x2) && Math.min(rb.x1, rb.x2) <= Math.max(ra.x1, ra.x2)
			&& Math.min(ra.y1, ra.y2) <= Math.max(rb.y1, rb.y2) && Math.min(rb.y1, rb.y2) <= Math.max(ra.y1, ra.y2);
		if (intersects) return { overlaps: true, comparable, detail: 'region' };
	}
	return { overlaps: false, comparable };
}
