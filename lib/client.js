/**
 * dsh-plugin-session-delete — browser half (delivered through exports["./client"]).
 *
 * Renders a "delete session" entry in the sidebar session menu
 * (`sidebar.workspaces.session.menu.item`) with a two-step inline
 * confirmation, then calls the host half's loopback HTTP route.
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

    /**
     * Drop every browser-side persisted key that names this session. The
     * shipped UI plugins (conversation, workspace, right sidebar, …) persist
     * per-session state through the client store, whose keys are
     * `<store-name>.session-<id>`; the values may also carry the id (e.g.
     * `dsh.sessions.current`). Nothing here holds transcript content, but the
     * ids are session records all the same, so a delete clears them.
     * Failures never affect the delete itself: the host already committed it.
     */
    const clearSessionStorage = (sessionId) => {
      try {
        const doomed = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key === null) continue;
          let value = "";
          try {
            value = localStorage.getItem(key) ?? "";
          } catch {
            /* unreadable value — fall back to the key test only */
          }
          if (key.includes(sessionId) || value.includes(sessionId)) doomed.push(key);
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
          confirm: "确认永久删除?此操作不可撤销",
          busy: "删除中…",
          deferred: "已删除;磁盘残留将在下次启动时彻底清除。",
          hasChildren: (n) => `此会话有 ${n} 个 fork 子会话,已取消删除。请先处理子会话。`,
          listFailed: "无法读取会话列表,已取消删除(请重试)。",
          partial: "部分文件未能删除,请重启应用后重试。",
          forbidden: "请求被拒绝(跨站防护)。",
          failed: (detail) => "删除失败:" + detail,
          network: (detail) => "请求失败:" + detail
        }
      : {
          idle: "Delete session\u2026",
          confirm: "Confirm permanent deletion? This cannot be undone",
          busy: "Deleting\u2026",
          deferred: "Deleted; remaining files are reaped on the next start.",
          hasChildren: (n) => `This session has ${n} forked child session(s); deletion cancelled. Handle them first.`,
          listFailed: "Could not read the session list; deletion cancelled. Please retry.",
          partial: "Some files could not be removed; restart the app and retry.",
          forbidden: "Request refused (cross-site protection).",
          failed: (detail) => "Delete failed: " + detail,
          network: (detail) => "Request failed: " + detail
        };

    function DeleteMenuItem({ sessionId, onDone }) {
      const [phase, setPhase] = useState("idle"); // idle | confirm | busy | error
      const [errorText, setErrorText] = useState("");
      const timerRef = useRef(null);

      useEffect(() => () => {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
      }, []);

      const armReset = () => {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          setPhase("idle");
          setErrorText("");
        }, CONFIRM_TIMEOUT_MS);
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
              ? AbortSignal.timeout(30000)
              : undefined
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok === true) {
            // The host committed the delete: clear this page's per-session
            // persisted state before anything else observes the id.
            clearSessionStorage(sessionId);
            if (data.deferred === true) {
              // Accounting, sets, and the in-memory store are already clean;
              // the files are held by the live writer and will be reaped on
              // the next start. Keep the menu open to show the notice.
              setPhase("error");
              setErrorText(COPY.deferred);
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
          setPhase("confirm");
          armReset();
        } else if (phase === "confirm" || phase === "error") {
          run();
        }
      };

      const label =
        phase === "idle" ? COPY.idle :
        phase === "confirm" ? COPY.confirm :
        phase === "busy" ? COPY.busy :
        errorText;

      const style = {
        border: "none",
        background: phase === "confirm" ? "var(--dsw-alias-state-error-primary, #c93a3a)" : "none",
        padding: "4px 12px",
        width: "100%",
        cursor: phase === "busy" ? "default" : "pointer",
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
        { type: "button", role: "menuitem", style, disabled: phase === "busy", onClick },
        label
      );
    }

    return {
      name: "session-delete-ui",
      inject: ["slots"],
      apply(ctx) {
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
                onDone: () => setMenuOpen(false)
              });
            }
          )
        );
      }
    };
  }
});
