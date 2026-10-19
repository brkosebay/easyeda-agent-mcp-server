// Per-(instanceId, documentUuid) async mutex. Owned by the daemon — that's
// the whole point of the daemon refactor. Today's per-MCP locks don't
// serialize writes from two different MCP processes targeting the same
// document, which is a latent corruption bug.

interface Waiter {
	resolve: (release: () => void) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
	agentId: string;
}

interface LockState {
	holder: { agentId: string; acquiredAt: number } | null;
	queue: Waiter[];
}

const ACQUIRE_TIMEOUT_MS = 60_000;

export class LockManager {
	private locks = new Map<string, LockState>();

	private keyOf(instanceId: string, document: string): string {
		return `${instanceId}::${document}`;
	}

	private getOrCreate(key: string): LockState {
		let s = this.locks.get(key);
		if (!s) { s = { holder: null, queue: [] }; this.locks.set(key, s); }
		return s;
	}

	/**
	 * Acquire a lock keyed by (instance, document). Returns a release function.
	 * If `writeLock=false` (read-only), returns immediately — locks only block
	 * each other; reads run concurrently.
	 */
	async acquire(instanceId: string, document: string, agentId: string, opts: { writeLock: boolean; timeoutMs?: number } = { writeLock: true }): Promise<() => void> {
		if (!opts.writeLock) {
			return () => {}; // no-op release
		}
		const key = this.keyOf(instanceId, document);
		const state = this.getOrCreate(key);

		if (!state.holder) {
			state.holder = { agentId, acquiredAt: Date.now() };
			return this.makeReleaser(key, agentId);
		}

		const timeoutMs = opts.timeoutMs ?? ACQUIRE_TIMEOUT_MS;
		return new Promise<() => void>((resolve, reject) => {
			const waiter: Waiter = {
				resolve: (release) => resolve(release),
				reject,
				timer: null,
				agentId,
			};
			waiter.timer = setTimeout(() => {
				const idx = state.queue.indexOf(waiter);
				if (idx >= 0) state.queue.splice(idx, 1);
				reject(new Error(`Lock acquire timeout (${timeoutMs}ms) on ${key}`));
			}, timeoutMs);
			state.queue.push(waiter);
		});
	}

	private makeReleaser(key: string, agentId: string): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const state = this.locks.get(key);
			if (!state) return;
			if (state.holder?.agentId !== agentId) {
				// Stale — already passed to the next waiter
				return;
			}
			const next = state.queue.shift();
			if (next) {
				if (next.timer) clearTimeout(next.timer);
				state.holder = { agentId: next.agentId, acquiredAt: Date.now() };
				next.resolve(this.makeReleaser(key, next.agentId));
			} else {
				state.holder = null;
				if (state.queue.length === 0) this.locks.delete(key);
			}
		};
	}

	/** Drop every lock + waiter held by an agent. Called when an MCP disconnects. */
	releaseAllForAgent(agentId: string): void {
		for (const [key, state] of this.locks) {
			// Reject queued waiters
			state.queue = state.queue.filter((w) => {
				if (w.agentId === agentId) {
					if (w.timer) clearTimeout(w.timer);
					w.reject(new Error('Agent disconnected'));
					return false;
				}
				return true;
			});
			// Force-release current holder if it's this agent
			if (state.holder?.agentId === agentId) {
				const next = state.queue.shift();
				if (next) {
					if (next.timer) clearTimeout(next.timer);
					state.holder = { agentId: next.agentId, acquiredAt: Date.now() };
					next.resolve(this.makeReleaser(key, next.agentId));
				} else {
					state.holder = null;
					this.locks.delete(key);
				}
			}
		}
	}

	stats(): { keys: number; waiters: number; entries: Array<{ key: string; holder: string | null; queueLen: number }> } {
		const entries: Array<{ key: string; holder: string | null; queueLen: number }> = [];
		let waiters = 0;
		for (const [key, state] of this.locks) {
			waiters += state.queue.length;
			entries.push({ key, holder: state.holder?.agentId ?? null, queueLen: state.queue.length });
		}
		return { keys: this.locks.size, waiters, entries };
	}
}
