import {
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ScopedThreadRef,
  type VoiceAgentSpeakMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { scopedProjectKey, scopedThreadKey } from "../environment/scoped.ts";
import {
  threadRuntimeIsActive,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "../state/models.ts";
import { observeThreadNotification } from "../state/threadNotificationGate.ts";
import type { ThreadPendingApproval, ThreadPendingUserInput } from "../state/threadRequests.ts";
import { effectiveSnoozed } from "../state/threadSettled.ts";
import type { ThreadStatus } from "../state/threadStatus.ts";
import { commandDisplayText } from "../work-log/commandLabel.ts";
import type {
  VoiceChildRequests,
  VoiceEvent,
  VoiceEventKind,
  VoiceFeedEntry,
  VoiceThreadRow,
  VoiceThreadsInput,
} from "./types.ts";

/** How many threads the snapshot lists. */
const SNAPSHOT_LIMIT = 40;
/** How many steps the rolling activity of a running thread carries. */
const ACTIVITY_STEPS = 8;

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Text that agents or people wrote, as one clipped JSON string, so it can't close its quote or start a line. */
export function quoted(text: string, max: number): string {
  return JSON.stringify(clip(text, max));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

function epochMs(iso: string | null | undefined): number | null {
  if (iso == null) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

const AUDIO_TAG = /\[[^\]\n]{1,40}\]/g;
const JUNK = /^[\s.…·,!?-]*$/;

/** A line fit to show, or null when there is nothing to show. Eleven v4's audio tags ("[laughing]") steer the voice and are not words. */
export function captionText(role: "user" | "agent", raw: string): string | null {
  const text = (role === "agent" ? raw.replace(AUDIO_TAG, "") : raw).replace(/\s{2,}/g, " ").trim();
  return JUNK.test(text) ? null : text;
}

/** Short per-call names for threads ("t1", "t2"), stable for the whole call. */
export class VoiceHandles {
  private readonly byKey = new Map<string, string>();
  private readonly byHandle = new Map<string, string>();

  of(key: string): string {
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const handle = `t${this.byKey.size + 1}`;
    this.byKey.set(key, handle);
    this.byHandle.set(handle, key);
    return handle;
  }

  keyOf(handle: string): string | null {
    return this.byHandle.get(handle.trim().toLowerCase()) ?? null;
  }
}

const PROVIDER_NAMES: ReadonlyMap<string, string> = new Map(
  Object.entries(PROVIDER_DISPLAY_NAMES).flatMap(([driver, name]) =>
    name === undefined ? [] : [[driver, name] as const],
  ),
);

export function defaultProviderLabel(thread: Pick<EnvironmentThreadShell, "providerInstanceId">) {
  return PROVIDER_NAMES.get(thread.providerInstanceId) ?? thread.providerInstanceId;
}

export interface VoiceRowOptions {
  readonly providerLabel?: ((thread: EnvironmentThreadShell) => string) | undefined;
  readonly environmentLabel?: ((environmentId: EnvironmentId) => string | null) | undefined;
}

/** Project names by scoped project key; a title shared across environments names its environment. */
export function voiceProjectLabels(
  projects: ReadonlyArray<EnvironmentProject>,
  environmentLabel?: VoiceRowOptions["environmentLabel"],
): ReadonlyMap<string, string> {
  const titleCounts = new Map<string, number>();
  for (const project of projects) {
    const title = project.title.trim().toLowerCase();
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  return new Map(
    projects.map((project) => {
      const title = clip(project.title, 60) || "Untitled project";
      const where =
        (titleCounts.get(project.title.trim().toLowerCase()) ?? 0) > 1
          ? environmentLabel?.(project.environmentId)
          : null;
      return [
        scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }),
        where ? `${title} (${clip(where, 40)})` : title,
      ];
    }),
  );
}

function statusSince(status: ThreadStatus, thread: EnvironmentThreadShell): number | null {
  const run = thread.latestRun;
  switch (status) {
    case "approval":
    case "input": {
      const pending = thread.source.pendingRuntimeRequest;
      return pending === null ? null : DateTime.toEpochMillis(pending.createdAt);
    }
    case "working":
    case "waiting":
      return (
        epochMs(thread.runtime?.activityStartedAt) ??
        epochMs(run?.startedAt) ??
        epochMs(run?.requestedAt)
      );
    case "request":
      return null;
    case "failed":
    case "limited":
    case "ready":
      return epochMs(run?.completedAt);
  }
}

function voiceThreadRow(
  thread: EnvironmentThreadShell,
  key: string,
  project: string,
  options: VoiceRowOptions,
): VoiceThreadRow {
  const observation = observeThreadNotification(thread);
  const run = thread.latestRun;
  return {
    ...observation,
    key,
    ref: { environmentId: thread.environmentId, threadId: thread.id },
    shell: thread,
    project,
    title: clip(thread.title, 80) || "Untitled thread",
    provider: clip(options.providerLabel?.(thread) ?? defaultProviderLabel(thread), 40),
    since: statusSince(observation.status, thread),
    error: thread.runtime?.lastError ?? null,
    pendingRequest: thread.source.pendingRuntimeRequest?.kind ?? null,
    running: threadRuntimeIsActive(thread.runtime),
    quiet: thread.source.latestRunStopRequested === true,
    recency:
      epochMs(run?.completedAt) ??
      epochMs(run?.startedAt) ??
      epochMs(run?.requestedAt) ??
      epochMs(thread.createdAt) ??
      0,
  };
}

/** Rows by scoped thread key. Rows of unchanged shells are reused, so callers can compare them by identity. */
export function buildVoiceThreadRows(
  input: VoiceThreadsInput,
  options: VoiceRowOptions = {},
  previous?: ReadonlyMap<string, VoiceThreadRow>,
): ReadonlyMap<string, VoiceThreadRow> {
  const projects = voiceProjectLabels(input.projects, options.environmentLabel);
  const rows = new Map<string, VoiceThreadRow>();
  for (const thread of input.threads) {
    const key = scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
    const project =
      projects.get(
        scopedProjectKey({ environmentId: thread.environmentId, projectId: thread.projectId }),
      ) ?? "an unknown project";
    const prior = previous?.get(key);
    rows.set(
      key,
      prior?.shell === thread && prior.project === project
        ? prior
        : voiceThreadRow(thread, key, project, options),
    );
  }
  return rows;
}

const STATUS_RANK: Record<ThreadStatus, number> = {
  approval: 0,
  input: 0,
  request: 0,
  failed: 0,
  limited: 0,
  working: 1,
  waiting: 1,
  ready: 2,
};

/** A failure the user settled or snoozed is old news: it ranks by recency like a finished thread. */
function voiceRank(row: VoiceThreadRow, nowIso: string): number {
  if (
    (row.status === "failed" || row.status === "limited") &&
    (row.shell.settledOverride === "settled" || effectiveSnoozed(row.shell, { now: nowIso }))
  ) {
    return STATUS_RANK.ready;
  }
  return STATUS_RANK[row.status];
}

/** Blocked threads first, then working ones, then the most recent. */
function rankVoiceThreads(rows: Iterable<VoiceThreadRow>, now: number): VoiceThreadRow[] {
  const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
  return [...rows].sort(
    (left, right) =>
      voiceRank(left, nowIso) - voiceRank(right, nowIso) || right.recency - left.recency,
  );
}

/** The approval comes only from a hidden subagent child, which flags its parent. */
function subagentApproval(row: VoiceThreadRow): boolean {
  return !row.shell.hasPendingApprovals && row.shell.pendingSubagentRequest === "approval";
}

export interface VoiceRequestTarget {
  readonly ref: ScopedThreadRef;
  /** The subagent's title when the request waits on a hidden subagent child. */
  readonly subagent: string | null;
}

/** Where a thread's pending request lives: on the thread itself, or on the subagent child asking for approval. */
export function voiceRequestTarget(
  row: VoiceThreadRow,
  childRequests: VoiceChildRequests,
): VoiceRequestTarget {
  if (!subagentApproval(row)) return { ref: row.ref, subagent: null };
  const child = childRequests(row.ref).find((candidate) => candidate.hasPendingApprovals);
  return child === undefined
    ? { ref: row.ref, subagent: null }
    : {
        ref: { environmentId: child.environmentId, threadId: child.id },
        subagent: clip(child.title, 80) || "Untitled subagent",
      };
}

const REQUEST_WORDS: Partial<Record<OrchestrationV2RuntimeRequest["kind"], string>> = {
  command: "to run a command",
  "file-read": "to read files",
  "file-change": "to change files",
  "mcp-elicitation": "to give a tool some input",
  permission: "for a permission",
  dynamic_tool_call: "to run a tool",
};

function voiceStatusText(row: VoiceThreadRow, now: number): string {
  const since = row.since === null ? null : Math.max(0, now - row.since);
  switch (row.status) {
    case "approval": {
      if (subagentApproval(row)) return "has a subagent that needs approval";
      const what = row.pendingRequest === null ? undefined : REQUEST_WORDS[row.pendingRequest];
      return what === undefined ? "needs approval" : `needs approval ${what}`;
    }
    case "input":
      return "has a question for the user";
    case "request":
      return "has a guest message waiting for review";
    case "working":
      return since === null ? "working" : `working for ${duration(since)}`;
    case "waiting":
      return "waiting on other work";
    case "failed":
      return row.error ? `failed: ${quoted(row.error, 160)}` : "failed";
    case "limited": {
      const reset = epochMs(row.shell.runtime?.usageLimitResetAt);
      return reset !== null && reset > now
        ? `stopped at a usage limit, resets in ${duration(reset - now)}`
        : "stopped at a usage limit";
    }
    case "ready": {
      const run = row.shell.latestRun;
      if (run === null) return "idle, no turns yet";
      const when = since === null ? "" : ` ${duration(since)} ago`;
      return run.status === "completed" ? `finished${when}` : `stopped${when}`;
    }
  }
}

function voiceRowLine(
  row: VoiceThreadRow,
  handle: string,
  lastMessage: string | undefined,
  now: number,
): string {
  const message =
    row.status === "ready" && lastMessage ? ` Last message: ${quoted(lastMessage, 160)}` : "";
  return `${handle} ${quoted(row.title, 80)} (${row.provider}): ${voiceStatusText(row, now)}.${message}`;
}

export interface VoiceSnapshotOptions {
  readonly handles: VoiceHandles;
  readonly openKey: string | null;
  readonly projects: ReadonlyArray<string>;
  readonly lastMessages: ReadonlyMap<string, string>;
  readonly now: number;
  readonly limit?: number;
}

/**
 * The "[t3 snapshot]": the most pressing threads grouped by project. Threads without a handle
 * get one in rank order, so the first snapshot of a call numbers the urgent ones first.
 */
export function buildVoiceSnapshot(
  rows: ReadonlyMap<string, VoiceThreadRow>,
  options: VoiceSnapshotOptions,
): string {
  const ranked = rankVoiceThreads(rows.values(), options.now);
  const shown = ranked.slice(0, options.limit ?? SNAPSHOT_LIMIT);
  const groups = new Map<string, string[]>();
  for (const row of shown) {
    const line = `- ${voiceRowLine(row, options.handles.of(row.key), options.lastMessages.get(row.key), options.now)}`;
    const group = groups.get(row.project);
    if (group === undefined) groups.set(row.project, [line]);
    else group.push(line);
  }
  const open = options.openKey === null ? undefined : rows.get(options.openKey);
  const projectCount = new Set(ranked.map((row) => row.project)).size;
  const lines = [
    `[t3 snapshot] ${plural(ranked.length, "thread")} in ${plural(projectCount, "project")}. ${
      open === undefined
        ? "No thread is open in the app."
        : `Open in the app: ${options.handles.of(open.key)} ${quoted(open.title, 80)}.`
    }`,
    ...[...groups].map(([project, group]) => `${quoted(project, 80)}:\n${group.join("\n")}`),
  ];
  const left = ranked.length - shown.length;
  if (left > 0) {
    lines.push(
      `${plural(left, "more thread")} left out. To reach one, pass its title as the thread.`,
    );
  }
  lines.push(
    options.projects.length === 0
      ? "No projects yet."
      : `Projects: ${projectList(options.projects)}.`,
  );
  return lines.join("\n");
}

function projectList(projects: ReadonlyArray<string>): string {
  return projects.map((project) => quoted(project, 80)).join(", ");
}

export function voiceDynamicVariables(
  rows: ReadonlyMap<string, VoiceThreadRow>,
  options: Pick<VoiceSnapshotOptions, "handles" | "openKey" | "projects">,
): Record<string, string> {
  const open = options.openKey === null ? undefined : rows.get(options.openKey);
  return {
    open_thread:
      open === undefined
        ? "none"
        : `${options.handles.of(open.key)} ${quoted(open.title, 80)} in ${quoted(open.project, 80)}`,
    project_names: options.projects.length === 0 ? "none yet" : projectList(options.projects),
    thread_count: String(rows.size),
  };
}

const STEP_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
  "error",
]);

function basename(path: string): string {
  return path.split(/[\\/]/).findLast((part) => part !== "") ?? path;
}

function isActiveItem(item: OrchestrationV2TurnItem): boolean {
  return item.status === "running" || item.status === "pending";
}

function isFailedStep(item: OrchestrationV2TurnItem): boolean {
  if (item.type === "error" || item.status === "failed") return true;
  return (
    item.type === "command_execution" &&
    !isActiveItem(item) &&
    ((item.exitCode !== undefined && item.exitCode !== 0) || item.outputIndicatesFailure === true)
  );
}

/** One step of an agent's work in a few plain words, or null for items that are not steps. */
export function voiceStepLine(item: OrchestrationV2TurnItem): string | null {
  const failed = isFailedStep(item) ? ", failed" : "";
  const active = isActiveItem(item);
  switch (item.type) {
    case "command_execution": {
      const command = quoted(commandDisplayText(item.input), 80);
      if (active) return `Running ${command}`;
      const exit =
        item.exitCode !== undefined && item.exitCode !== 0
          ? ` with exit code ${item.exitCode}`
          : "";
      return `Ran ${command}${failed}${failed === "" ? "" : exit}`;
    }
    case "file_change": {
      const file = quoted(basename(item.fileName), 80);
      return failed ? `Failed to edit ${file}` : `${active ? "Editing" : "Edited"} ${file}`;
    }
    case "file_search":
      return `Searched files${item.pattern ? ` for ${quoted(item.pattern, 60)}` : ""}${failed}`;
    case "web_search": {
      const query = item.patterns?.[0];
      return `Searched the web${query ? ` for ${quoted(query, 80)}` : ""}${failed}`;
    }
    case "dynamic_tool":
      const tool = item.toolName ?? item.title;
      return `${active ? "Using" : "Used"} ${tool ? quoted(tool, 60) : "a tool"}${failed}`;
    case "subagent": {
      const prompt = item.prompt.trim() === "" ? "" : `: ${quoted(item.prompt, 80)}`;
      return `${active ? "Running" : "Ran"} a subagent${prompt}${failed}`;
    }
    case "error":
      return `Hit an error: ${quoted(item.failure.message, 200)}`;
    default:
      return null;
  }
}

function stepItems(items: ReadonlyArray<OrchestrationV2TurnItem>): OrchestrationV2TurnItem[] {
  return items.filter((item) => STEP_TYPES.has(item.type));
}

type ProjectionRun = OrchestrationV2ThreadProjection["runs"][number];

const ACTIVE_RUN_STATUSES: ReadonlySet<ProjectionRun["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

function currentRun(projection: OrchestrationV2ThreadProjection): ProjectionRun | null {
  return (
    projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status)) ??
    projection.runs.at(-1) ??
    null
  );
}

function runPrompt(projection: OrchestrationV2ThreadProjection, run: ProjectionRun) {
  const text = projection.messages.find((message) => message.id === run.userMessageId)?.text;
  return text === undefined || text.trim() === "" ? null : text;
}

/** The thread's latest finished assistant message, if the projection holds one. */
export function lastAssistantMessage(projection: OrchestrationV2ThreadProjection): string | null {
  return (
    projection.messages.findLast(
      (message) => message.role === "assistant" && !message.streaming && message.text.trim() !== "",
    )?.text ?? null
  );
}

function subject(row: Pick<VoiceThreadRow, "title" | "project" | "provider">, handle: string) {
  return `${handle} ${quoted(row.title, 80)} in ${quoted(row.project, 80)} (${row.provider})`;
}

/**
 * The rolling "[agent activity]" of a running thread: what it works on and its latest steps.
 * Sent under the thread's context id, so each replaces the last.
 */
export function voiceActivityUpdate(
  row: VoiceThreadRow,
  handle: string,
  projection: OrchestrationV2ThreadProjection,
  busy: boolean,
): string {
  const run = currentRun(projection);
  const steps =
    run === null ? [] : stepItems(projection.turnItems.filter((item) => item.runId === run.id));
  if (!busy) {
    const last = steps.slice(-ACTIVITY_STEPS).map(voiceStepLine).join("; ");
    return `[agent activity] ${subject(row, handle)} is not working any more.${
      last === "" ? "" : ` Its last steps, oldest first: ${last}.`
    }`;
  }
  const prompt = run === null ? null : runPrompt(projection, run);
  const failed = steps.filter(isFailedStep).length;
  const head = `[agent activity] ${subject(row, handle)} is working${
    prompt === null ? "" : ` on: ${quoted(prompt, 300)}`
  }. ${plural(steps.length, "step")} so far${failed > 0 ? `, ${failed} failed` : ""}.`;
  if (steps.length === 0) return head;
  return `${head} Latest steps, oldest first: ${steps.slice(-ACTIVITY_STEPS).map(voiceStepLine).join("; ")}.`;
}

/** What a pending approval asks for, such as `to run a command: "pnpm db:migrate"`. */
export function voiceApprovalDetail(approval: ThreadPendingApproval): string | null {
  const what = REQUEST_WORDS[approval.requestKind] ?? "";
  const detail = approval.detail ? `: ${quoted(approval.detail, 300)}` : "";
  const reason = approval.reason ? ` (reason: ${quoted(approval.reason, 200)})` : "";
  const text = `${what}${detail}${reason}`.trim();
  return text === "" ? null : text;
}

/** A pending question and its options, in plain words. */
export function voiceQuestionDetail(input: ThreadPendingUserInput): string | null {
  if (input.questions.length === 0) return null;
  return input.questions
    .map((question) => {
      const options =
        question.options.length === 0
          ? ""
          : ` (options: ${question.options.map((option) => quoted(option.label, 60)).join(", ")}${
              question.multiSelect ? "; several allowed" : ""
            })`;
      return `${quoted(question.question, 200)}${options}`;
    })
    .join("; ");
}

const EVENT_WORDS: Record<VoiceEventKind, string> = {
  finished: "finished",
  approval: "needs approval",
  input: "has a question",
  request: "has a guest request",
  failed: "failed",
  limited: "hit a usage limit",
};

const EVENT_ASKS: Record<VoiceEventKind, string> = {
  finished: "Tell the user the gist in one short sentence.",
  approval:
    "Tell the user what it wants to do in one short sentence and ask whether to approve it once or decline.",
  input: "Ask the user its question in one short sentence.",
  request: "Mention it in one short sentence.",
  failed: "Tell the user in one short sentence what went wrong.",
  limited: "Tell the user in one short sentence.",
};

function eventFact(event: VoiceEvent): string {
  const who = subject(event, event.handle);
  switch (event.kind) {
    case "finished":
      return `${who} finished its turn. ${
        event.detail
          ? `Its final message: ${quoted(event.detail, 900)}`
          : "It left no final message."
      }`;
    case "approval":
      return `${who} needs the user's approval${event.detail ? ` ${event.detail}` : ""}.`;
    case "input":
      return `${who} has a question for the user${event.detail ? `: ${event.detail}` : ""}.`;
    case "request":
      return `${who} has a guest message waiting for the user to review.`;
    case "failed":
      return `${who} failed${event.detail ? `: ${quoted(event.detail, 300)}` : ""}.`;
    case "limited":
      return `${who} stopped at a usage limit${event.detail ? ` (${quoted(event.detail, 300)})` : ""}.`;
  }
}

/** Speak mode `needs` keeps completions quiet; `none` keeps everything quiet. */
export function voiceEventIsSpoken(kind: VoiceEventKind, speakMode: VoiceAgentSpeakMode): boolean {
  return speakMode === "all" || (speakMode === "needs" && kind !== "finished");
}

/**
 * The "[agent event]" the agent answers aloud (null when the speak mode keeps it quiet), and
 * the same facts as quiet "[agent activity]" context.
 */
export function voiceEventMessages(
  event: VoiceEvent,
  speakMode: VoiceAgentSpeakMode,
): { readonly spoken: string | null; readonly quiet: string } {
  const fact = eventFact(event);
  return {
    spoken: voiceEventIsSpoken(event.kind, speakMode)
      ? `[agent event] ${fact} ${EVENT_ASKS[event.kind]}`
      : null,
    quiet: `[agent activity] ${fact}`,
  };
}

/** A few words naming an event, for the waiting list. */
export function voiceEventLabel(event: VoiceEvent): string {
  return `${event.handle} ${quoted(event.title, 80)} ${EVENT_WORDS[event.kind]}`;
}

export function voiceEventFeed(event: VoiceEvent): Omit<VoiceFeedEntry, "id" | "at"> {
  return {
    tone: event.kind === "finished" ? "ok" : event.kind === "failed" ? "bad" : "attention",
    title: event.title,
    text: EVENT_WORDS[event.kind],
  };
}

export const VOICE_READ_FOCUSES = [
  "last_answer",
  "recent_steps",
  "errors",
  "overview",
  "pending_request",
] as const;
export type VoiceReadFocus = (typeof VOICE_READ_FOCUSES)[number];

function readHead(row: VoiceThreadRow, handle: string, now: number): string {
  return `${subject(row, handle)}: ${voiceStatusText(row, now)}.`;
}

/** The `t3_read_thread` answer: plain text for the agent to summarise. */
export function voiceReadAnswer(
  focus: Exclude<VoiceReadFocus, "pending_request">,
  row: VoiceThreadRow,
  handle: string,
  projection: OrchestrationV2ThreadProjection,
  now: number,
): string {
  const head = readHead(row, handle, now);
  const steps = stepItems(projection.turnItems);
  switch (focus) {
    case "last_answer": {
      const answer = lastAssistantMessage(projection);
      return answer === null
        ? `${head}\nIt has no final message yet.`
        : `${head}\nIts latest final message: ${quoted(answer, 2500)}`;
    }
    case "recent_steps":
      return steps.length === 0
        ? `${head}\nIt has not taken any steps yet.`
        : `${head}\nIts latest steps, oldest first:\n${steps.slice(-15).map(voiceStepLine).join("\n")}`;
    case "errors": {
      const failed = steps.filter(isFailedStep).slice(-8).map(voiceStepLine);
      const lines = [
        ...(row.error === null ? [] : [`Its last error: ${quoted(row.error, 600)}`]),
        ...(failed.length === 0
          ? ["No failed steps recently."]
          : ["Recent failed steps, oldest first:", ...failed]),
      ];
      return `${head}\n${lines.join("\n")}`;
    }
    case "overview": {
      const run = currentRun(projection);
      const prompt = run === null ? null : runPrompt(projection, run);
      const runSteps =
        run === null ? [] : stepItems(projection.turnItems.filter((item) => item.runId === run.id));
      const answer = lastAssistantMessage(projection);
      return [
        head,
        ...(prompt === null ? [] : [`Its latest prompt: ${quoted(prompt, 600)}`]),
        `Steps in its latest turn: ${runSteps.length}, ${runSteps.filter(isFailedStep).length} failed.`,
        ...(answer === null ? [] : [`Its latest final message: ${quoted(answer, 800)}`]),
      ].join("\n");
    }
  }
}

export const SUBAGENT_OUT_OF_REACH =
  "Its subagent's approval can't be answered from here: the user has to answer it in the app.";

/** The `t3_read_thread` answer for `pending_request`, about the requests the tools would answer. */
export function voicePendingAnswer(
  row: VoiceThreadRow,
  handle: string,
  now: number,
  pending: {
    readonly approval: ThreadPendingApproval | undefined;
    readonly question: ThreadPendingUserInput | undefined;
    readonly subagent: string | null;
  },
): string {
  const head = readHead(row, handle, now);
  const { approval, question } = pending;
  if (approval === undefined && question === undefined) {
    return `${head}\n${subagentApproval(row) ? SUBAGENT_OUT_OF_REACH : "Nothing is waiting on the user."}`;
  }
  const who = pending.subagent === null ? "It" : `Its subagent ${quoted(pending.subagent, 80)}`;
  const approvalText = approval === undefined ? null : voiceApprovalDetail(approval);
  const questionText = question === undefined ? null : voiceQuestionDetail(question);
  return [
    head,
    ...(approval === undefined
      ? []
      : [`${who} waits for approval${approvalText === null ? "" : ` ${approvalText}`}.`]),
    ...(questionText === null ? [] : [`${who} asks: ${questionText}.`]),
  ].join("\n");
}
