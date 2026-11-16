# dsh-plugin-session-delete

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that **permanently deletes a session** from the sidebar menu — with a confirmation step, no running work left behind, and **zero local residue**.

DSH ships with archive only; an archived session stays on disk forever. This plugin adds the missing operation: a real, irreversible delete that cleans every storage surface the session touched.

[中文说明](#中文说明)

---

## Features

- **Sidebar menu entry** — a red *Delete session…* row at the bottom of every session's context menu, with a two-step inline confirmation (the label turns into *Confirm permanent deletion?* and resets after 5 seconds).
- **Agent child sessions go with their parent** — a session an Agent opened (subagent tool, `subagent`, workflow, Agent Teams) records `parentSession` + `origin: "subagent"`. Those children are hidden from the sidebar and reachable only through the parent's descendant catalog, so they are deleted together with the parent, at any depth. The first click asks the host what the delete would take (`GET /api/session-delete?sessionId=…`) and the confirmation names the count, e.g. *“Confirm permanent deletion? 3 agent child session(s) (1 running) will be deleted too”*.
- **Ordinary forks are preserved** — a fork is an independent conversation whose history was copied; current builds do not even record a parent on it. If a historical fork still names the deleted session, it stays and its `parentSession` merely dangles (DSH's list indentation and resume admission key off the subagent origin, so this is inert). The confirmation says how many forks stay behind.
- **Safety gates**
  - the session must exist (`not-found`)
  - lineage comes from `sessionPersistence.list()`; a failed listing refuses the delete (`list-failed`) instead of assuming "no children" — fail closed, never open
  - running work is stopped first through the archive `stopActivity` waterfall (the same gate that blocks re-wakes for archived sessions); that waterfall also cancels running subagent descendants, and the delete waits (bounded) for them to settle before touching files
- **Zero local residue** — removes, in order, **for the session and every agent child it takes with it**:
  1. the **live store entry** (the store's own detach path, which also emits `session/disposed` so the sidebar drops the row immediately)
  2. **workspace accounting** (`sessionIds`)
  3. **archive / pin sets** (`archivedSessionIds`, `pinnedSessionIds`)
  4. the **event-log directory** `<persistence root>/<projectKey>/<encodedSessionId>/`
  5. the **projection cache** entry `<harness home>/storages/session_projcache/sessions/<id>.json`
  6. **spill files** `<tmp>/dsh-spill-*/session-<sha256(id)[:12]>/`
- **Browser-side state** — the delete clears this page's persisted per-session keys (`<store>.session-<id>` for top-level sessions, `<store>.<uuid>` for agent children) and the page's current-session key when it names the deleted id, then re-pulls the session list from the host. Global keys that merely *mention* an id are kept on purpose: `dsh.workspace.view.v5` carries grouping, order, pin and archive-filter preferences, and deleting it because one id appears inside would reset preferences for every session.
- **Live-session handling** — a session that was opened once keeps a writer for the process lifetime. The plugin stops its activity, waits for the settling flush, then removes files in a short retry loop. If a file is still held, the id is journaled and reaped automatically on the next start (when every session is cold).
- **No page reload, and no stale row for cold sessions** — a never-opened session is absent from the host's live store, so its removal emits no `session/disposed` (and therefore no forwarded `api-session/removed` frame); the browser half re-pulls the authoritative list after a committed delete, which covers both cold and live sessions. Without that pull the sidebar keeps a row whose history no longer loads (`session/not-found`).
- **Localized menu copy** — Chinese for `zh*` browser locales, English otherwise; colors follow the active theme through DSH theme tokens.

## Requirements

- DeepSeek Harness desktop `0.2.0-rc.2` or a compatible build with the same plugin surface:
  - host services `webServer`, `workspaceRegistry`, `sessionPersistence`, `sessions`
  - optionally `agents` (only used to report/await running children; the delete works without it)
  - the browser slot `sidebar.workspaces.session.menu.item`
  - the JSONL session-persistence backend (the default `session-persistence-jsonl` root layout)
- The plugin declares **no peer dependencies**, so the compatibility preflight never disables it; if a future DSH version changes the storage layout, review the paths below before upgrading.

## Platform support

Windows, macOS, and Linux — the plugin holds no platform-specific assumptions:

- every path is composed with `node:path` (`join`), never a hard-coded separator
- the session-directory encoding mirrors DSH's own `projectKey` / `encodeSegment`, which fold `\`, `/`, and `:` the same way on every platform
- the session root comes from the mounted backend (`sessionPersistence.root`), so a relocated root is honored; a session directory that sits under an unexpected project key is still found by scanning the root for the encoded id
- the harness home follows `$DSH_HOME` → `~/.dsh`, with both `~/` and `~\` prefixes expanded
- the loopback guard accepts `127.0.0.1`, `localhost`, `::1`, and `[::1]`, so a macOS host that resolves `localhost` to IPv6 is still accepted
- file removal uses `fs.rm({ recursive: true, force: true })`; macOS/Linux unlink semantics are more permissive than Windows, so the live-writer retry loop only ever helps there
- the browser half is platform-neutral by construction

## Install

### From the npm registry (recommended)

```bash
dsh plugin install dsh-plugin-session-delete
```

The plugin manager installs the package into the active profile and registers the row. If you prefer the UI, the same package is installable from **Settings → Plugins**. Restart the harness afterwards, then a red *Delete session…* row appears in each session's context menu.

### Manual (git clone + deploy script)

Clone into a folder of your choice and deploy it into a profile:

```bash
git clone https://github.com/Amano-Natsuki/dsh-session-delete.git
cd dsh-session-delete
node scripts/deploy.mjs desktop        # profile name, default "desktop"
```

The script copies the package into `<DSH_HOME or ~/.dsh>/profiles/<profile>/node_modules/dsh-plugin-session-delete/`.

Then register the row in the profile patch `<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: session-delete
      name: './node_modules/dsh-plugin-session-delete/lib/index.js'
```

and declare the dependency in `<profile>/package.json`:

```json
{
  "dependencies": {
    "dsh-plugin-session-delete": "link:./node_modules/dsh-plugin-session-delete"
  }
}
```

Restart the harness. A red *Delete session…* row appears in each session's context menu.

> The manual entry uses a **relative path** on purpose: at cold boot the loader's resolution base is unset, so a bare package name cannot reach the profile's `node_modules`. `parsePatchList` anchors relative paths to the patch file's directory and loads them as file URLs. The npm-installed flow registers the bare package name instead and relies on DSH's profile resolution layer.

## Architecture

| Half | File | Role |
| --- | --- | --- |
| Host | `lib/index.js` | Registers the loopback route `GET/POST /api/session-delete` and performs the whole deletion. Profile plugins have no `harness.handle`/`host.call` channel (that belongs to dynamic sandbox packages), so the browser half calls this route over same-origin `fetch`. |
| Browser | `lib/client.js` | Registers a `sidebar.workspaces.session.menu.item` entry, renders the two-step confirm button, previews the child-session counts, calls the route, and closes the menu. Delivered by `dsh-client-modules` through `exports["./client"]` + the `dsh.client` declaration. |

**Route.**
- `GET /api/session-delete?sessionId=<id>` → `{ ok, exists, subagentChildren, runningChildren, forkChildren }`; read-only, used to word the confirmation.
- `POST /api/session-delete` with `{ "sessionId": "<id>" }` → `{ ok, deleted: [...ids], cascade, forks, deferred?, remaining? }`, or a structured refusal (`invalid-id`, `not-found`, `list-failed`).

**Lineage.** Children are indexed from every persisted header plus live session headers (a child spawned a moment ago may not be materialized yet). Only `origin: "subagent"` children are descended into; anything else that names a parent is an ordinary fork and is left alone — its own subtree is never part of this delete.

**Security.** The route rejects cross-site requests (`Sec-Fetch-Site: cross-site`, or an `Origin` that is not a loopback host), and validates the session id against a strict character whitelist before touching any path.

**Path resolution.** The session root is read from the mounted persistence backend when it exposes one (`sessionPersistence.root`), falling back to `<harness home>/sessions`; the harness home follows the `$DSH_HOME` → `~/.dsh` precedence. Directory encoding (`projectKey` / `encodeSegment`) mirrors `@deepseek-ai/dsh-session-persistence-jsonl` so the exact session directory is resolved without importing the asar-packaged package.

## Known limits

- **Telemetry already sent** to the DeepSeek OTLP collector cannot be recalled; this plugin only clears local state.
- **Other sessions' content** that mentions the deleted session (message text, references) belongs to those sessions and is left untouched.
- **An ordinary fork's header** may still name its deleted parent (`parentSession`) — that header is the child's own durable data. DSH admits such historical forks, and the relation is only decoration for non-subagent origins.
- **Scheduled tasks** that target (or were created by) the deleted session are not removed: the `schedule` domain is its own durable store (`<DSH_HOME>/storages/schedule…`, `involvedSessionIds`), not per-session state. Delete those tasks first if they must not outlive the session.
  (Agent-team rosters, task boards and journals are *inside* the Lead session log, so they go with the session; teammate sessions are its agent children.)
- The **projection-cache path** assumes the default `storage-json` root (`<harness home>/storages`). A profile that relocates the storage root keeps that one cache file behind (harmless: nothing reads it once the session is gone).
- The persistence seam exposes **no delete method** (only create/open/stat/list/flush), so removal is a direct file operation plus the start-up journal; a backend with a different physical layout needs its own removal step.
- Loader errors for a failed plugin row are swallowed into the main-process log. The desktop app writes crash context to `%APPDATA%\@deepseek-ai\dsh-desktop\logs\`.

## Development

- `npm test` (or `node --test test/session-delete.test.mjs`) — 11 cases: path helpers, lineage split (agent children vs forks), preview counts, cascade delete against temporary harness homes, unexpected project keys, deferred journal + reap, fail-closed listing, invalid/missing ids, child-only delete, and the HTTP route (GET preview, POST delete, method and cross-site guards)
- `scripts/deploy.mjs [profile]` — deploy to a profile (byte-exact, no BOM, name/module-id consistency check)
- Host-half changes need a harness restart; browser-half changes need a page reload (`client-modules` versions bundles by file revision)
- Edit `lib/index.js` / `lib/client.js` only; the browser half is plain JavaScript (no JSX/TypeScript) and may `require` only modules already present in the web module table (`react` here)

## License

MIT

---

## 中文说明

**dsh-plugin-session-delete** 给 DeepSeek Harness 补上缺失的「真正删除会话」能力:侧栏会话菜单里的红色入口 + 二次确认,删除前先向 host 预检「会一起删掉几个 Agent 子会话」,删除时自动停止运行中的工作、连同 **Agent 开启的子会话**(`origin: "subagent"`,任意层级)一并删除,并彻底清除事件日志、workspace 计账、归档/置顶集合、投影缓存与 spill 文件,本地零残留。删除后侧栏通过事件流自动更新,不刷新页面。

**血缘规则**:带 `origin: "subagent"` 的子会话由 Agent 开启(子代理、workflow、Agent Teams),它们不出现在侧栏、只能从父会话的子会话目录进入 —— 所以删除父会话时一并删除,避免留下够不着的幽灵数据。**普通 fork 子会话**(独立分支,当前版本连父 id 都不记)会保留:它的 `parentSession` 只是历史元数据,DSH 的列表缩进与恢复准入都按 subagent origin 判断,悬空也不影响使用。

**安全门**:会话必须存在;血缘依赖 `sessionPersistence.list()`,列表读不出来就拒绝删除(失败即关闭,绝不当成「没有子会话」);运行中的工作先经 archive 的 `stopActivity` 停止(该瀑布同时取消运行中的子代理后代),再等待其收尾后才动文件。

**已知边界**:已上报的遥测无法撤回;其他会话里提到该会话的文字属于别的会话;普通 fork 的 header 仍可能记录已删父会话 id(独立会话,不影响使用);**目标为该会话的定时任务**属于 `schedule` 领域自己的持久存储(`involvedSessionIds`),不在本插件清理范围(团队 roster / 任务板 / 日志都在 Lead 会话日志里,随会话一起消失;队友会话是它的 Agent 子会话,一并删除);持久化 seam 没有删除方法,物理删除靠文件操作 + 下次启动的补删日志。

安装(推荐):`dsh plugin install dsh-plugin-session-delete`,重启 Harness 即可;也可以从设置 → 插件页面安装。手动安装:克隆仓库 → `node scripts/deploy.mjs desktop` → 在 `cordis.patch.yml` 中加入条目、在 profile `package.json` 中声明依赖 → 重启 Harness。详见上方英文步骤。

开发:改动 host 半部要重启 Harness;只改浏览器半部刷新页面即可。单测 `npm test` 覆盖 11 项(路径编码、血缘拆分、预检计数、级联删除、异位目录、补删日志、列表失败拒绝、非法 id、只删子树、HTTP 路由与跨站防护)。
