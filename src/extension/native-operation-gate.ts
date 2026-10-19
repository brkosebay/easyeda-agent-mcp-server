/** Serializes editor context, including nominal reads that switch the active tab. */
export interface NativeOperationRecord { id: number; label: string; startedAt: number; write: boolean }
export interface AbandonedNativeOperation extends NativeOperationRecord { abandonedAt: number; settled: boolean }
export interface NativeOperationState {
  tail: Promise<unknown>;
  uncertain?: { id: number; label: string; startedAt: number; outcome: 'pending' | 'fulfilled' | 'rejected' };
  nextId: number;
  pending: Set<number>;
  /** Operation currently holding the gate (undefined when idle). */
  active?: NativeOperationRecord;
  /** Requests waiting behind `active`. */
  queued: number;
  /** Gate slots released by the watchdog while their native call was still running. */
  abandoned: AbandonedNativeOperation[];
}
export function createNativeOperationState(): NativeOperationState {
  return { tail: Promise.resolve(), nextId: 1, pending: new Set(), queued: 0, abandoned: [] };
}
// Menu actions can evaluate the extension again without destroying old callbacks.
// V3: a fresh key so a bundle upgrade never chains onto a tail that an older
// build (without the gate watchdog) left permanently pending.
const host = globalThis as unknown as { __easyedaNativeOperationsV3?: NativeOperationState };
export const nativeOperationState = host.__easyedaNativeOperationsV3 ??= createNativeOperationState();
// Upgrade shared state when an extension menu evaluation loads a newer bundle.
nativeOperationState.pending ??= new Set();
nativeOperationState.queued ??= 0;
nativeOperationState.abandoned ??= [];

const MAX_ABANDONED_RECORDS = 20;

export function assertNativeOperationReady(state = nativeOperationState): void {
  if (state.uncertain) throw new Error(`Native operation ${state.uncertain.id} (${state.uncertain.label}) requires reconciliation; outcome: ${state.uncertain.outcome}. Further document actions are blocked. Use native_operation_reconcile, or native_operation_reset with clearQuarantine=true if the operation never settles.`);
}
export function nativeOperationStatus(state = nativeOperationState) {
  const now = Date.now();
  return {
    status: state.uncertain ? 'reconciliation-required' : state.active ? 'busy' : 'ready',
    pendingOperations: state.pending.size,
    uncertain: state.uncertain ? { ...state.uncertain } : null,
    active: state.active ? { ...state.active, runningMs: now - state.active.startedAt } : null,
    queued: state.queued ?? 0,
    abandoned: (state.abandoned ?? []).map((a) => ({ ...a, ageMs: now - a.startedAt })),
  };
}

export class NativeOperationTimeoutError extends Error {}

/** A deadline ends the caller's wait, never the underlying native operation. */
export async function boundedNativeOperation<T>(label: string, action: () => Promise<T>, ms = 120000, state = nativeOperationState): Promise<T> {
  assertNativeOperationReady(state);
  const id = state.nextId++;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  state.pending.add(id);
  const actual = Promise.resolve().then(action);
  let outcome: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  void actual.then(() => {
    state.pending.delete(id);
    outcome = 'fulfilled';
    if (state.uncertain?.id === id) state.uncertain.outcome = outcome;
  }, () => {
    state.pending.delete(id);
    outcome = 'rejected';
    if (state.uncertain?.id === id) state.uncertain.outcome = outcome;
  });
  try {
    return await Promise.race([actual, new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        state.uncertain ??= { id, label, startedAt, outcome };
        reject(new NativeOperationTimeoutError(`${label} did not finish within ${ms}ms; the native operation may still be running. Document actions are blocked pending reconciliation.`));
      }, ms);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class NativeWaitTimeoutError extends Error {}

/**
 * Bounded wait for a native call that never edits a document (a tab switch,
 * an identity/state read). Unlike boundedNativeOperation, the deadline only
 * ends the caller's wait: nothing about the document can be uncertain, so the
 * gate is NOT quarantined. Callers verify the outcome by observing state.
 */
export async function boundedNativeWait<T>(label: string, action: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const actual = Promise.resolve().then(action);
  // A late rejection after the deadline must not surface as unhandled.
  void actual.catch(() => undefined);
  try {
    return await Promise.race([actual, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NativeWaitTimeoutError(`${label} did not finish within ${ms}ms (view-only wait; document actions are not blocked).`)), Math.max(1, ms));
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface NativeGateOptions {
  /** Human label (usually the RPC method) for status reporting. */
  label?: string;
  /**
   * The caller's deadline. When set, the gate never lets one request hold the
   * queue longer than this: a request that is still running at the deadline
   * releases its slot (reads) or quarantines the document (writes), and a
   * request whose caller already gave up while it was queued is skipped
   * instead of executing late.
   */
  timeoutMs?: number;
  /** When the caller issued the request (defaults to now). */
  enqueuedAt?: number;
}

export class NativeGateTimeoutError extends Error {}

export function createNativeOperationGate(state = nativeOperationState) {
  return <T>(exclusive: boolean, run: () => Promise<T>, options: NativeGateOptions = {}): Promise<T> => {
    try { assertNativeOperationReady(state); } catch (error) { return Promise.reject(error); }
    const label = options.label ?? 'native operation';
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined;
    const enqueuedAt = options.enqueuedAt ?? Date.now();
    state.queued = (state.queued ?? 0) + 1;
    let dequeued = false;
    const dequeue = () => { if (!dequeued) { dequeued = true; state.queued = Math.max(0, (state.queued ?? 1) - 1); } };
    const operation = state.tail.then(() => {
      dequeue();
      assertNativeOperationReady(state);
      if (timeoutMs === undefined) return run();
      const waited = Date.now() - enqueuedAt;
      if (waited >= timeoutMs) {
        throw new NativeGateTimeoutError(`${label} was not started: its caller timed out after waiting ${waited}ms in the extension queue. Nothing was executed.`);
      }
      return runWithWatchdog(state, label, exclusive, run, timeoutMs - waited);
    });
    // A tail that never settles would wedge every later request; the watchdog
    // above guarantees `operation` settles whenever a deadline is supplied.
    state.tail = operation.catch(() => undefined);
    void operation.catch(() => undefined).then(dequeue);
    return operation;
  };
}

function runWithWatchdog<T>(state: NativeOperationState, label: string, write: boolean, run: () => Promise<T>, ms: number): Promise<T> {
  const record: NativeOperationRecord = { id: state.nextId++, label, startedAt: Date.now(), write };
  state.active = record;
  let settled = false;
  const actual = Promise.resolve().then(run);
  const clearActive = () => { if (state.active?.id === record.id) state.active = undefined; };
  void actual.then(() => undefined, () => undefined).then(() => {
    settled = true;
    clearActive();
    const abandoned = state.abandoned?.find((a) => a.id === record.id);
    if (abandoned) abandoned.settled = true;
    state.pending.delete(record.id);
  });
  void actual.then(() => { if (state.uncertain?.id === record.id) state.uncertain.outcome = 'fulfilled'; },
    () => { if (state.uncertain?.id === record.id) state.uncertain.outcome = 'rejected'; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      clearActive();
      state.abandoned = [...(state.abandoned ?? []), { ...record, abandonedAt: Date.now(), settled: false }].slice(-MAX_ABANDONED_RECORDS);
      if (write) {
        state.pending.add(record.id);
        state.uncertain ??= { id: record.id, label, startedAt: record.startedAt, outcome: 'pending' };
        reject(new NativeGateTimeoutError(`${label} did not finish within ${ms}ms; the native edit may still be running. Document actions are blocked pending reconciliation (native_operation_status / native_operation_reconcile).`));
      } else {
        reject(new NativeGateTimeoutError(`${label} did not finish within ${ms}ms; the bridge released its queue slot so later requests are not blocked. EasyEDA may be busy (open dialog, active placement/drag mode) — press Esc in the editor and retry.`));
      }
    }, ms);
  });
  return Promise.race([actual, watchdog]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/** Only call after a fresh identity/source comparison; socket reconnect is not reconciliation. */
export function acknowledgeNativeOperation(id: number, state = nativeOperationState): void {
  if (!state.uncertain || state.uncertain.id !== id || state.uncertain.outcome === 'pending' || state.pending.size > 0) {
    throw new Error('Native operation is still pending or reconciliation is stale.');
  }
  state.uncertain = undefined;
}

/**
 * Operator recovery: drop the serialized queue so new requests run
 * immediately. Never cancels native work already running inside EasyEDA.
 * `clearQuarantine` additionally discards an unreconciled timed-out write —
 * only for the case where that write can never settle (e.g. EasyEDA wedged
 * mid-call) and the user has inspected the document themselves.
 */
export function resetNativeOperations(options: { clearQuarantine?: boolean } = {}, state = nativeOperationState) {
  const before = nativeOperationStatus(state);
  state.tail = Promise.resolve();
  state.active = undefined;
  state.queued = 0;
  if (options.clearQuarantine) {
    state.uncertain = undefined;
    state.pending.clear();
  }
  // Other serialization layers (ws-client document locks) register here so
  // one reset releases everything a wedged call could still be holding.
  const released: Record<string, unknown> = {};
  for (const hook of resetHooks) {
    try { Object.assign(released, hook() ?? {}); } catch { /* a failing hook must not block recovery */ }
  }
  return { before, after: nativeOperationStatus(state), released };
}

type ResetHook = () => Record<string, unknown> | void;
const resetHooks: ResetHook[] = [];

/** Register extra queue state to drop on `resetNativeOperations`. */
export function onNativeOperationsReset(hook: ResetHook): void {
  resetHooks.push(hook);
}
