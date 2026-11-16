/**
 * dsh-plugin-session-delete — browser half (delivered through exports["./client"]).
 *
 * Renders a "delete session" entry in the sidebar session menu
 * (`sidebar.workspaces.session.menu.item`) with a two-step inline
 * confirmation, then calls the host half's loopback HTTP route.
 *
 * The first click asks the host what the delete would take with it
 * (`GET /api/session-delete?sessionId=…`): agent-spawned child sessions are
 * deleted together with the session, so the confirmation names them instead of
 * surprising the user afterwards. The second click performs the delete.
 *
 * Plain JavaScript, no JSX: build elements with React.createElement. Copy
 * follows the browser language (zh* → Chinese, otherwise English); colors use
 * theme tokens with plain fallbacks so the row matches the active theme.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-session-delete",
  factory: (require) => {
    const React = require("react");
    const { useEffect, useRef, useState } = React;

    const CONFIRM_TIMEOUT_MS = 5000;
    const PREVIEW_TIMEOUT_MS = 10000;
    const DELETE_TIMEOUT_MS = 30000;

    /** The page's "current session" key; only cleared when its value is this id. */
    const CURRENT_SESSION_KEY = "dsh.sessions.current";

    /**
     * Drop browser-side persisted state that belongs to exactly this session.
     *
     * Per-session keys are `<store>.session-<id>` for top-level sessions and
     * `<store>.<id>` for agent-spawned children (their ids are bare uuids).
     * Global keys that merely *mention* a session id are deliberately kept: the
     * workspace view state (`dsh.workspace.view.v5`) carries grouping, order,
     * pin and archive-filter preferences, so removing it because one id appears
     * inside would reset preferences for every session. The list refresh drops
     * an unknown id by itself.
     * @param sessionId - The session whose keys are cleared.
     */
    const clearSessionStorage = (sessionId) => {
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      try {
        const doomed = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key === null) continue;
          if (key.endsWith(`session-${sessionId}`) || key.endsWith(`.${sessionId}`)) {
            doomed.push(key);
            continue;
          }
          if (key !== CURRENT_SESSION_KEY) continue;
          let value = "";
          try {
            value = localStorage.getItem(key) ?? "";
          } catch {
            /* unreadable value: leave the key alone */
          }
          if (value === sessionId) {
            doomed.push(key);
            continue;
          }
          try {
            if (JSON.parse(value) === sessionId) doomed.push(key);
          } catch {
            /* not JSON: the raw comparison above was the test */
          }
        }
        for (const key of doomed) {
          try {
            localStorage.removeItem(key);
          } catch {
            /* keep clearing the rest */
          }
        }
      } catch {
        /* storage unavailable: the delete already succeeded on the host */
      }
    };

    /** Menu copy per language, resolved once from the browser locale. */
    const COPY = (navigator.language ?? "").toLowerCase().startsWith("zh")
      ? {
          idle: "删除会话…",
          checking: "检查子会话…",
          confirmPlain: "确认永久删除?此操作不可撤销",
          confirmCascade: (n, running) => `确认永久删除?将同时删除 ${n} 个 Agent 子会话`
            + (running > 0 ? `(其中 ${running} 个正在运行)` : "")
            + ";此操作不可撤销",
          forksKept: (n) => `另有 ${n} 个普通 fork 子会话会保留。`,
          busy: "删除中…",
          deferred: (n) => (n > 0
            ? `已删除;${n} 个会话的磁盘残留将在下次启动时彻底清除。`
            : "已删除;磁盘残留将在下次启动时彻底清除。"),
          hasChildren: (n) => `此会话仍有 ${n} 个子会话无法一并处理,已取消删除。`,
          listFailed: "无法读取会话列表,已取消删除(请重试)。",
          partial: "部分文件未能删除,请重启应用后重试。",
          forbidden: "请求被拒绝(跨站防护)。",
          failed: (detail) => "删除失败:" + detail,
          network: (detail) => "请求失败:" + detail
        }
      : {
          idle: "Delete session\u2026",
          checking: "Checking child sessions\u2026",
          confirmPlain: "Confirm permanent deletion? This cannot be undone",
          confirmCascade: (n, running) => `Confirm permanent deletion? ${n} agent child session(s)`
            + (running > 0 ? ` (${running} running)` : "")
            + " will be deleted too; this cannot be undone",
          forksKept: (n) => `${n} ordinary fork child session(s) will be kept.`,
          busy: "Deleting\u2026",
          deferred: (n) => (n > 0
            ? `Deleted; files of ${n} session(s) are reaped on the next start.`
            : "Deleted; remaining files are reaped on the next start."),
          hasChildren: (n) => `This session still has ${n} child session(s) that could not be handled; deletion cancelled.`,
          listFailed: "Could not read the session list; deletion cancelled. Please retry.",
          partial: "Some files could not be removed; restart the app and retry.",
          forbidden: "Request refused (cross-site protection).",
          failed: (detail) => "Delete failed: " + detail,
          network: (detail) => "Request failed: " + detail
        };

    /**
     * Pull the session list again after a committed delete. A session that was
     * never opened is not in the host's live store, so its removal emits no
     * `session/disposed` and therefore no forwarded `api-session/removed`
     * frame — the sidebar would keep showing a row whose history no longer
     * loads ("session/not-found"). Refreshing re-reads the authoritative list
     * for both cold and live sessions. Failures are cosmetic: the next list
     * pull (or a page load) converges anyway.
     */
    const refreshSessionList = (sessions) => {
      try {
        sessions?.refresh?.();
      } catch {
        /* the sidebar keeps its stale row until the next pull */
      }
    };

    /** Empty preview: what the confirmation says when the host could not answer. */
    const EMPTY_PLAN = { subagentChildren: 0, runningChildren: 0, forkChildren: 0 };

    function DeleteMenuItem({ sessionId, sessions, onDone }) {
      const [phase, setPhase] = useState("idle"); // idle | checking | confirm | busy | error
      const [plan, setPlan] = useState(EMPTY_PLAN);
      const [errorText, setErrorText] = useState("");
      const timerRef = useRef(null);

      useEffect(() => () => {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
      }, []);

      const armReset = () => {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          setPhase("idle");
          setPlan(EMPTY_PLAN);
          setErrorText("");
        }, CONFIRM_TIMEOUT_MS);
      };

      /** Ask the host what the delete would take with it. */
      const preview = async () => {
        const url = window.location.origin + "/api/session-delete?sessionId=" + encodeURIComponent(sessionId);
        try {
          const res = await fetch(url, {
            method: "GET",
            credentials: "omit",
            signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
              ? AbortSignal.timeout(PREVIEW_TIMEOUT_MS)
              : undefined
          });
          const data = await res.json().catch(() => ({}));
          if (data.ok !== true) {
            // Older host, route unavailable, or a refusal: fall through to the
            // plain confirmation; the POST below is the authoritative check.
            return { plan: EMPTY_PLAN, gone: false, invalid: data?.reason === "invalid-id" };
          }
          if (data.exists !== true) return { plan: EMPTY_PLAN, gone: true, invalid: false };
          return {
            plan: {
              subagentChildren: Number(data.subagentChildren) || 0,
              runningChildren: Number(data.runningChildren) || 0,
              forkChildren: Number(data.forkChildren) || 0
            },
            gone: false,
            invalid: false
          };
        } catch {
          // Host unreachable: the POST below re-checks server side; confirm
          // without naming counts rather than blocking the delete.
          return { plan: EMPTY_PLAN, gone: false, invalid: false };
        }
      };

      const run = async () => {
        setPhase("busy");
        try {
          const res = await fetch(window.location.origin + "/api/session-delete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId }),
            credentials: "omit",
            // Never leave the row stuck on "deleting…" if the host stalls.
            signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
              ? AbortSignal.timeout(DELETE_TIMEOUT_MS)
              : undefined
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok === true) {
            // The host committed the delete: clear this page's per-session
            // state (the session and every agent child it took with it) and
            // re-pull the list before anything else observes the ids.
            const deleted = Array.isArray(data.deleted) && data.deleted.length > 0 ? data.deleted : [sessionId];
            for (const id of deleted) clearSessionStorage(id);
            refreshSessionList(sessions);
            if (data.deferred === true) {
              // Accounting, sets, and the in-memory store are already clean;
              // the files are held by the live writer and will be reaped on
              // the next start. Keep the menu open to show the notice.
              setPhase("error");
              setErrorText(COPY.deferred(Array.isArray(data.remaining) ? data.remaining.length : 0));
              armReset();
              return;
            }
            // The host evicted the session and emitted api-session/removed:
            // the sidebar updates through the event stream. No page reload.
            onDone();
            return;
          }
          if (data?.reason === "has-children") {
            const count = Array.isArray(data.children) ? data.children.length : 0;
            setErrorText(COPY.hasChildren(count));
          } else if (data?.reason === "not-found") {
            // The session is gone already; its persisted page state is stale.
            clearSessionStorage(sessionId);
            refreshSessionList(sessions);
            onDone();
            return;
          } else if (data?.reason === "list-failed") {
            setErrorText(COPY.listFailed);
          } else if (data?.reason === "partial") {
            setErrorText(COPY.partial);
          } else if (data?.reason === "forbidden") {
            setErrorText(COPY.forbidden);
          } else {
            setErrorText(COPY.failed(data?.message || data?.reason || String(res.status)));
          }
          setPhase("error");
          armReset();
        } catch (error) {
          setErrorText(COPY.network(String(error?.message ?? error)));
          setPhase("error");
          armReset();
        }
      };

      const onClick = () => {
        if (phase === "idle") {
          armReset();
          setPhase("checking");
          void preview().then((result) => {
            if (result.gone) {
              clearSessionStorage(sessionId);
              refreshSessionList(sessions);
              onDone();
              return;
            }
            if (result.invalid) {
              setErrorText(COPY.failed("invalid-id"));
              setPhase("error");
              armReset();
              return;
            }
            setPlan(result.plan);
            setPhase("confirm");
          });
          return;
        }
        if (phase === "confirm" || phase === "error") void run();
      };

      const confirmLabel = () => {
        const parts = [];
        if (plan.subagentChildren > 0) {
          parts.push(COPY.confirmCascade(plan.subagentChildren, plan.runningChildren));
        } else {
          parts.push(COPY.confirmPlain);
        }
        if (plan.forkChildren > 0) parts.push(COPY.forksKept(plan.forkChildren));
        return parts.join(" ");
      };

      const label =
        phase === "idle" ? COPY.idle :
        phase === "checking" ? COPY.checking :
        phase === "confirm" ? confirmLabel() :
        phase === "busy" ? COPY.busy :
        errorText;

      const style = {
        border: "none",
        background: phase === "confirm" ? "var(--dsw-alias-state-error-primary, #c93a3a)" : "none",
        padding: "4px 12px",
        width: "100%",
        cursor: phase === "busy" || phase === "checking" ? "default" : "pointer",
        color: phase === "confirm" ? "#ffffff"
          : phase === "error" ? "var(--dsw-alias-label-secondary, #ffb4b4)"
          : "var(--dsw-alias-state-error-primary, #e5484d)",
        borderRadius: "4px",
        fontSize: "13px",
        lineHeight: "1.5",
        textAlign: "left",
        whiteSpace: "normal",
        boxSizing: "border-box"
      };

      return React.createElement(
        "button",
        { type: "button", role: "menuitem", style, disabled: phase === "busy" || phase === "checking", onClick },
        label
      );
    }

    return {
      name: "session-delete-ui",
      inject: ["slots"],
      apply(ctx) {
        // The session list service (lazily resolved: a missing provider must
        // not park the whole plugin, and the delete itself works regardless).
        const sessions = ctx.get("sessions");
        ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
          ctx.slots.register(
            {
              name: "sidebar.workspaces.session.menu.item",
              id: "session-delete",
              order: 950,
              label: "Delete Session"
            },
            ({ sessionId, useMenuOpenState }) => {
              const [, setMenuOpen] = useMenuOpenState();
              return React.createElement(DeleteMenuItem, {
                sessionId,
                sessions,
                onDone: () => setMenuOpen(false)
              });
            }
          )
        );
      }
    };
  }
});
