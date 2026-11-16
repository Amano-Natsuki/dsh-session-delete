// Unit + route tests for dsh-plugin-session-delete.
//
// Run: node --test test/
//
// The host half imports only node: builtins, so the suite exercises the real
// deletion path against temporary directories and a mock cordis context —
// no harness restart needed to know whether lineage handling and the residue
// sweep still hold.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  apply,
  collectLineage,
  deleteSession,
  encodeSegment,
  indexChildren,
  isPlausibleSessionId,
  previewSession,
  projectKey,
  reapPending
} from "../lib/index.js";

const PROJECT = "C:\\Users\\Tester\\workspace";
const PROJECT_KEY = projectKey(PROJECT);

/** A temp harness home whose session layout mirrors the JSONL backend. */
async function makeHome() {
  const home = join(tmpdir(), `dsh-session-delete-test-${randomUUID()}`);
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "storages", "session_projcache", "sessions"), { recursive: true });
  await mkdir(join(home, "plugins"), { recursive: true });
  return home;
}

async function seedSession(home, id, { cwd = PROJECT, projectDirName } = {}) {
  const dir = join(home, "sessions", projectDirName ?? (cwd === void 0 ? "_no-cwd" : projectKey(cwd)), encodeSegment(id));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.v4.jsonl.zstd"), Buffer.alloc(4));
  await writeFile(join(home, "storages", "session_projcache", "sessions", `${id}.json`), "{}");
  return dir;
}

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

function header(id, extra = {}) {
  return {
    version: 4,
    id,
    createdAt: 1,
    delegationDepth: 0,
    isSeeded: false,
    cwd: PROJECT,
    ...extra
  };
}

/**
 * Mock host context. `headers` drives persistence.list()/stat(); `live` maps
 * session id → entry `{ session, detach }`, like the real SessionStore map.
 */
function makeCtx(headers, { live = new Map(), agents, listThrows = false } = {}) {
  const archived = new Set();
  const pinned = new Set();
  const stopped = [];
  const detached = [];
  const workspace = {
    detachSession: async () => {}
  };
  const registry = {
    readSessionHeader: async (id) => headers.get(id),
    resolveByPath: async () => workspace,
    archiveSession: async (id, options = {}) => {
      if (options.stopActivity === true) stopped.push(id);
      archived.add(id);
    },
    unarchiveSession: async (id) => {
      archived.delete(id);
    },
    unpinSession: async (id) => {
      pinned.delete(id);
    },
    get archivedSessionIds() {
      return [...archived];
    },
    get pinnedSessionIds() {
      return [...pinned];
    }
  };
  const persistence = {
    root: join(process.env.DSH_HOME, "sessions"),
    stat: async (id) => {
      const found = headers.get(id);
      if (found === void 0) throw new Error("session not found");
      return { header: found, revision: 1, sizeBytes: 0 };
    },
    list: async () => {
      if (listThrows) throw new Error("persistence unavailable");
      return [...headers.values()].map((found) => ({ header: found, revision: 1, sizeBytes: 0 }));
    }
  };
  const sessions = {
    get: (id) => live.get(id)?.session,
    store: live
  };
  const webRoutes = [];
  const ctx = {
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    sessions,
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === "agents") return agents;
      if (name === "sessions") return sessions;
      return void 0;
    },
    webServer: {
      register(route) {
        webRoutes.push(route);
        return () => {};
      }
    },
    effect() {},
    routes: webRoutes
  };
  return { ctx, archived, pinned, stopped, detached, workspace };
}

function addLive(live, id, extra = {}) {
  const entry = {
    session: { id, header: header(id, extra) },
    detach() {
      live.delete(id);
      entry.detached = true;
    }
  };
  live.set(id, entry);
  return entry;
}

/** Invoke a registered HTTP route with a fake request/response pair. */
async function callRoute(route, { method = "POST", url = "/api/session-delete", headers = {}, body } = {}) {
  const req = {
    method,
    url,
    headers,
    on(event, listener) {
      if (event === "data" && body !== void 0) listener(Buffer.from(body));
      if (event === "end") listener();
    },
    destroy() {}
  };
  let payload = "";
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk) {
      payload += chunk ?? "";
    }
  };
  await route.handler(req, res);
  return { status: res.statusCode, json: payload === "" ? void 0 : JSON.parse(payload) };
}

const options = { quietAfterStopMs: 0, retryDelayMs: 0, removalAttempts: 2, idleWaitMs: 0 };

test.beforeEach(async () => {
  process.env.DSH_HOME = await makeHome();
});

test.afterEach(async () => {
  const home = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  if (home !== void 0) await rm(home, { recursive: true, force: true });
});

// --- pure helpers ----------------------------------------------------------

test("session-id and path helpers mirror the JSONL backend", () => {
  assert.equal(encodeSegment("session-0b36"), "session-0b36");
  assert.equal(encodeSegment("a/b"), "a~002Fb");
  assert.equal(encodeSegment("."), "~002E");
  assert.equal(encodeSegment(".."), "~002E~002E");
  assert.equal(projectKey("C:\\a\\b"), "--C-a-b--");
  assert.equal(projectKey("C:\\Users\\Tester\\workspace"), "--C-Users-Tester-workspace--");
  assert.equal(isPlausibleSessionId("session-1"), true);
  assert.equal(isPlausibleSessionId("0b3699d8-eb6a-431f-a005-cf71d504b227"), true);
  assert.equal(isPlausibleSessionId("../x"), false);
  assert.equal(isPlausibleSessionId(""), false);
});

test("lineage descends agent-spawned children only", () => {
  const headers = [
    header("root"),
    header("child-a", { parentSession: "root", origin: "subagent", delegationDepth: 1 }),
    header("child-b", { parentSession: "root", origin: "subagent", delegationDepth: 1 }),
    header("grandchild", { parentSession: "child-a", origin: "subagent", delegationDepth: 2 }),
    header("legacy-fork", { parentSession: "root", isSeeded: true }),
    header("under-fork", { parentSession: "legacy-fork", origin: "subagent", delegationDepth: 1 })
  ];
  const { subagents, forks } = collectLineage(indexChildren(headers), "root");
  assert.deepEqual(subagents.map((item) => item.id), ["child-a", "child-b", "grandchild"]);
  assert.deepEqual(forks.map((item) => item.id), ["legacy-fork"]);
});

// --- preview ---------------------------------------------------------------

test("preview counts agent children, running children, and ordinary forks", async () => {
  const home = process.env.DSH_HOME;
  const headers = new Map([
    ["root", header("root")],
    ["child-a", header("child-a", { parentSession: "root", origin: "subagent", delegationDepth: 1 })],
    ["child-b", header("child-b", { parentSession: "root", origin: "subagent", delegationDepth: 1 })],
    ["fork", header("fork", { parentSession: "root", isSeeded: true })]
  ]);
  const agents = {
    get: (id) => ({ status: id === "child-a" ? "running" : "idle" })
  };
  const { ctx } = makeCtx(headers, { agents });
  for (const id of headers.keys()) await seedSession(home, id);

  const preview = await previewSession(ctx, "root");
  assert.deepEqual(preview, {
    ok: true,
    exists: true,
    subagentChildren: 2,
    runningChildren: 1,
    forkChildren: 1
  });

  assert.deepEqual(await previewSession(ctx, "missing"), { ok: true, exists: false });
  assert.deepEqual(await previewSession(ctx, "../nope"), { ok: false, reason: "invalid-id" });
});

test("preview reports a failed listing instead of pretending there are no children", async () => {
  const headers = new Map([["root", header("root")]]);
  const { ctx } = makeCtx(headers, { listThrows: true });
  assert.deepEqual(await previewSession(ctx, "root"), {
    ok: false,
    reason: "list-failed",
    message: "persistence unavailable"
  });
});

// --- deletion --------------------------------------------------------------

test("delete cascades agent children, keeps ordinary forks, clears every surface", async () => {
  const home = process.env.DSH_HOME;
  const headers = new Map([
    ["root", header("root")],
    ["child-a", header("child-a", { parentSession: "root", origin: "subagent", delegationDepth: 1 })],
    ["child-b", header("child-b", { parentSession: "root", origin: "subagent", delegationDepth: 1, cwd: "C:\\Other\\dir" })],
    ["grandchild", header("grandchild", { parentSession: "child-a", origin: "subagent", delegationDepth: 2 })],
    ["fork", header("fork", { parentSession: "root", isSeeded: true })]
  ]);
  const live = new Map();
  addLive(live, "root");
  addLive(live, "child-a", { parentSession: "root", origin: "subagent" });
  const { ctx, archived, stopped, workspace } = makeCtx(headers, { live });
  archived.add("root"); // archived parents must not be re-stopped with work

  const dirs = {};
  for (const id of headers.keys()) dirs[id] = await seedSession(home, id);

  const result = await deleteSession(ctx, "root", options);
  assert.equal(result.ok, true);
  assert.equal(result.cascade, 3);
  assert.deepEqual(result.deleted, ["root", "child-a", "child-b", "grandchild"]);
  assert.deepEqual(result.forks, ["fork"]);

  for (const id of ["root", "child-a", "child-b", "grandchild"]) {
    assert.equal(await exists(dirs[id]), false, `${id} log directory removed`);
    assert.equal(await exists(join(home, "storages", "session_projcache", "sessions", `${id}.json`)), false, `${id} projection removed`);
  }
  assert.equal(await exists(dirs.fork), true, "ordinary fork stays");
  assert.equal(await exists(join(home, "storages", "session_projcache", "sessions", "fork.json")), true, "fork projection stays");

  assert.deepEqual(stopped, ["root"]);
  assert.deepEqual([...archived], [], "archive set cleaned for every deleted id");
  assert.equal(live.has("root"), false);
  assert.equal(live.has("child-a"), false);
  assert.ok(workspace.detachSession);
  assert.deepEqual(await readFile(join(home, "plugins", "session-delete.pending.json"), "utf8").catch(() => ""), "");
});

test("delete finds a session directory under an unexpected project key", async () => {
  const home = process.env.DSH_HOME;
  const headers = new Map([["root", header("root")]]);
  const { ctx } = makeCtx(headers);
  const dir = await seedSession(home, "root", { projectDirName: "--moved-elsewhere--" });
  const result = await deleteSession(ctx, "root", options);
  assert.equal(result.ok, true);
  assert.equal(await exists(dir), false);
});

test("delete journals files a live writer still holds and reaps them on start", async () => {
  const home = process.env.DSH_HOME;
  const headers = new Map([["root", header("root")]]);
  const { ctx } = makeCtx(headers);
  const dir = await seedSession(home, "root");
  // A directory squatting on the projection file cannot be unlinked without
  // recursion, so the sweep reports the id as still present and journals it.
  const projection = join(home, "storages", "session_projcache", "sessions", "root.json");
  await rm(projection, { force: true });
  await mkdir(projection, { recursive: true });

  const result = await deleteSession(ctx, "root", options);
  assert.equal(result.ok, true);
  assert.equal(result.deferred, true);
  assert.deepEqual(result.remaining, ["root"]);
  const pending = JSON.parse(await readFile(join(home, "plugins", "session-delete.pending.json"), "utf8"));
  assert.deepEqual(pending, ["root"]);
  assert.equal(await exists(dir), false, "log directory is already gone");

  await rm(projection, { recursive: true, force: true });
  await reapPending(ctx);
  assert.deepEqual(JSON.parse(await readFile(join(home, "plugins", "session-delete.pending.json"), "utf8")), []);
});

test("a failed listing refuses the delete and touches nothing", async () => {
  const home = process.env.DSH_HOME;
  const headers = new Map([["root", header("root")]]);
  const { ctx, stopped } = makeCtx(headers, { listThrows: true });
  const dir = await seedSession(home, "root");
  const result = await deleteSession(ctx, "root", options);
  assert.deepEqual(result, { ok: false, reason: "list-failed", message: "persistence unavailable" });
  assert.equal(await exists(dir), true);
  assert.deepEqual(stopped, []);
});

test("missing and malformed ids are refused", async () => {
  const headers = new Map();
  const { ctx } = makeCtx(headers);
  assert.deepEqual(await deleteSession(ctx, "missing", options), { ok: false, reason: "not-found" });
  assert.deepEqual(await deleteSession(ctx, "../etc", options), { ok: false, reason: "invalid-id" });
});

test("deleting an agent child only takes its own subtree", async () => {
  const home = process.env.DSH_HOME;
  const headers = new Map([
    ["root", header("root")],
    ["child", header("child", { parentSession: "root", origin: "subagent", delegationDepth: 1 })],
    ["grandchild", header("grandchild", { parentSession: "child", origin: "subagent", delegationDepth: 2 })]
  ]);
  const { ctx } = makeCtx(headers);
  const dirs = {};
  for (const id of headers.keys()) dirs[id] = await seedSession(home, id);

  const result = await deleteSession(ctx, "child", options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.deleted, ["child", "grandchild"]);
  assert.equal(await exists(dirs.root), true, "parent untouched");
  assert.equal(await exists(dirs.child), false);
  assert.equal(await exists(dirs.grandchild), false);
});

// --- HTTP route ------------------------------------------------------------

test("route previews with GET, deletes with POST, and guards the method", async () => {
  const home = process.env.DSH_HOME;
  const headers = new Map([
    ["root", header("root")],
    ["child", header("child", { parentSession: "root", origin: "subagent", delegationDepth: 1 })]
  ]);
  const { ctx } = makeCtx(headers);
  for (const id of headers.keys()) await seedSession(home, id);
  apply(ctx);
  assert.equal(ctx.routes.length, 1);
  const route = ctx.routes[0];
  assert.equal(route.path, "/api/session-delete");

  const preview = await callRoute(route, { method: "GET", url: "/api/session-delete?sessionId=root" });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.subagentChildren, 1);

  const method = await callRoute(route, { method: "DELETE" });
  assert.equal(method.status, 405);
  assert.equal(method.json.reason, "method-not-allowed");

  const crossSite = await callRoute(route, {
    method: "POST",
    headers: { "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ sessionId: "root" })
  });
  assert.equal(crossSite.status, 403);

  const badBody = await callRoute(route, { method: "POST", body: "not json" });
  assert.equal(badBody.status, 400);

  const deleted = await callRoute(route, { method: "POST", body: JSON.stringify({ sessionId: "root" }) });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.ok, true);
  assert.deepEqual(deleted.json.deleted, ["root", "child"]);
});
