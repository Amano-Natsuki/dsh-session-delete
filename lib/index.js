/**
 * dsh-session-delete — host half.
 *
 * Permanently deletes one DSH session with zero local residue. The browser
 * half renders a "delete session" menu entry and calls this host half through
 * the loopback HTTP route registered below (profile plugins have no
 * harness.handle/host.call channel — that belongs to dynamic sandbox
 * packages).
 *
 * Storage surfaces cleared, in order:
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
 *   - deleting a session that has fork children is refused
 *   - running work is stopped through the archive stopActivity waterfall
 *     (the same gate that blocks re-wakes for archived sessions)
 *
 * Directory encoding (projectKey / encodeSegment) mirrors
 * @deepseek-ai/dsh-session-persistence-jsonl verbatim so this plugin resolves
 * the exact session directory without importing the asar-packaged package.
 */
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";

/** Services this plugin reaches through the host cordis context. */
const inject = [
  "webServer",
  "workspaceRegistry",
  "sessionPersistence",
  "sessions"
];

/** HTTP route the browser half calls. */
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

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Hostnames a loopback web surface may legitimately use, whatever its port. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Encode one path segment exactly like the JSONL backend: safe characters
 * pass through, everything else becomes `~XXXX` (UTF-16 code unit, uppercase
 * hex, zero-padded to four).
 */
function encodeSegment(value) {
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

/**
 * Delete one session durably.
 * @returns `{ ok: true }`, or a structured refusal.
 */
async function deleteSession(ctx, sessionId) {
  if (!isPlausibleSessionId(sessionId)) return { ok: false, reason: "invalid-id" };
  const registry = ctx.workspaceRegistry;

  // 1. Existence + header (the header carries the canonical cwd).
  let stat;
  try {
    stat = await ctx.sessionPersistence.stat(sessionId);
  } catch {
    stat = void 0;
  }
  const live = ctx.sessions.get(sessionId);
  let header = stat?.header;
  if (header === void 0) {
    try {
      header = await registry.readSessionHeader(sessionId);
    } catch {
      header = void 0;
    }
  }
  if (header === void 0 && live === void 0) return { ok: false, reason: "not-found" };
  const cwd = header?.cwd;

  // 2. Refuse when fork children exist — deleting their parent would orphan
  //    the durable lineage recorded in every child header.
  //    `list()` returns snapshots: one `{ header, revision, sizeBytes }` per
  //    session, so the durable header fields live on `.header`.
  let stored = [];
  try {
    stored = await ctx.sessionPersistence.list();
  } catch {
    stored = [];
  }
  const children = stored.filter((snapshot) => snapshot.header?.parentSession === sessionId).map((snapshot) => snapshot.header.id);
  if (children.length > 0) {
    return { ok: false, reason: "has-children", children: children.slice(0, 10) };
  }

  // 3. Stop running work through the archive stopActivity waterfall. The
  //    durable archive set gates every wake the stops induce; the id is
  //    dropped from the set again after removal, so nothing lingers.
  try {
    await registry.archiveSession(sessionId, { stopActivity: true });
  } catch (error) {
    ctx.logger?.warn?.(`[session-delete] archive/stop step for "${sessionId}":`, String(error?.message ?? error));
  }

  // 4. Let the stopped session settle: its final turn/end checkpoint and the
  //    projection-cache write-behind may still flush once after the stop.
  //    Removing files before that flush would let the live writer recreate
  //    them (the "deleted session reappears as ungrouped" failure).
  await sleep(QUIET_AFTER_STOP_MS);

  // 5. Evict a live session from the in-memory store. The session list is
  //    built from the live store plus persistence: without this step a
  //    deleted-but-open session keeps showing under the "ungrouped" surface
  //    even though its files are gone. The store's own detach entry is the
  //    teardown path (publication hooks + store removal + session/disposed
  //    event), so hooks the writer relies on are torn down in order. The
  //    disposal event also checkpoints the projection cache once, which the
  //    removal loop below then sweeps.
  try {
    const storeEntry = ctx.sessions.store?.get(sessionId);
    storeEntry?.detach?.();
  } catch (error) {
    ctx.logger?.warn?.(`[session-delete] store detach for "${sessionId}":`, String(error?.message ?? error));
  }

  // 6. Workspace accounting.
  try {
    if (cwd !== void 0) {
      const workspace = await registry.resolveByPath(cwd);
      if (workspace !== void 0) await workspace.detachSession(sessionId);
    }
  } catch (error) {
    ctx.logger?.warn?.(`[session-delete] detach step for "${sessionId}":`, String(error?.message ?? error));
  }

  // 7. Physical removal with a retry loop: a still-live writer may recreate
  //    the log directory once after the first removal; the loop outlasts it.
  const home = dshHome();
  const projectDirName = cwd === void 0 ? "_no-cwd" : projectKey(cwd);
  const sessionDir = join(sessionRoot(ctx, home), projectDirName, encodeSegment(sessionId));
  const projcacheFile = join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
  const spillHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);

  const removeOnce = async () => {
    try {
      await rm(sessionDir, { recursive: true, force: true });
    } catch {
      /* next attempt */
    }
    try {
      await rm(projcacheFile, { force: true });
    } catch {
      /* next attempt */
    }
    try {
      for (const name of await readdir(tmpdir())) {
        if (/^dsh-spill-[A-Za-z0-9]{6}$/.test(name)) {
          await rm(join(tmpdir(), name, `session-${spillHash}`), { recursive: true, force: true });
        }
      }
    } catch {
      /* best effort — OS tmp cleanup sweeps spill roots anyway */
    }
  };

  const gone = async () => {
    try {
      await stat(sessionDir);
      return false;
    } catch {
      /* absent */
    }
    try {
      await stat(projcacheFile);
      return false;
    } catch {
      return true;
    }
  };

  let removed = false;
  for (let attempt = 0; attempt < REMOVAL_ATTEMPTS; attempt += 1) {
    await removeOnce();
    if (attempt < REMOVAL_ATTEMPTS - 1) await sleep(REMOVAL_RETRY_DELAY_MS);
    if (await gone()) {
      removed = true;
      break;
    }
  }

  // 8. Registry-global sets (archive / pin) — leave no id behind.
  try {
    if (registry.archivedSessionIds.includes(sessionId)) await registry.unarchiveSession(sessionId);
  } catch {
    /* best effort */
  }
  try {
    if (registry.pinnedSessionIds.includes(sessionId)) await registry.unpinSession(sessionId);
  } catch {
    /* best effort */
  }

  if (removed) {
    await removePending(sessionId);
    return { ok: true };
  }
  // Live writer still holds the files (or a handle keeps them busy): the
  // next process start reaps them, when every session is cold.
  await addPending(sessionId);
  return { ok: true, deferred: true };
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

// --- Pending-deletion journal ---------------------------------------------

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
  const ids = await readPending();
  if (ids.includes(sessionId)) return;
  await writePending([...ids, sessionId]);
}

async function removePending(sessionId) {
  const ids = await readPending();
  if (!ids.includes(sessionId)) return;
  await writePending(ids.filter((id) => id !== sessionId));
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
      for (const projectName of await readdir(root).catch(() => [])) {
        const candidate = join(root, projectName, id);
        try {
          await stat(candidate);
          await rm(candidate, { recursive: true, force: true });
        } catch {
          /* absent */
        }
      }
      await rm(join(home, "storages", "session_projcache", "sessions", `${id}.json`), { force: true });
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
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: false, reason: "method-not-allowed" }));
        return;
      }
      if (!requestAllowed(req)) {
        res.statusCode = 403;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: false, reason: "forbidden" }));
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        res.statusCode = 413;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: false, reason: "bad-request", message: String(error?.message ?? error) }));
        return;
      }
      let sessionId;
      try {
        sessionId = JSON.parse(body || "{}").sessionId;
      } catch {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: false, reason: "bad-request" }));
        return;
      }
      const result = await deleteSession(ctx, sessionId);
      res.statusCode = result.ok ? 200 : 409;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    }
  });
  ctx.effect?.(() => disposer, "dsh-session-delete: HTTP route");
}

export { apply, inject };
