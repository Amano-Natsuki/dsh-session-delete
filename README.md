# dsh-plugin-session-delete

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that **permanently deletes a session** from the sidebar menu — with a confirmation step, no running work left behind, and **zero local residue**.

DSH ships with archive only; an archived session stays on disk forever. This plugin adds the missing operation: a real, irreversible delete that cleans every storage surface the session touched.

[中文说明](#中文说明)

---

## Features

- **Sidebar menu entry** — a red *Delete session…* row at the bottom of every session's context menu, with a two-step inline confirmation (the label turns into *Confirm permanent deletion?* and resets after 5 seconds).
- **Safety gates**
  - the session must exist (otherwise `not-found`)
  - a session that has **forked child sessions** is refused, with the child ids reported back
  - running work is stopped first through the archive `stopActivity` waterfall (the same gate that blocks re-wakes for archived sessions)
- **Zero local residue** — removes, in order:
  1. the **live store entry** (the store's own detach path, which also emits `session/disposed` so the sidebar drops the row immediately)
  2. **workspace accounting** (`sessionIds`)
  3. **archive / pin sets** (`archivedSessionIds`, `pinnedSessionIds`)
  4. the **event-log directory** `<persistence root>/<projectKey>/<encodedSessionId>/`
  5. the **projection cache** entry `<harness home>/storages/session_projcache/sessions/<id>.json`
  6. **spill files** `<tmp>/dsh-spill-*/session-<sha256(id)[:12]>/`
- **Browser-side state** — the delete also clears this page's persisted per-session keys (drafts, view state, panel layout written by the shipped UI plugins through the client store; their values never hold transcript content, but they name the session id)
- **Live-session handling** — a session that was opened once keeps a writer for the process lifetime. The plugin stops its activity, waits for the settling flush, then removes files in a short retry loop. If a file is still held, the id is journaled and reaped automatically on the next start (when every session is cold).
- **No page reload** — after deletion the sidebar updates through the `api-session/removed` event stream, exactly like workspace deletion.
- **Localized menu copy** — Chinese for `zh*` browser locales, English otherwise; colors follow the active theme through DSH theme tokens.

## Requirements

- DeepSeek Harness desktop `0.2.0-rc.2` or a compatible build with the same plugin surface:
  - host services `webServer`, `workspaceRegistry`, `sessionPersistence`, `sessions`
  - the browser slot `sidebar.workspaces.session.menu.item`
  - the JSONL session-persistence backend (the default `session-persistence-jsonl` root layout)
- The plugin declares **no peer dependencies**, so the compatibility preflight never disables it; if a future DSH version changes the storage layout, review the paths below before upgrading.

## Platform support

Windows, macOS, and Linux — the plugin holds no platform-specific assumptions:

- every path is composed with `node:path` (`join`), never a hard-coded separator
- the session-directory encoding mirrors DSH's own `projectKey` / `encodeSegment`, which fold `\`, `/`, and `:` the same way on every platform
- the session root comes from the mounted backend (`sessionPersistence.root`), so a relocated root is honored
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
| Host | `lib/index.js` | Registers the loopback route `POST /api/session-delete` and performs the whole deletion. Profile plugins have no `harness.handle`/`host.call` channel (that belongs to dynamic sandbox packages), so the browser half calls this route over same-origin `fetch`. |
| Browser | `lib/client.js` | Registers a `sidebar.workspaces.session.menu.item` entry, renders the two-step confirm button, calls the route, and closes the menu. Delivered by `dsh-client-modules` through `exports["./client"]` + the `dsh.client` declaration. |

**Security.** The route rejects cross-site requests (`Sec-Fetch-Site: cross-site`, or an `Origin` that is not a loopback host), and validates the session id against a strict character whitelist before touching any path.

**Path resolution.** The session root is read from the mounted persistence backend when it exposes one (`sessionPersistence.root`), falling back to `<harness home>/sessions`; the harness home follows the `$DSH_HOME` → `~/.dsh` precedence. Directory encoding (`projectKey` / `encodeSegment`) mirrors `@deepseek-ai/dsh-session-persistence-jsonl` so the exact session directory is resolved without importing the asar-packaged package.

## Known limits

- **Telemetry already sent** to the DeepSeek OTLP collector cannot be recalled; this plugin only clears local state.
- **Other sessions' content** that mentions the deleted session (message text, references) belongs to those sessions and is left untouched.
- **A forked child's header** may still name its deleted parent (`parentSession`) — that header is the child's own durable data. This is why deletion of a parent with children is refused instead.
- The **projection-cache path** assumes the default `storage-json` root (`<harness home>/storages`). A profile that relocates the storage root keeps that one cache file behind (harmless: nothing reads it once the session is gone).
- Loader errors for a failed plugin row are swallowed into the main-process log. The desktop app writes crash context to `%APPDATA%\@deepseek-ai\dsh-desktop\logs\`.

## Development

- `scripts/deploy.mjs [profile]` — deploy to a profile (byte-exact, no BOM, name/module-id consistency check)
- Host-half changes need a harness restart; browser-half changes need a page reload (`client-modules` versions bundles by file revision)
- Edit `lib/index.js` / `lib/client.js` only; the browser half is plain JavaScript (no JSX/TypeScript) and may `require` only modules already present in the web module table (`react` here)

## License

MIT

---

## 中文说明

**dsh-plugin-session-delete** 给 DeepSeek Harness 补上缺失的「真正删除会话」能力:侧栏会话菜单里的红色入口 + 二次确认,删除前自动停止运行中的工作、拒绝删除有 fork 子会话的会话,并彻底清除事件日志、workspace 计账、归档/置顶集合、投影缓存与 spill 文件,本地零残留。删除后侧栏通过事件流自动更新,不刷新页面。

安装(推荐):`dsh plugin install dsh-plugin-session-delete`,重启 Harness 即可;也可以从设置 → 插件页面安装。

手动安装:克隆仓库 → `node scripts/deploy.mjs desktop` → 在 `cordis.patch.yml` 中加入条目、在 profile `package.json` 中声明依赖 → 重启 Harness。详见上方英文步骤。

已知边界:已上报的遥测无法撤回;其他会话里提到该会话的文字属于别的会话;fork 子会话的 header 仍可能记录其父会话 id(因此有子会话时拒绝删除父会话)。
