import { assertNativeOperationReady, boundedNativeWait } from './native-operation-gate';

/**
 * Switching the active tab is view state, not a document edit: a slow open
 * must never quarantine the operation gate. Activation is fire-and-verify —
 * EasyEDA's open/activate promises often settle late or never (they wait on a
 * render tick, and Pro 2.2's public PCB open misses its own tabChange event),
 * so the request is dispatched without awaiting it and success is observed by
 * polling the focused document until it is the target.
 */

/** Tab ids are `<docUuid>@<projectUuid>`; the bare UUID identifies the document. */
const canonical = (value: string) => String(value ?? '').trim().split('@')[0];
/** Comparison key: agents occasionally prefix ids with `!`. */
const bare = (value: string) => canonical(value).replace(/^!+/, '');

export const DEFAULT_DOCUMENT_OPEN_WAIT_MS = 45_000;
const MAX_DOCUMENT_OPEN_WAIT_MS = 300_000;
const MIN_DOCUMENT_OPEN_WAIT_MS = 1_000;
/** Even at a spent deadline, take one look before reporting. */
const LAST_LOOK_MS = 100;
const DEFAULT_POLL_MS = 250;
/** One identity read; a read that hangs is retried on the next poll. */
const READ_TIMEOUT_MS = 3_000;
/** After EasyEDA reports the open failed, keep observing briefly in case the tab still appears. */
const DEFAULT_FAILED_GRACE_MS = 1_500;
/** Once EasyEDA says the open finished, wait this long before re-focusing the tab once. */
const REFOCUS_AFTER_SETTLE_MS = 1_000;
/** An unsettled open older than this no longer blocks a fresh dispatch. */
const STALE_OPEN_MS = 180_000;
/** Ignore a caller deadline this far off — a skewed clock must not fail or stall the open. */
const DEADLINE_SKEW_TOLERANCE_MS = 60_000;

type DocInfo = { uuid: string; documentType?: number; tabId?: string; parentProjectUuid?: string; parentLibraryUuid?: string };
type OpenVia = 'activate-tab' | 'open-pcb' | 'open-document';

export interface ActivateDocumentOptions {
  /** How long to wait for the target to become the active document (default 45 s). */
  timeoutMs?: number;
  /** Absolute epoch-ms deadline (e.g. the caller's gate deadline); the wait never runs past it. */
  deadlineAt?: number;
  /** Poll cadence for the active-document check (tests use small values). */
  pollMs?: number;
  /** How long to keep observing after EasyEDA reports the open failed. */
  failedGraceMs?: number;
}

export interface DocumentActivation {
  document: DocInfo;
  alreadyActive: boolean;
  /** How the open was requested; `joined-in-progress` reused an earlier unfinished request. */
  via: 'already-active' | OpenVia | 'joined-in-progress';
  waitedMs: number;
}

interface OpenAttempt {
  target: string;
  via: OpenVia;
  startedAt: number;
  settled: boolean;
  settledAt?: number;
  outcome?: 'fulfilled' | 'rejected';
  value?: unknown;
  error?: string;
}

// Shared across extension re-evaluations (menu reloads) like the gate state,
// so a retry after a bundle reload still joins the open already running.
const host = globalThis as unknown as { __easyedaDocumentOpensV1?: Map<string, OpenAttempt> };
const opens = host.__easyedaDocumentOpensV1 ??= new Map<string, OpenAttempt>();

/** Unfinished open requests (diagnostics). */
export function pendingDocumentOpens(now = Date.now()) {
  return [...opens.values()].map(a => ({ target: a.target, via: a.via, ageMs: now - a.startedAt, settled: a.settled, outcome: a.outcome ?? 'pending', error: a.error }));
}

export class DocumentActivationError extends Error {
  constructor(message: string, readonly details: { requested: string; active?: DocInfo; inProgress: boolean; waitedMs: number }) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));

/** A read that hangs (EasyEDA busy loading) yields undefined; the next poll retries. */
async function read<T>(label: string, fn: () => Promise<T>, ms = READ_TIMEOUT_MS): Promise<T | undefined> {
  try { return await boundedNativeWait(label, fn, ms); } catch { return undefined; }
}

const readActive = (ms?: number) => read('getCurrentDocumentInfo', () => eda.dmt_SelectControl.getCurrentDocumentInfo(), ms) as Promise<DocInfo | undefined>;
const readProject = (ms?: number) => read('getCurrentProjectInfo', () => eda.dmt_Project.getCurrentProjectInfo(), ms);

const DOC_TYPE_NAMES: Record<number, string> = { [-1]: 'home', 0: 'blank', 1: 'schematic page', 2: 'symbol', 3: 'PCB', 4: 'footprint', 12: 'PCB 2D preview', 15: 'PCB 3D preview', 26: 'panel' };

function describeDoc(doc: DocInfo | undefined): string {
  if (!doc?.uuid) return 'none';
  const type = doc.documentType != null ? DOC_TYPE_NAMES[doc.documentType] ?? `type ${doc.documentType}` : 'unknown type';
  const owner = doc.parentProjectUuid ? `project ${doc.parentProjectUuid}` : doc.parentLibraryUuid ? `library ${doc.parentLibraryUuid}` : 'no project';
  return `${canonical(doc.uuid)} (${type}, ${owner})`;
}

interface TargetInfo {
  kind: 'pcb' | 'schematic' | 'schematic-page' | 'pcb-footprint' | 'unknown';
  /** Bare UUIDs whose activation counts as reaching the target (a schematic → its pages). */
  accept: Set<string>;
}

async function describeTarget(target: string, ms: number): Promise<TargetInfo> {
  const accept = new Set([target]);
  const pcbs = (await read('getAllPcbsInfo', () => eda.dmt_Pcb.getAllPcbsInfo(), ms)) ?? [];
  if (pcbs.some(pcb => bare(pcb.uuid) === target)) return { kind: 'pcb', accept };
  const schematics = (await read('getAllSchematicsInfo', async () => eda.dmt_Schematic?.getAllSchematicsInfo?.(), ms)) ?? [];
  for (const schematic of schematics) {
    const pages = schematic.page ?? [];
    if (bare(schematic.uuid) === target) {
      // openDocument(schematicUuid) focuses one of its pages, whose uuid is what the editor reports.
      for (const page of pages) accept.add(bare(page.uuid));
      return { kind: 'schematic', accept };
    }
    if (pages.some(page => bare(page.uuid) === target)) return { kind: 'schematic-page', accept };
  }
  // In-PCB footprint editing tabs are `<pcbUuid>_<componentPrimitiveId>` and
  // report no parentProjectUuid; they belong to the project through their PCB.
  const parentPcb = target.includes('_') ? target.slice(0, target.indexOf('_')) : undefined;
  if (parentPcb && pcbs.some(pcb => bare(pcb.uuid) === parentPcb)) return { kind: 'pcb-footprint', accept };
  return { kind: 'unknown', accept };
}

type TabTree = { tabs?: Array<{ tabId: string }>; children?: TabTree[] };

function findTab(tree: TabTree | undefined, accept: Set<string>, projectUuid: string): string | undefined {
  const all: string[] = [];
  const walk = (node: TabTree | undefined) => {
    for (const tab of node?.tabs ?? []) if (tab?.tabId && accept.has(bare(tab.tabId))) all.push(tab.tabId);
    for (const child of node?.children ?? []) walk(child);
  };
  walk(tree);
  return all.find(id => id.endsWith('@' + projectUuid)) ?? all[0];
}

function messageBus() {
  type Bus = { rpcCall: (topic: string, payload: unknown) => Promise<unknown> };
  type Host = { UI?: { gVars?: { messageBus?: Bus } } };
  try {
    const root = globalThis as unknown as Host & { top?: Host };
    const bus = root.UI?.gVars?.messageBus ?? root.top?.UI?.gVars?.messageBus;
    return typeof bus?.rpcCall === 'function' ? bus : undefined;
  } catch { return undefined; /* Isolated runtime: fall back to the public SDK. */ }
}

/** Fire the native open without awaiting it; the attempt records how it settles. */
function launch(attempt: OpenAttempt, via: OpenVia, run: () => Promise<unknown>): void {
  attempt.via = via;
  void Promise.resolve().then(run).then(
    value => { attempt.settled = true; attempt.settledAt = Date.now(); attempt.outcome = 'fulfilled'; attempt.value = value; },
    error => { attempt.settled = true; attempt.settledAt = Date.now(); attempt.outcome = 'rejected'; attempt.error = error instanceof Error ? error.message : String(error); },
  );
}

/** EasyEDA's own verdict that the open failed (it still gets a short grace period). */
function failureOf(attempt: OpenAttempt): string | undefined {
  if (!attempt.settled) return undefined;
  if (attempt.outcome === 'rejected') return `EasyEDA rejected the open request: ${attempt.error}`;
  if (attempt.via === 'open-document' && (attempt.value === undefined || attempt.value === null || attempt.value === '')) return 'EasyEDA openDocument returned no tab (it does not recognise this UUID as an openable document of the current project)';
  if (attempt.via === 'activate-tab' && attempt.value === false) return 'EasyEDA refused to activate the open tab';
  return undefined;
}

function resolveBudget(startedAt: number, options: ActivateDocumentOptions): number {
  const requested = Number(options.timeoutMs);
  const budget = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.max(requested, MIN_DOCUMENT_OPEN_WAIT_MS), MAX_DOCUMENT_OPEN_WAIT_MS)
    : DEFAULT_DOCUMENT_OPEN_WAIT_MS;
  const until = Number(options.deadlineAt);
  if (Number.isFinite(until) && until > 0) {
    const left = until - startedAt;
    // The caller's deadline wins over the minimum: overrunning it is what
    // lets the gate watchdog quarantine a write-classified request.
    if (left > -DEADLINE_SKEW_TOLERANCE_MS && left < MAX_DOCUMENT_OPEN_WAIT_MS + DEADLINE_SKEW_TOLERANCE_MS) return Math.max(LAST_LOOK_MS, Math.min(budget, left));
  }
  return budget;
}

/**
 * Make `document` the active editor document and report how. Waits (bounded,
 * never quarantining) until EasyEDA shows it focused; returns at once when it
 * already is, and joins an unfinished earlier open of the same document
 * instead of opening it twice.
 */
export async function openNativeDocument(document: string, options: ActivateDocumentOptions = {}): Promise<DocumentActivation> {
  const requested = canonical(document);
  const target = bare(document);
  if (!target) throw new Error('Pass the UUID of the document to open (documentUuid).');
  assertNativeOperationReady();
  const startedAt = Date.now();
  const budgetMs = resolveBudget(startedAt, options);
  const deadline = startedAt + budgetMs;
  const pollMs = Math.max(5, Number(options.pollMs) || DEFAULT_POLL_MS);
  const failedGraceMs = Math.max(0, Number.isFinite(Number(options.failedGraceMs)) ? Number(options.failedGraceMs) : DEFAULT_FAILED_GRACE_MS);

  // Every identity read is bounded by the remaining budget, so a busy editor
  // cannot stretch the wait past the caller's deadline.
  const within = () => Math.min(READ_TIMEOUT_MS, Math.max(50, deadline - Date.now()));

  const project = await readProject(within());
  if (!project?.uuid) throw new Error('No active EasyEDA project (or EasyEDA did not answer getCurrentProjectInfo).');
  let info: TargetInfo | undefined;
  const targetInfo = async () => info ??= await describeTarget(target, within());

  const mismatch = (reason: string, active?: DocInfo) => new DocumentActivationError(
    `Document activation did not reach the requested project and document: ${reason}`,
    { requested, active, inProgress: false, waitedMs: Date.now() - startedAt },
  );
  // 'match' = target focused and bound to the current project.
  const check = async (doc: DocInfo | undefined): Promise<'match' | 'wrong-project' | 'other'> => {
    if (!doc?.uuid) return 'other';
    const uuid = bare(doc.uuid);
    let hit = uuid === target || (!!doc.tabId && bare(doc.tabId) === target);
    if (!hit && doc.documentType === 1) hit = (await targetInfo()).accept.has(uuid);
    if (!hit) return 'other';
    if (doc.parentProjectUuid) return doc.parentProjectUuid === project.uuid ? 'match' : 'wrong-project';
    // No parentProjectUuid: in-PCB footprint tabs are bound through their PCB.
    if ((await targetInfo()).kind === 'pcb-footprint') return 'match';
    return doc.tabId?.split('@')[1] === project.uuid ? 'match' : 'wrong-project';
  };
  const wrongProject = (doc: DocInfo) => mismatch(`${describeDoc(doc)} is active but is not bound to the current project ${project.uuid}.`, doc);

  let active = await readActive(within());
  const initial = await check(active);
  if (initial === 'match') {
    opens.delete(target);
    return { document: active!, alreadyActive: true, via: 'already-active', waitedMs: Date.now() - startedAt };
  }
  if (initial === 'wrong-project') throw wrongProject(active!);

  for (const [key, stale] of opens) if (startedAt - stale.startedAt > STALE_OPEN_MS) opens.delete(key);
  // Look up and reserve in one synchronous step so two concurrent calls can
  // never both dispatch: the loser joins the winner's attempt.
  const previous = opens.get(target);
  const joined = !!previous && !previous.settled;
  const attempt: OpenAttempt = joined ? previous! : { target, via: 'open-document', startedAt: Date.now(), settled: false };
  if (!joined) opens.set(target, attempt);
  let tInfo: TargetInfo;
  try {
    tInfo = await targetInfo();
    if (!joined) {
      const tab = findTab(await read('getSplitScreenTree', () => eda.dmt_EditorControl.getSplitScreenTree(), within()) as TabTree | undefined, tInfo.accept, project.uuid);
      const bus = messageBus();
      if (tab) {
        launch(attempt, 'activate-tab', () => eda.dmt_EditorControl.activateDocument(tab));
      } else if (tInfo.kind === 'pcb' && bus) {
        // Pro 2.2's public PCB open subscribes to tabChange AFTER opening and
        // misses the event; this is the same native opener without that race.
        launch(attempt, 'open-pcb', () => bus.rpcCall('openPcbByUUid', { uuid: target, options: {} }));
      } else {
        launch(attempt, 'open-document', () => eda.dmt_EditorControl.openDocument(requested));
      }
    }
  } catch (error) {
    // Never leave a reservation that later calls would wait on forever.
    if (!joined && opens.get(target) === attempt) opens.delete(target);
    throw error;
  }
  // A retry while the first open is still loading waits for it — never a second open.
  const via: DocumentActivation['via'] = joined ? 'joined-in-progress' : attempt.via;

  let failedAt: number | undefined;
  let refocused = false;
  while (Date.now() < deadline) {
    await sleep(Math.min(pollMs, deadline - Date.now()));
    active = (await readActive(within())) ?? active;
    const state = await check(active);
    if (state === 'match') {
      const after = await readProject(within());
      if (after?.uuid && after.uuid !== project.uuid) throw mismatch(`the active project changed from ${project.uuid} to ${after.uuid} while opening ${requested}.`, active);
      if (opens.get(target) === attempt) opens.delete(target);
      return { document: active!, alreadyActive: false, via, waitedMs: Date.now() - startedAt };
    }
    if (state === 'wrong-project') throw wrongProject(active!);
    const failure = failureOf(attempt);
    if (failure) {
      failedAt ??= Date.now();
      if (Date.now() - failedAt >= failedGraceMs) {
        if (opens.get(target) === attempt) opens.delete(target);
        const hint = tInfo.kind === 'unknown' ? ` ${requested} is not a PCB, schematic or schematic page of the current project — library footprint/symbol UUIDs and component primitive IDs are not project documents (an in-PCB footprint tab is "<pcbUuid>_<componentPrimitiveId>").` : '';
        throw new DocumentActivationError(
          `Document activation did not reach the requested project and document: ${failure}. Requested ${requested}; active document is ${describeDoc(active)}.${hint} Document actions are not blocked.`,
          { requested, active, inProgress: false, waitedMs: Date.now() - startedAt },
        );
      }
    } else if (attempt.settled && !refocused && Date.now() - (attempt.settledAt ?? 0) >= REFOCUS_AFTER_SETTLE_MS) {
      // EasyEDA reports the open done but focus is elsewhere (another split
      // pane, or the user clicked away mid-load): focus the tab once.
      refocused = true;
      const tab = findTab(await read('getSplitScreenTree', () => eda.dmt_EditorControl.getSplitScreenTree(), within()) as TabTree | undefined, tInfo.accept, project.uuid);
      if (tab) void Promise.resolve().then(() => eda.dmt_EditorControl.activateDocument(tab)).catch(() => undefined);
    }
  }

  const waitedMs = Date.now() - startedAt;
  const inProgress = !attempt.settled;
  const state = inProgress
    ? `EasyEDA is still loading it (${attempt.via} requested ${Date.now() - attempt.startedAt}ms ago; large PCBs can take longer). Call editor_open_document again with the same UUID to keep waiting — the retry joins this open instead of starting a second one — or pass a larger timeoutMs.`
    : `EasyEDA reported the open (${attempt.via}) as finished, but the document never became the focused tab — the user or another agent may have switched tabs. Retry editor_open_document.`;
  throw new DocumentActivationError(
    `Opening document ${requested} did not complete within ${budgetMs}ms: active document is ${describeDoc(active)}. ${state} Document actions are not blocked.`,
    { requested, active, inProgress, waitedMs },
  );
}

/** Use fresh editor identity: users can switch tabs independently of the bridge. */
export async function activateNativeDocument(document: string, options: ActivateDocumentOptions = {}): Promise<unknown> {
  return (await openNativeDocument(document, options)).document;
}
