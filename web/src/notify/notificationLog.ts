import { useSyncExternalStore } from "react";

/**
 * A session-scoped log of everything that raised a toast.
 *
 * Toasts are the right way to *interrupt* — and the wrong way to *record*. A
 * monitor that went down while you were reading another tab announced itself for
 * six seconds and then vanished; the Briefing tells you the state *now*, but not
 * that a schedule recovered twenty minutes ago after failing twice. So every
 * toast is also appended here, and the nav keeps an unread count.
 *
 * Deliberately in memory, per tab. Persisting it would duplicate the Briefing's
 * job (durable "what happened while you were away") and risk showing a
 * transition log that disagrees with the server's own view after a restart. This
 * is "what happened while this tab was open", and the UI says so.
 */

export type NotificationTone = "ok" | "fail" | "info";

export interface LoggedNotification {
  id: string;
  tone: NotificationTone;
  title: string;
  detail?: string;
  /** Epoch ms of arrival. */
  at: number;
  /** Hash route this notification is about, if any. */
  href?: string;
  read: boolean;
}

/** Enough to cover a long session without unbounded growth. */
export const LOG_CAP = 50;

let entries: LoggedNotification[] = [];
let counter = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Newest first. A stable array identity between mutations keeps
 *  `useSyncExternalStore` from re-rendering in a loop. */
function getSnapshot(): LoggedNotification[] {
  return entries;
}

export interface NotificationInput {
  tone: NotificationTone;
  title: string;
  detail?: string;
  href?: string;
  /** Arrival time; injectable for tests. */
  at?: number;
}

export function logNotification(input: NotificationInput): void {
  const entry: LoggedNotification = {
    id: `n${++counter}`,
    tone: input.tone,
    title: input.title,
    detail: input.detail,
    href: input.href,
    at: input.at ?? Date.now(),
    read: false,
  };
  entries = [entry, ...entries].slice(0, LOG_CAP);
  emit();
}

export function markAllRead(): void {
  if (!entries.some((e) => !e.read)) return;
  entries = entries.map((e) => (e.read ? e : { ...e, read: true }));
  emit();
}

export function clearNotifications(): void {
  if (entries.length === 0) return;
  entries = [];
  emit();
}

/** The log, newest first, re-rendering the caller as it changes. */
export function useNotificationLog(): LoggedNotification[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function unreadCount(list: LoggedNotification[]): number {
  return list.reduce((n, e) => n + (e.read ? 0 : 1), 0);
}

/** Test seam: drops every entry and resets ids. */
export function resetNotificationLogForTest(): void {
  entries = [];
  counter = 0;
  emit();
}
