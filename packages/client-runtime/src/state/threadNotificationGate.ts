// @effect-diagnostics globalTimers:off - The gate's completion grace runs in web and native clients, outside an Effect runtime.
import type { EnvironmentThreadShell } from "./models.ts";
import { WORKING_EXIT_GRACE_MS } from "./threadInbox.ts";
import { resolveThreadStatus, type ThreadStatus, type ThreadStatusInput } from "./threadStatus.ts";

export type ThreadNotificationKind = "input" | "completion";

export interface ThreadNotificationObservation {
  /** Run and status key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
}

export interface ThreadNotificationState extends ThreadNotificationObservation {
  readonly status: ThreadStatus;
}

/** Runs `run` after `delayMs` and returns its cancel. */
export type ThreadNotificationSchedule = (delayMs: number, run: () => void) => () => void;

const scheduleWithTimers: ThreadNotificationSchedule = (delayMs, run) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

/** A failed latest run reads as failed even once the runtime moved on to idle. */
export function observeThreadNotification(
  thread: Pick<EnvironmentThreadShell, "latestRun"> & ThreadStatusInput,
): ThreadNotificationState {
  let status = resolveThreadStatus(thread);
  if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
  const attention =
    status === "input" ||
    status === "request" ||
    status === "approval" ||
    status === "failed" ||
    status === "limited"
      ? `${thread.latestRun?.runId ?? ""}:${status}`
      : null;
  const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
  const settled = status === "ready" && thread.latestRun?.status === "completed";
  return {
    status,
    attention,
    settled,
    completedAt: settled && Number.isFinite(completedAt) ? completedAt : null,
  };
}

/**
 * Attention notifies at once. Completion waits out the Working shelf's exit grace,
 * because an orchestrator run can end moments before its continuation starts. Any
 * observation that is not settled during the wait cancels it.
 */
export function createThreadNotificationGate<Key>(
  notify: (key: Key, kind: ThreadNotificationKind) => void,
  schedule: ThreadNotificationSchedule = scheduleWithTimers,
) {
  const pending = new Map<Key, { at: number; cancel: () => void }>();
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  // The newest completion seen settled, kept while the thread works or waits.
  const lastSettled = new Map<Key, number>();
  const cancel = (key: Key) => {
    pending.get(key)?.cancel();
    pending.delete(key);
  };
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  return {
    observe(
      key: Key,
      prior: ThreadNotificationObservation | undefined,
      next: ThreadNotificationObservation,
      options: { readonly archived: boolean; readonly quiet: boolean },
    ): void {
      if (next.settled && next.completedAt !== null) lastSettled.set(key, next.completedAt);
      if (!next.settled || options.archived || options.quiet) cancel(key);
      // The first sighting, archived threads, and stopped or silent runs never notify completion.
      if (!prior || options.archived || options.quiet) skip(key, next.completedAt);
      if (!prior || options.archived) return;
      if (next.attention && next.attention !== prior.attention) {
        // Attention replaces the completion before it, so that run must not notify later.
        skip(key, lastSettled.get(key) ?? null);
        cancel(key);
        notify(key, "input");
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      if (pending.get(key)?.at === at) return;
      cancel(key);
      pending.set(key, {
        at,
        cancel: schedule(WORKING_EXIT_GRACE_MS, () => {
          pending.delete(key);
          handled.set(key, at);
          notify(key, "completion");
        }),
      });
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of pending.keys()) if (!keys.has(key)) cancel(key);
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
      for (const key of lastSettled.keys()) if (!keys.has(key)) lastSettled.delete(key);
    },
    clear(): void {
      for (const key of pending.keys()) cancel(key);
      handled.clear();
      lastSettled.clear();
    },
  };
}

export type ThreadNotificationGate<Key> = ReturnType<typeof createThreadNotificationGate<Key>>;
