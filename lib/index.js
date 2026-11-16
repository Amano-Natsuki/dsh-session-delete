/**
 * dsh-plugin-session-delete — host half.
 *
 * Permanently deletes one DSH session with zero local residue. The browser
 * half renders a "delete session" menu entry, previews what the delete will
 * take with it, and calls this host half through the loopback HTTP route
 * registered below (profile plugins have no harness.handle/host.call channel —
 * that belongs to dynamic sandbox packages).
 *
 * Lineage
 * -------
 * A session may name a `parentSession` in its own header. DSH records two very
 * different relations that way:
 *
 *   - `origin: "subagent"` — a session an Agent opened (subagent tool, workflow,
 *     Agent Teams). It is hidden from the sidebar and only reachable through its
 *     parent's descendant catalog, so deleting the parent while keeping it would
 *     leave an unreachable ghost behind. These are deleted together with the
 *     target, at any depth.
 *   - anything else — an ordinary fork (independent conversation whose history
 *     was copied). Current builds do not record a parent on forks; only
 *     historical logs do. A fork is fully independent, so it is preserved: its
 *     `parentSession` merely dangles, which DSH tolerates (list indentation and
 *     resume admission key off the subagent origin).
 *
 * Storage surfaces cleared, in order, for the target and every agent-spawned
 * descendant:
 *   1. live store entry         — the store's own detach entry (teardown path)
 *   2. workspace accounting      — workspaceRegistry entity detachSession
 *   3. archive / pin sets        — unarchiveSession / unpinSession
 *   4. event log directory       — <persistence root>/<projectKey>/<encodedId>
 *   5. projection cache          — <harness home>/storages/session_projcache/sessions/<id>.json
 *   6. spill files               — <tmp>/dsh-spill-…/session-<sha256(id)[:12]>
 *
 * The persistence root is read from the mounted backend when it exposes one,
 * so a custom `root` configuration still resolves correctly; the harness home
 * follows the `$DSH_HOME` / `~/.dsh` precedence.
 *
 * The SQLite search index needs no cleanup: it is rebuilt from the log corpus
 * (the shipped desktop profile keeps it in memory).
 *
 * Guardrails:
 *   - the session must exist (live or persisted)
 *   - the listing that establishes lineage must be readable: a failed listing
 *     refuses the delete (fail closed) instead of assuming "no descendants"
 *   - running work is stopped through the archive stopActivity waterfall, which
 *     also cancels running subagent descendants (dsh-subagent's archive
 *     admission); the delete then waits for them to settle before removal
 *
 * Directory encoding (projectKey / encodeSegment) mirrors
 * @deepseek-ai/dsh-session-persistence-jsonl verbatim so this plugin resolves
 * the exact session directory without importing the asar-packaged package.
 */
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, readdir, readFile, rm, stat as statPath, writeFile } from "node:fs/promises";

/** Services this plugin reaches through the host cordis context. */
const inject = [
  "webServer",
  "workspaceRegistry",
  "sessionPersistence",
  "sessions"
];

/** HTTP route the browser half calls (GET = preview, POST = delete). */
const ROUTE_PATH = "/api/session-delete";

/** Pending-deletion journal: sessions whose files survive a live delete are
 * reaped here on the next start (after a restart every session is cold, so
 * the removal always succeeds). Lives under the resolved harness home. */
const PENDING_FILE = "session-delete.pending.json";

/** Retry budget for the removal loop that outlasts a stopped session's final
 * checkpoint flush (turn/end writes and the projection-cache write-behind). */
const REMOVAL_ATTEMPTS = 3;
const REMOVAL_RETRY_DELAY_MS = 1000;
/** Quiet window after stopActivity before the first removal attempt. */
const QUIET_AFTER_STOP_MS = 1200;
/** How long to let cancelled descendants settle before detaching them. */
const IDLE_WAIT_MS = 4000;
const IDLE_POLL_MS = 250;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Hostnames a loopback web surface may legitimately use, whatever its port. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Encode one path segment exactly like the JSONL backend: safe characters
 * pass through, everything else becomes `~XXXX` (UTF-16 code unit, uppercase
 * hex, zero-padded to four).
 */
function encodeSegment(value) {
  // 与后端逐字对齐的边界：整段只有 "." / ".." 时不能原样落盘（否则就成目录遍历）。
  // 真实 session id 永远不是这两个，但保持"逐字镜像"可以避免以后布局再变时看不出差异。
  if (value === ".") return "~002E";
  if (value === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/**
 * Build the readable project directory key exactly like the JSONL backend:
 * `\` `/` `:` collapse to a single `-`, unsafe code units use `~XXXX`, the
 * result is trimmed, bounded to 251 chars, and wrapped in `--…--`.
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * Resolve the DeepSeek Harness home: explicit configured path, `$DSH_HOME`,
 * then `~/.dsh` — the same precedence as @deepseek-ai/dsh-home-paths.
 */
function dshHome() {
  const env = process.env.DSH_HOME;
  const configured = typeof env === "string" && env.trim().length > 0 ? env : void 0;
  let base;
  if (configured !== void 0) {
    if (configured === "~") base = homedir();
    else if (configured.startsWith("~/") || configured.startsWith("~\\")) base = join(homedir(), configured.slice(2));
    else base = configured;
  } else {
    base = join(homedir(), ".dsh");
  }
  return resolve(base);
}

/** Strict session-id shape (session ids and uuids are safe path segments). */
function isPlausibleSessionId(sessionId) {
  return typeof sessionId === "string"
    && sessionId.length > 0
    && sessionId.length <= 200
    && /^[A-Za-z0-9._~-]+$/.test(sessionId);
}

/**
 * Resolve the on-disk session root. A JSONL persistence backend carries its
 * configured root (which may differ from the default), so prefer that and
 * fall back to `<home>/sessions`.
 */
function sessionRoot(ctx, home) {
  const configured = ctx.sessionPersistence?.root;
  return typeof configured === "string" && configured.length > 0 ? configured : join(home, "sessions");
}

/** Absolute path of the pending-deletion journal under the harness home. */
function pendingPath() {
  return join(dshHome(), "plugins", PENDING_FILE);
}

// --- Lineage ---------------------------------------------------------------

/**
 * Index headers by the parent they name.
 * @param {Iterable<object>} headers — session headers (persisted ones and live ones).
 * @returns {Map<string, object[]>} parent id → direct child headers.
 */
function indexChildren(headers) {
  const childrenByParent = new Map();
  for (const header of headers) {
    const parent = header?.parentSession;
    if (typeof parent !== "string" || parent.length === 0) continue;
    const list = childrenByParent.get(parent) ?? [];
    list.push(header);
    childrenByParent.set(parent, list);
  }
  return childrenByParent;
}

/**
 * Split the lineage below one session into the two kinds the delete treats
 * differently. Only agent-spawned (`origin: "subagent"`) descendants are
 * descended into; an ordinary fork is an independent conversation and its own
 * subtree is never part of this delete.
 *
 * @param {Map<string, object[]>} childrenByParent — from {@link indexChildren}.
 * @param {string} rootId — the session being deleted.
 * @returns `{ subagents, forks }`; subagents are parent-before-child order.
 */
function collectLineage(childrenByParent, rootId) {
  const subagents = [];
  const forks = [];
  const visited = new Set([rootId]);
  const pending = [rootId];
  while (pending.length > 0) {
    const parentId = pending.shift();
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      if (child.origin === "subagent") {
        subagents.push(child);
        pending.push(child.id);
      } else {
        forks.push(child);
      }
    }
  }
  return { subagents, forks };
}

/** Live agent status when the optional `agents` service is reachable. */
function agentStatus(ctx, sessionId) {
  try {
    return ctx.get?.("agents")?.get?.(sessionId)?.status;
  } catch {
    return void 0;
  }
}

/** Ids among `ids` whose live agent still reports `running`. */
function runningIds(ctx, ids) {
  return ids.filter((id) => agentStatus(ctx, id) === "running");
}

/**
 * Wait (bounded) for cancelled descendants to leave the running state. The
 * removal retry loop and the start-up journal cover whatever outlasts this
 * wait; the wait only keeps the common case tidy.
 */
async function waitForIdle(ctx, ids, timeoutMs) {
  if (ids.length === 0 || timeoutMs <= 0) return runningIds(ctx, ids);
  const deadline = Date.now() + timeoutMs;
  let running = runningIds(ctx, ids);
  while (running.length > 0 && Date.now() < deadline) {
    await sleep(IDLE_POLL_MS);
    running = runningIds(ctx, ids);
  }
  return running;
}

// --- Session headers -------------------------------------------------------

/**
 * Merge every header this delete needs: persisted snapshots plus live sessions
 * that may not be materialized yet (a child spawned a moment ago). Live headers
 * win for fields either way; duplicates are collapsed by id.
 */
function collectHeaders(ctx, stored, liveHeader, targetId) {
  const headers = new Map();
  for (const snapshot of stored) {
    const header = snapshot?.header;
    if (header !== void 0 && typeof header.id === "string" && !headers.has(header.id)) headers.set(header.id, header);
  }
  try {
    for (const entry of ctx.sessions.store?.values?.() ?? []) {
      const header = entry?.session?.header;
      if (header !== void 0 && typeof header.id === "string" && !headers.has(header.id)) headers.set(header.id, header);
    }
  } catch {
    /* a store without live headers: persisted snapshots already cover it */
  }
  if (liveHeader !== void 0 && typeof liveHeader.id === "string" && !headers.has(liveHeader.id)) headers.set(liveHeader.id, liveHeader);
  if (!headers.has(targetId) && liveHeader !== void 0) headers.set(targetId, liveHeader);
  return headers;
}

// --- Deletion --------------------------------------------------------------

/** Path of one session's projection-cache entry. */
function projectionCachePath(home, sessionId) {
  return join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
}

/**
 * Every on-disk directory that holds `sessionId`. The directory name is
 * derived from the session's own `cwd`, but a session whose header lost its
 * cwd (or moved workspace) may sit under another project key, so the resolver
 * also looks for the encoded id in every project directory. Both shapes are
 * returned and removed.
 */
async function locateSessionDirs(root, sessionId, cwd) {
  const encoded = encodeSegment(sessionId);
  const candidates = new Set([join(root, "_no-cwd", encoded)]);
  if (typeof cwd === "string" && cwd.length > 0) {
    try {
      candidates.add(join(root, projectKey(cwd), encoded));
    } catch {
      /* cwd not encodable: the directory scan below still finds it */
    }
  }
  try {
    for (const projectName of await readdir(root)) candidates.add(join(root, projectName, encoded));
  } catch {
    /* missing root: only the computed candidate is checked */
  }
  const found = [];
  for (const candidate of candidates) {
    try {
      const stats = await statPath(candidate);
      if (stats.isDirectory()) found.push(candidate);
    } catch {
      /* absent */
    }
  }
  return found;
}

/**
 * Spill directories that belong to any of `ids`: `<tmp>/dsh-spill-…/session-<sha256(id)[:12]>`.
 * The tmp root is scanned once and shared across ids.
 */
async function locateSpillDirs(ids) {
  const byId = new Map();
  let entries;
  try {
    entries = await readdir(tmpdir());
  } catch {
    return byId;
  }
  const roots = entries.filter((name) => /^dsh-spill-[A-Za-z0-9]{6}$/.test(name));
  for (const id of ids) {
    const hash = createHash("sha256").update(id).digest("hex").slice(0, 12);
    const paths = roots.map((name) => join(tmpdir(), name, `session-${hash}`));
    if (paths.length > 0) byId.set(id, paths);
  }
  return byId;
}

/**
 * Drop `ids` from the registry-global archive / pin sets. Best effort: removal
 * already happened, so a failing write only leaves a stale id behind.
 */
async function clearGlobalSets(registry, ids) {
  for (const id of ids) {
    try {
      if (registry.archivedSessionIds.includes(id)) await registry.unarchiveSession(id);
    } catch {
      /* best effort */
    }
    try {
      if (registry.pinnedSessionIds.includes(id)) await registry.unpinSession(id);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Delete one session and its agent-spawned descendants durably.
 * @returns `{ ok: true, deleted, cascade, forks, deferred? }`, or a structured refusal.
 */
async function deleteSession(ctx, sessionId, options = {}) {
  const quietAfterStopMs = options.quietAfterStopMs ?? QUIET_AFTER_STOP_MS;
  const retryDelayMs = options.retryDelayMs ?? REMOVAL_RETRY_DELAY_MS;
  const removalAttempts = options.removalAttempts ?? REMOVAL_ATTEMPTS;
  const idleWaitMs = options.idleWaitMs ?? IDLE_WAIT_MS;

  if (!isPlausibleSessionId(sessionId)) return { ok: false, reason: "invalid-id" };
  const registry = ctx.workspaceRegistry;

  // 1. Existence + header (the header carries the canonical cwd).
  let snapshot;
  try {
    snapshot = await ctx.sessionPersistence.stat(sessionId);
  } catch {
    snapshot = void 0;
  }
  const live = ctx.sessions.get(sessionId);
  let header = snapshot?.header;
  if (header === void 0) {
    try {
      header = await registry.readSessionHeader(sessionId);
    } catch {
      header = void 0;
    }
  }
  if (header === void 0 && live === void 0) return { ok: false, reason: "not-found" };
  const cwd = header?.cwd;

  // 2. Read the listing that establishes lineage. A failed listing refuses the
  //    delete instead of assuming "no descendants": the check must fail closed,
  //    never open.
  let stored;
  try {
    stored = await ctx.sessionPersistence.list();
  } catch (error) {
    return { ok: false, reason: "list-failed", message: String(error?.message ?? error) };
  }
  const headers = collectHeaders(ctx, stored, header, sessionId);
  const { subagents, forks } = collectLineage(indexChildren(headers.values()), sessionId);
  const descendantIds = subagents.map((child) => child.id);
  const ids = [sessionId, ...descendantIds];

  // 3. Stop running work through the archive stopActivity waterfall. The
  //    durable archive set gates every wake the stops induce; the ids are
  //    dropped from the set again after removal, so nothing lingers. The
  //    waterfall also cancels running subagent descendants (dsh-subagent's
  //    archive admission), so one archive covers the whole subtree.
  try {
    await registry.archiveSession(sessionId, { stopActivity: true });
  } catch (error) {
    ctx.logger?.warn?.(`[session-delete] archive/stop step for "${sessionId}":`, String(error?.message ?? error));
  }

  // 4. Let the stopped sessions settle: their final turn/end checkpoint and
  //    the projection-cache write-behind may still flush once after the stop.
  //    Removing files before that flush would let the live writer recreate
  //    them (the "deleted session reappears as ungrouped" failure).
  await sleep(quietAfterStopMs);
  const stillRunning = await waitForIdle(ctx, descendantIds, idleWaitMs);
  if (stillRunning.length > 0) {
    ctx.logger?.warn?.(`[session-delete] descendants still running after stop for "${sessionId}":`, stillRunning.join(", "));
  }

  // 5. Evict the live sessions from the in-memory store. The session list is
  //    built from the live store plus persistence: without this step a
  //    deleted-but-open session keeps showing under the "ungrouped" surface
  //    even though its files are gone. The store's own detach entry is the
  //    teardown path (publication hooks + store removal + session/disposed
  //    event), so hooks the writer relies on are torn down in order. The
  //    disposal event also checkpoints the projection cache once, which the
  //    removal loop below then sweeps.
  for (const id of ids) {
    try {
      ctx.sessions.store?.get?.(id)?.detach?.();
    } catch (error) {
      ctx.logger?.warn?.(`[session-delete] store detach for "${id}":`, String(error?.message ?? error));
    }
  }

  // 6. Workspace accounting. Agent-spawned descendants are not accounted; the
  //    call is harmless for them and keeps a hand-moved id from lingering.
  try {
    if (typeof cwd === "string" && cwd.length > 0) {
      const workspace = await registry.resolveByPath(cwd);
      if (workspace !== void 0) {
        for (const id of ids) {
          try {
            await workspace.detachSession(id);
          } catch {
            /* not accounted */
          }
        }
      }
    }
  } catch (error) {
    ctx.logger?.warn?.(`[session-delete] detach step for "${sessionId}":`, String(error?.message ?? error));
  }

  // 7. Physical removal with a retry loop: a still-live writer may recreate
  //    the log directory once after the first removal; the loop outlasts it.
  //    Directories are re-resolved on every attempt: a session that was never
  //    materialized can get its directory created by the detach flush, i.e.
  //    after the first resolution.
  const home = dshHome();
  const root = sessionRoot(ctx, home);
  const dirsById = new Map();
  for (const id of ids) dirsById.set(id, await locateSessionDirs(root, id, headers.get(id)?.cwd));
  const spillById = await locateSpillDirs(ids);

  const removeOnce = async () => {
    for (const id of ids) {
      dirsById.set(id, await locateSessionDirs(root, id, headers.get(id)?.cwd));
      for (const dir of dirsById.get(id) ?? []) {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch {
          /* next attempt */
        }
      }
      try {
        await rm(projectionCachePath(home, id), { force: true });
      } catch {
        /* next attempt */
      }
      for (const spill of spillById.get(id) ?? []) {
        try {
          await rm(spill, { recursive: true, force: true });
        } catch {
          /* best effort — OS tmp cleanup sweeps spill roots anyway */
        }
      }
    }
  };

  const stillPresent = async (id) => {
    if ((await locateSessionDirs(root, id, headers.get(id)?.cwd)).length > 0) return true;
    try {
      await statPath(projectionCachePath(home, id));
      return true;
    } catch {
      return false;
    }
  };

  let remaining = ids;
  for (let attempt = 0; attempt < removalAttempts; attempt += 1) {
    await removeOnce();
    if (attempt < removalAttempts - 1) await sleep(retryDelayMs);
    const left = [];
    for (const id of ids) if (await stillPresent(id)) left.push(id);
    remaining = left;
    if (remaining.length === 0) break;
  }

  // 8. Registry-global sets (archive / pin) — leave no id behind.
  await clearGlobalSets(registry, ids);

  // 9. Journal whatever a live writer still holds; the next process start
  //    reaps it, when every session is cold.
  for (const id of ids) {
    if (remaining.includes(id)) await addPending(id);
    else await removePending(id);
  }

  ctx.logger?.info?.(
    `[session-delete] deleted "${sessionId}" (descendants=${descendantIds.length}, forks=${forks.length}`
      + `, remaining=${remaining.length})`
  );

  return {
    ok: true,
    deleted: ids,
    cascade: descendantIds.length,
    forks: forks.map((child) => child.id),
    ...remaining.length > 0 ? { deferred: true, remaining } : {}
  };
}

/**
 * Report what a delete would do, without touching anything. The browser half
 * uses this to word the confirmation step truthfully (how many agent child
 * sessions go with the parent, how many ordinary forks stay behind).
 */
async function previewSession(ctx, sessionId) {
  if (!isPlausibleSessionId(sessionId)) return { ok: false, reason: "invalid-id" };
  let stored;
  try {
    stored = await ctx.sessionPersistence.list();
  } catch (error) {
    return { ok: false, reason: "list-failed", message: String(error?.message ?? error) };
  }
  const live = ctx.sessions.get(sessionId);
  let liveHeader;
  try {
    liveHeader = live?.header;
  } catch {
    liveHeader = void 0;
  }
  let header = stored.find((snapshot) => snapshot.header?.id === sessionId)?.header;
  if (header === void 0) header = liveHeader;
  if (header === void 0) {
    try {
      header = await ctx.workspaceRegistry.readSessionHeader(sessionId);
    } catch {
      header = void 0;
    }
  }
  const exists = header !== void 0 || live !== void 0;
  if (!exists) return { ok: true, exists: false };

  const headers = collectHeaders(ctx, stored, header, sessionId);
  const { subagents, forks } = collectLineage(indexChildren(headers.values()), sessionId);
  const running = runningIds(ctx, subagents.map((child) => child.id));
  return {
    ok: true,
    exists: true,
    subagentChildren: subagents.length,
    runningChildren: running.length,
    forkChildren: forks.length
  };
}

/**
 * Guard the loopback endpoint against cross-site abuse: a foreign page must
 * not be able to POST session ids into the local harness. Browser-sent
 * `Sec-Fetch-Site` (Chromium always sets it) must not be `cross-site`, and a
 * present `Origin` must name a loopback host — the port is the deployment's
 * own choice, so it is not pinned here.
 */
function requestAllowed(req) {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site.length > 0) {
    if (site === "cross-site") return false;
    return true;
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    try {
      return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
    } catch {
      return false;
    }
  }
  // No Origin and no Sec-Fetch-Site: non-browser client. The loopback
  // webserver binds 127.0.0.1 only, so this is a local process.
  return true;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Read one query parameter out of a request URL that may be path-only. */
function queryParam(req, name) {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(name) ?? void 0;
  } catch {
    return void 0;
  }
}

// --- Pending-deletion journal ---------------------------------------------

/** Serialize read-modify-write cycles on the journal (two deletes can overlap). */
let pendingQueue = Promise.resolve();
function serializePending(operation) {
  const run = pendingQueue.then(operation, operation);
  pendingQueue = run.then(() => {}, () => {});
  return run;
}

async function readPending() {
  try {
    const parsed = JSON.parse(await readFile(pendingPath(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

async function writePending(ids) {
  try {
    const file = pendingPath();
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(ids, null, 2), "utf8");
  } catch {
    /* best effort */
  }
}

async function addPending(sessionId) {
  return serializePending(async () => {
    const ids = await readPending();
    if (ids.includes(sessionId)) return;
    await writePending([...ids, sessionId]);
  });
}

async function removePending(sessionId) {
  return serializePending(async () => {
    const ids = await readPending();
    if (!ids.includes(sessionId)) return;
    await writePending(ids.filter((id) => id !== sessionId));
  });
}

/**
 * Reap journaled sessions on plugin start: after a restart every session is
 * cold, so the removal cannot be undone by a live writer. Only directory
 * shapes matching the session layout are touched.
 */
async function reapPending(ctx) {
  const ids = await readPending();
  if (ids.length === 0) return;
  const home = dshHome();
  for (const id of ids) {
    if (!isPlausibleSessionId(id)) {
      await removePending(id);
      continue;
    }
    try {
      const root = sessionRoot(ctx, home);
      const encoded = encodeSegment(id);
      for (const projectName of await readdir(root).catch(() => [])) {
        const candidate = join(root, projectName, encoded);
        try {
          await statPath(candidate);
          await rm(candidate, { recursive: true, force: true });
        } catch {
          /* absent */
        }
      }
      await rm(projectionCachePath(home, id), { force: true });
      await clearGlobalSets(ctx.workspaceRegistry, [id]);
      await removePending(id);
      ctx.logger?.info?.(`[session-delete] reaped pending session "${id}"`);
    } catch (error) {
      ctx.logger?.warn?.(`[session-delete] failed to reap pending session "${id}":`, String(error?.message ?? error));
    }
  }
}

function apply(ctx) {
  void reapPending(ctx);

  const disposer = ctx.webServer.register({
    kind: "exact",
    path: ROUTE_PATH,
    handler: async (req, res) => {
      const json = (status, payload) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(payload));
      };
      if (!requestAllowed(req)) {
        json(403, { ok: false, reason: "forbidden" });
        return;
      }
      if (req.method === "GET") {
        const result = await previewSession(ctx, queryParam(req, "sessionId"));
        json(result.ok ? 200 : 409, result);
        return;
      }
      if (req.method !== "POST") {
        json(405, { ok: false, reason: "method-not-allowed" });
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        json(413, { ok: false, reason: "bad-request", message: String(error?.message ?? error) });
        return;
      }
      let sessionId;
      try {
        sessionId = JSON.parse(body || "{}").sessionId;
      } catch {
        json(400, { ok: false, reason: "bad-request" });
        return;
      }
      const result = await deleteSession(ctx, sessionId);
      json(result.ok ? 200 : 409, result);
    }
  });
  ctx.effect?.(() => disposer, "dsh-plugin-session-delete: HTTP route");
}

export {
  apply,
  inject,
  // Exported for the unit tests (pure or context-injected helpers only).
  collectLineage,
  deleteSession,
  encodeSegment,
  indexChildren,
  isPlausibleSessionId,
  previewSession,
  projectKey,
  reapPending
};
