import { useEffect, useRef, useState } from "react";
import { TimeAgo } from "../ds";
import {
  clearNotifications,
  markAllRead,
  unreadCount,
  useNotificationLog,
  type LoggedNotification,
} from "./notificationLog";

/**
 * The bell: everything that has raised a toast this session, with an unread
 * count.
 *
 * A toast lives for eight seconds. If a monitor went down while you were in
 * another tab — which, for an unattended-agent dashboard, is most of the time —
 * that notification is simply gone. The Briefing answers "what is wrong *now*";
 * this answers "what happened, in order, while I had this open", including the
 * transitions that have since resolved themselves.
 */

const TONE_DOT = {
  ok: "text-ok",
  fail: "text-fail",
  info: "text-queue",
} as const;

function Row({ entry, onNavigate }: { entry: LoggedNotification; onNavigate: () => void }) {
  const body = (
    <>
      <span aria-hidden="true" className={`mt-1 shrink-0 text-[9px] ${TONE_DOT[entry.tone]}`}>
        ●
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span
            className={`min-w-0 flex-1 break-words text-[12.5px] leading-tight ${
              entry.read ? "text-ink-dim" : "font-semibold text-ink"
            }`}
          >
            {entry.title}
          </span>
          <span className="shrink-0 font-mono text-[10px]">
            <TimeAgo iso={new Date(entry.at).toISOString()} />
          </span>
        </span>
        {entry.detail && (
          <span className="mt-0.5 block break-words font-mono text-[10.5px] text-ink-faint">
            {entry.detail}
          </span>
        )}
      </span>
    </>
  );

  const shell = "flex gap-2.5 rounded-md px-2 py-2 transition duration-(--duration-quick)";
  return entry.href ? (
    <a href={entry.href} onClick={onNavigate} className={`${shell} hover:bg-surface-2`}>
      {body}
    </a>
  ) : (
    <span className={shell}>{body}</span>
  );
}

export function NotificationCenter() {
  const log = useNotificationLog();
  const [open, setOpen] = useState(false);
  const unread = unreadCount(log);
  const containerRef = useRef<HTMLDivElement>(null);

  // Opening is the acknowledgement — no separate "mark read" ritual.
  useEffect(() => {
    if (open) markAllRead();
  }, [open, log.length]);

  // Dismiss on an outside click or Escape, like every other popover.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications (none unread)"}
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-ink-dim transition duration-(--duration-quick) hover:text-ink"
      >
        <span aria-hidden="true" className="text-[15px] leading-none">
          ◔
        </span>
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-fail px-1 font-mono text-[9px] font-bold leading-none text-ground"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-40 mt-1.5 flex w-[340px] max-w-[calc(100vw-2rem)] flex-col rounded-panel border border-line bg-surface shadow-[0_24px_60px_-24px_rgb(0_0_0/0.9)] motion-safe:animate-[rise-in_var(--duration-base)_var(--ease-out-expo)]"
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
              Notifications
            </h2>
            {log.length > 0 && (
              <button
                type="button"
                onClick={clearNotifications}
                className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint transition duration-(--duration-quick) hover:text-ink"
              >
                Clear
              </button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-1.5">
            {log.length === 0 ? (
              <p className="px-2 py-6 text-center text-[12px] leading-snug text-ink-faint">
                Nothing yet. Failures, monitor transitions and budget alerts appear here as they
                happen.
              </p>
            ) : (
              <div className="flex flex-col">
                {log.map((entry) => (
                  <Row key={entry.id} entry={entry} onNavigate={() => setOpen(false)} />
                ))}
              </div>
            )}
          </div>
          <p className="border-t border-line px-3 py-2 text-[10.5px] leading-snug text-ink-faint">
            This session only. For what changed while Argus ran without you, see{" "}
            <a
              href="#/briefing"
              onClick={() => setOpen(false)}
              className="text-ink-dim underline decoration-line underline-offset-2"
            >
              Briefing
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
}
