import { useEffect, useRef, useState } from "react";
import { Icon, SURFACE, TimeAgo, usePresence, useSurfaceMotion } from "../ds";
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
  ok: "bg-ok",
  fail: "bg-fail",
  info: "bg-queue",
} as const;

function Row({ entry, onNavigate }: { entry: LoggedNotification; onNavigate: () => void }) {
  const body = (
    <>
      <span
        aria-hidden="true"
        className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[entry.tone]}`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span
            className={`min-w-0 flex-1 break-words text-small leading-snug ${
              entry.read ? "text-ink-dim" : "font-semibold text-ink"
            }`}
          >
            {entry.title}
          </span>
          <span className="shrink-0 text-caption">
            <TimeAgo iso={new Date(entry.at).toISOString()} />
          </span>
        </span>
        {entry.detail && (
          <span
            className={`mt-0.5 block break-words text-caption text-ink-faint ${
              entry.detailMono ? "font-mono" : ""
            }`}
          >
            {entry.detail}
          </span>
        )}
      </span>
    </>
  );

  const shell = "flex gap-2.5 rounded-md px-2.5 py-2 transition duration-(--duration-quick)";
  return entry.href ? (
    <a href={entry.href} onClick={onNavigate} className={`${shell} hover:bg-surface-3`}>
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
  const bellRef = useRef<HTMLButtonElement>(null);
  const { present, exited } = usePresence(open);
  // Hung off the bell in the top-right corner, so that is the corner it grows
  // from and shrinks back into.
  const panelRef = useSurfaceMotion<HTMLDivElement>(open, SURFACE.rise, exited, "top right");

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
      // An Escape something in front has already claimed (the palette, opened
      // over this) is not this panel's to act on as well.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Focus in the panel goes back to the bell: the panel turns inert as it
      // closes, and focus inside it fell to <body>. Focus out on the page
      // stays where it is.
      if (containerRef.current?.contains(document.activeElement)) bellRef.current?.focus();
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    // Tabbing out of the open panel closes it: left open, it covered the page
    // control focus moved on to. Focus stays where it went; only a move with
    // somewhere to go counts, so a click on the panel's own text does not.
    <div
      ref={containerRef}
      className="relative"
      onBlur={(e) => {
        const to = e.relatedTarget;
        if (open && to instanceof Node && !e.currentTarget.contains(to)) setOpen(false);
      }}
    >
      <button
        ref={bellRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications (none unread)"}
        // On a phone the hit area reaches 44px tall (and meets the search
        // button's) without the bar growing; the bell still draws at 32px.
        className={`relative flex h-8 w-8 items-center justify-center rounded-control transition duration-(--duration-quick) hover:bg-surface-2 hover:text-ink motion-safe:active:scale-[0.95] max-md:before:absolute max-md:before:-inset-x-[3px] max-md:before:-inset-y-1.5 ${
          open ? "bg-surface-2 text-ink" : "text-ink-dim"
        }`}
      >
        <Icon name="bell" size={18} />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-eye px-1 text-micro font-semibold leading-none text-ground ring-2 ring-ground"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {present && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          inert={!open}
          aria-hidden={open ? undefined : true}
          // On a phone the bell sits well in from the right edge, so a panel
          // hung off it ran off the *left* of the screen. Below `sm` it spans
          // the viewport between the bar's gutters instead (the bar's backdrop
          // filter makes it the containing block, and it is full width), still
          // growing from the top right where the bell is.
          className="absolute right-0 top-full z-40 mt-2 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col rounded-tile bg-surface-2 shadow-overlay max-sm:fixed max-sm:inset-x-4 max-sm:top-[60px] max-sm:mt-0 max-sm:w-auto max-sm:max-w-none"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 className="text-small font-semibold text-ink">Notifications</h2>
            {log.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  clearNotifications();
                  // The button goes with the entries it cleared, so focus goes
                  // to the bell rather than falling to <body>.
                  bellRef.current?.focus();
                }}
                // Tall enough to press (24px) without the header growing by
                // the difference.
                className="-my-0.5 rounded-md px-1.5 py-1 text-caption font-semibold text-ink-faint transition duration-(--duration-quick) hover:bg-surface-3 hover:text-ink"
              >
                Clear
              </button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-1.5">
            {log.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <Icon name="bell" size={20} className="text-ink-faint" />
                <p className="max-w-[16rem] text-small leading-snug text-ink-dim">
                  Nothing yet. Failures, monitor transitions and budget alerts appear here as they
                  happen.
                </p>
              </div>
            ) : (
              <div className="flex flex-col">
                {log.map((entry) => (
                  <Row key={entry.id} entry={entry} onNavigate={() => setOpen(false)} />
                ))}
              </div>
            )}
          </div>
          <p className="border-t border-line px-4 py-2.5 text-caption leading-snug text-ink-faint">
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
