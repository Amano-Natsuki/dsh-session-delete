// Browser-half tests: run the real lib/client.js inside a minimal browser +
// React-hooks stand-in, so the menu copy, the preview round-trip, and the
// localStorage cleanup are exercised without a harness restart or a browser.
//
// Run: node --test test/client.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

// --- browser stand-ins -----------------------------------------------------

/** The module is loaded once; the factory is reused with fresh fakes. */
let cachedFactory;

async function loadFactory() {
  if (cachedFactory !== void 0) return cachedFactory;
  globalThis.window = {
    location: { origin: "http://127.0.0.1:5000" },
    __ModuleLoader__: {
      load({ factory }) {
        cachedFactory = factory;
      }
    }
  };
  await import("../lib/client.js");
  return cachedFactory;
}

function makeStorage(entries) {
  const map = new Map(entries);
  return {
    map,
    localStorage: {
      get length() {
        return map.size;
      },
      key(index) {
        return [...map.keys()][index] ?? null;
      },
      getItem(key) {
        return map.has(key) ? map.get(key) : null;
      },
      setItem(key, value) {
        map.set(key, String(value));
      },
      removeItem(key) {
        map.delete(key);
      }
    }
  };
}

/** Minimal React: createElement, useState, useRef, useEffect with re-render. */
function createReact() {
  let active;
  const schedule = () => {
    if (active === void 0 || active.scheduled) return;
    active.scheduled = true;
    Promise.resolve().then(() => {
      active.scheduled = false;
      active.render();
    });
  };
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState(initial) {
      const index = active.cursor++;
      if (!(index in active.values)) {
        active.values[index] = typeof initial === "function" ? initial() : initial;
      }
      const set = (next) => {
        const previous = active.values[index];
        const value = typeof next === "function" ? next(previous) : next;
        if (Object.is(value, previous)) return;
        active.values[index] = value;
        schedule();
      };
      return [active.values[index], set];
    },
    useRef(initial) {
      const index = active.cursor++;
      if (!(index in active.values)) active.values[index] = { current: initial };
      return active.values[index];
    },
    useEffect() {
      active.cursor += 1; // dependency array is ignored; cleanups never run here
    }
  };
  const mount = (component, props) => {
    const ctx = { values: [], cursor: 0, scheduled: false, current: undefined };
    ctx.render = () => {
      active = ctx;
      ctx.cursor = 0;
      ctx.current = component(props);
    };
    ctx.render();
    return ctx;
  };
  return { React, mount };
}

/** Run the module factory and register the sidebar menu item. */
function mountMenu(factory, { fetchImpl, storage, language = "zh-CN" }) {
  Object.defineProperty(globalThis, "navigator", { value: { language }, configurable: true });
  globalThis.localStorage = storage.localStorage;
  globalThis.fetch = fetchImpl;

  const { React, mount } = createReact();
  const require = (name) => {
    if (name === "react") return React;
    throw new Error(`unexpected module: ${name}`);
  };
  const pluginModule = factory(require);

  const state = { refreshed: 0, menuOpen: true };
  const sessions = {
    refresh() {
      state.refreshed += 1;
    }
  };
  let registration;
  const ctx = {
    get(name) {
      return name === "sessions" ? sessions : void 0;
    },
    slots: {
      inject(name, run) {
        run();
      },
      register(config, render) {
        registration = { config, render };
        return () => {};
      }
    }
  };
  pluginModule.apply(ctx);
  assert.equal(registration.config.id, "session-delete");

  const element = registration.render({
    sessionId: "session-1",
    useMenuOpenState: () => [state.menuOpen, (open) => (state.menuOpen = open)]
  });
  const component = mount(element.type, element.props);
  const button = () => component.current;
  const label = () => [].concat(button().children).join("");
  return { state, button, label, pluginModule };
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

/** Record GET/POST calls and answer with the supplied bodies. */
function makeFetch({ preview, deletion }) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET" });
    if ((options.method ?? "GET") === "GET") return jsonResponse(preview);
    return jsonResponse(deletion);
  };
  return { calls, impl };
}

// --- tests -----------------------------------------------------------------

test("first click previews agent children and words the confirmation", async () => {
  const factory = await loadFactory();
  const storage = makeStorage([]);
  const preview = { ok: true, exists: true, subagentChildren: 3, runningChildren: 1, forkChildren: 0 };
  const calls = [];
  let release;
  const impl = (url, options = {}) => new Promise((resolve) => {
    calls.push({ url, method: options.method ?? "GET" });
    release = () => resolve(jsonResponse(preview));
  });
  const { button, label } = mountMenu(factory, { fetchImpl: impl, storage });
  assert.equal(label(), "删除会话…");

  button().props.onClick();
  await flush();
  assert.equal(label(), "检查子会话…", "the row shows that the preview is running");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");

  release();
  await flush();
  assert.match(label(), /将同时删除 3 个 Agent 子会话/);
  assert.match(label(), /其中 1 个正在运行/);
});

test("ordinary forks are reported as kept", async () => {
  const factory = await loadFactory();
  const storage = makeStorage([]);
  const { impl } = makeFetch({
    preview: { ok: true, exists: true, subagentChildren: 0, runningChildren: 0, forkChildren: 2 }
  });
  const { button, label } = mountMenu(factory, { fetchImpl: impl, storage });
  button().props.onClick();
  await flush();
  assert.match(label(), /删除会话|确认永久删除/);
  assert.match(label(), /2 个普通 fork 子会话会保留/);
});

test("an already-gone session closes the menu and drops its page state", async () => {
  const factory = await loadFactory();
  const storage = makeStorage([
    ["dsh.conversation.session-1", "{}"],
    ["dsh.workspace.view.v5", JSON.stringify({ order: ["session-1"] })]
  ]);
  const { impl } = makeFetch({ preview: { ok: true, exists: false } });
  const { state, button, label } = mountMenu(factory, { fetchImpl: impl, storage });
  button().props.onClick();
  await flush();
  assert.equal(state.menuOpen, false);
  assert.equal(storage.map.has("dsh.conversation.session-1"), false);
  assert.equal(storage.map.has("dsh.workspace.view.v5"), true, "global preferences survive");
});

test("second click deletes, clears per-session keys only, and refreshes the list", async () => {
  const factory = await loadFactory();
  const storage = makeStorage([
    ["dsh.conversation.session-1", "{}"],
    ["dsh.conversation.child-1", "{}"],
    ["dsh.sidebar-right.v1.session-1", "{}"],
    ["dsh.sessions.current", JSON.stringify("session-1")],
    ["dsh.workspace.view.v5", JSON.stringify({ order: ["session-1", "child-1"] })],
    ["unrelated.key", "session-1"]
  ]);
  const { calls, impl } = makeFetch({
    preview: { ok: true, exists: true, subagentChildren: 1, runningChildren: 0, forkChildren: 0 },
    deletion: { ok: true, deleted: ["session-1", "child-1"], cascade: 1 }
  });
  const { state, button, label } = mountMenu(factory, { fetchImpl: impl, storage });

  button().props.onClick();
  await flush();
  button().props.onClick();
  await flush();

  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST"]);
  assert.equal(state.menuOpen, false, "menu closes after the committed delete");
  assert.equal(state.refreshed, 1, "the sidebar list is re-pulled");
  for (const key of [
    "dsh.conversation.session-1",
    "dsh.conversation.child-1",
    "dsh.sidebar-right.v1.session-1",
    "dsh.sessions.current"
  ]) {
    assert.equal(storage.map.has(key), false, `${key} cleared`);
  }
  assert.equal(storage.map.has("dsh.workspace.view.v5"), true, "global view state kept");
  assert.equal(storage.map.has("unrelated.key"), true, "keys that merely mention the id are kept");
});

test("preview failures fall back to the plain confirmation", async () => {
  const factory = await loadFactory();
  const storage = makeStorage([]);
  const { button, label } = mountMenu(factory, {
    storage,
    fetchImpl: async () => {
      throw new Error("offline");
    }
  });
  button().props.onClick();
  await flush();
  assert.equal(label(), "确认永久删除?此操作不可撤销");
});

test("English copy follows a non-zh browser locale", async () => {
  const factory = await loadFactory();
  const storage = makeStorage([]);
  const { impl } = makeFetch({
    preview: { ok: true, exists: true, subagentChildren: 2, runningChildren: 0, forkChildren: 0 }
  });
  const { button, label } = mountMenu(factory, { fetchImpl: impl, storage, language: "en-US" });
  assert.equal(label(), "Delete session\u2026");
  button().props.onClick();
  await flush();
  assert.match(label(), /2 agent child session\(s\) will be deleted too/);
});
