// @effect-diagnostics globalTimers:off globalDate:off - The voice call runs in web and native clients, outside an Effect runtime.
import {
  VoiceAgentError,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
  type VoiceAgentSpeakMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { scopedThreadKey } from "../environment/scoped.ts";
import {
  createThreadNotificationGate,
  type ThreadNotificationGate,
  type ThreadNotificationKind,
} from "../state/threadNotificationGate.ts";
import { derivePendingThreadRequests } from "../state/threadRequests.ts";
import type { ThreadStatus } from "../state/threadStatus.ts";
import { AnnouncementQueue } from "./announcements.ts";
import {
  buildVoiceSnapshot,
  buildVoiceThreadRows,
  captionText,
  lastAssistantMessage,
  quoted,
  voiceActivityUpdate,
  voiceApprovalDetail,
  voiceDynamicVariables,
  voiceEventFeed,
  voiceEventIsSpoken,
  voiceEventLabel,
  voiceEventMessages,
  VoiceHandles,
  voiceProjectLabels,
  voiceQuestionDetail,
  voiceRequestTarget,
  type VoiceRowOptions,
} from "./context.ts";
import { createVoiceTools, VoiceHeardRequests } from "./tools.ts";
import type {
  VoiceCallToken,
  VoiceClock,
  VoiceEvent,
  VoiceEventKind,
  VoiceFeedEntry,
  VoiceSessionOptions,
  VoiceSessionState,
  VoiceThreadRow,
  VoiceThreadsInput,
  VoiceToolHandler,
  VoiceTransportCallbacks,
} from "./types.ts";

const VAD_SPEAKING = 0.5;
/** The user counts as speaking for this long after their voice was last heard. */
const USER_HOLD_MS = 1500;
const TICK_MS = 500;
/** Long silences are the norm on this call; activity keeps the agent from checking in. */
const HEARTBEAT_MS = 25_000;
export const WATCHDOG_MS = 5000;
const WATCHDOG_RETRY_MS = 2000;
export const NUDGE_GAP_MS = 15_000;
/** A running thread's rolling activity goes out at most this often. */
export const ACTIVITY_THROTTLE_MS = 3000;
/** A changed thread set re-sends the snapshot at most this often. */
const SNAPSHOT_THROTTLE_MS = 10_000;
const FEED_LIMIT = 8;
const PENDING_CONTEXT = "t3-pending";
const SNAPSHOT_CONTEXT = "t3-snapshot";
const OPEN_THREAD_CONTEXT = "t3-open-thread";
// Only promises to relay or look something up. Stopping, approving or starting needs a yes first.
const PROMISE =
  /\b(?:one (?:sec|second|moment)|let me (?:send|tell|pass|ask|check|look|pull)|i['’]?ll (?:send|tell|pass|ask)|sending (?:that|it)|passing (?:that|it))\b/i;
/** A question or an offer waits for the user's answer, so it is no promise to act. */
const OFFER =
  /\?|\b(?:if you(?:['’]d)? (?:like|want)|say (?:yes|so|the word)|want me to|should i|shall i)\b/i;
export const NUDGE =
  "[continue] You said you would do something but did not call the tool. If the user already asked for it, call it now and carry on from its result. If you were waiting for their answer, stay quiet.";

const systemVoiceClock: VoiceClock = {
  now: () => Date.now(),
  schedule: (delayMs, run) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
};

const isVoiceAgentError = Schema.is(VoiceAgentError);

/** What T3Bud says when a call cannot start. */
function voiceCallErrorMessage(error: unknown): string {
  if (isVoiceAgentError(error)) {
    switch (error.reason) {
      case "notConfigured":
        return "Add an ElevenLabs API key in Settings › Voice, then call again.";
      case "invalidKey":
        return "ElevenLabs rejected the API key. Check it in Settings › Voice.";
      case "elevenLabs":
        return `ElevenLabs refused the call: ${error.detail}`;
      case "network":
        return "Couldn't reach ElevenLabs. Check the connection and call again.";
    }
  }
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}

const ATTENTION_EVENTS: Partial<Record<ThreadStatus, VoiceEventKind>> = {
  approval: "approval",
  input: "input",
  request: "request",
  failed: "failed",
  limited: "limited",
};

const IDLE_CALL_STATE = {
  mode: "listening",
  agentLine: null,
  userLine: null,
  userSpeaking: false,
  waiting: 0,
  environmentId: null,
} as const satisfies Partial<VoiceSessionState>;

interface ActivityStream {
  projection: OrchestrationV2ThreadProjection | null;
  lastText: string | null;
  lastFlushAt: number;
  cancelFlush: (() => void) | null;
  unsubscribe: () => void;
}

interface Call {
  connected: boolean;
  readonly handles: VoiceHandles;
  readonly announcements: AnnouncementQueue;
  readonly gate: ThreadNotificationGate<string>;
  rows: ReadonlyMap<string, VoiceThreadRow>;
  readonly streams: Map<string, ActivityStream>;
  /** Final messages seen this call, for the snapshot's finished threads. */
  readonly lastMessages: Map<string, string>;
  readonly heard: VoiceHeardRequests;
  /**
   * The user spoke after the app last gave the agent a turn of its own (an update or an offer).
   * Sending, starting, approving and answering need it, so text an agent wrote can never
   * trigger them.
   */
  userSpokeLast: boolean;
  lastSnapshotAt: number;
  cancelSnapshot: (() => void) | null;
  cancelTick: (() => void) | null;
  cancelWatchdog: (() => void) | null;
  lastUserVoiceAt: number;
  /** The last time the app said something to the agent. */
  lastMessageAt: number;
  lastToolAt: number;
  lastNudgeAt: number;
}

const EMPTY_ROWS: ReadonlyMap<string, VoiceThreadRow> = new Map();

/**
 * One voice call with the agent at a time, over a platform transport. While a call is live it
 * watches every thread the host feeds it: events pass the notification gate into spoken
 * announcements or quiet context, and running threads stream their steps as rolling activity.
 */
export class VoiceSession {
  private readonly options: VoiceSessionOptions;
  private readonly clock: VoiceClock;
  private readonly rowOptions: VoiceRowOptions;
  private readonly listeners = new Set<() => void>();
  private state: VoiceSessionState = {
    status: "idle",
    error: null,
    muted: false,
    feed: [],
    ...IDLE_CALL_STATE,
  };
  private input: VoiceThreadsInput = { threads: [], projects: [] };
  private openKey: string | null = null;
  private speakMode: VoiceAgentSpeakMode;
  private call: Call | null = null;
  private feedId = 0;

  constructor(options: VoiceSessionOptions) {
    this.options = options;
    this.clock = options.clock ?? systemVoiceClock;
    this.speakMode = options.speakMode ?? "all";
    this.rowOptions = {
      providerLabel: options.providerLabel,
      environmentLabel: options.environmentLabel,
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): VoiceSessionState => this.state;

  setSpeakMode(mode: VoiceAgentSpeakMode): void {
    if (mode === this.speakMode) return;
    this.speakMode = mode;
    const call = this.call;
    if (call === null || !call.connected) return;
    if (call.announcements.retain((item) => voiceEventIsSpoken(item.event, mode))) {
      this.waitingChanged(call);
    }
  }

  /** The thread open in the app, which tools act on when the agent names none. */
  setOpenThread(ref: ScopedThreadRef | null): void {
    const key = ref === null ? null : scopedThreadKey(ref);
    if (key === this.openKey) return;
    this.openKey = key;
    const call = this.call;
    if (call === null || !call.connected) return;
    const row = key === null ? undefined : call.rows.get(key);
    this.context(
      call,
      row === undefined
        ? "[agent activity] No thread is open in the app now."
        : `[agent activity] The user opened ${call.handles.of(row.key)} ${quoted(row.title, 80)} in the app. Tools act on it when you name no thread.`,
      OPEN_THREAD_CONTEXT,
    );
  }

  /** Call on every change of the listed threads or projects. Cheap while no call is live. */
  setThreads(input: VoiceThreadsInput): void {
    this.input = input;
    const call = this.call;
    if (call !== null && call.connected) this.refresh(call, false);
  }

  async start(): Promise<void> {
    if (this.call !== null) return;
    const call = this.createCall();
    this.call = call;
    this.update({ status: "connecting", error: null, muted: false, ...IDLE_CALL_STATE });
    let token: VoiceCallToken;
    try {
      token = await this.options.createCallToken();
    } catch (error) {
      if (this.call === call) this.fail(call, voiceCallErrorMessage(error));
      return;
    }
    if (this.call !== call) return;
    this.update({ environmentId: token.environmentId });
    const rows = buildVoiceThreadRows(this.input, this.rowOptions);
    try {
      await this.options.transport.start({
        conversationToken: token.token,
        dynamicVariables: {
          ...voiceDynamicVariables(rows, {
            handles: call.handles,
            openKey: this.openKey,
            projects: this.projectNames(),
          }),
          animal: this.options.animal?.() ?? "wolf",
        },
        clientTools: this.tools(call),
        callbacks: this.callbacks(call),
      });
    } catch (error) {
      if (this.call === call) {
        this.fail(call, `Couldn't start the call: ${voiceCallErrorMessage(error)}`);
      }
    }
  }

  async end(): Promise<void> {
    const call = this.call;
    if (call === null) {
      if (this.state.status !== "idle") this.update({ status: "idle", error: null });
      return;
    }
    this.cleanup(call);
    this.update({ status: "idle", error: null, ...IDLE_CALL_STATE });
    try {
      await this.options.transport.end();
    } catch (error) {
      this.report("Ending the voice call failed", error);
    }
  }

  setMuted(muted: boolean): void {
    if (this.state.muted === muted) return;
    this.update({ muted });
    if (this.call?.connected) {
      this.transportCall("Muting the microphone failed", () =>
        this.options.transport.setMicMuted(muted),
      );
    }
  }

  toggleMute(): void {
    this.setMuted(!this.state.muted);
  }

  /** 0..1, for the head's jaw. */
  outputLevel(): number {
    return this.call?.connected ? this.options.transport.outputLevel() : 0;
  }

  /** 0..1, for the head's listening tilt. */
  inputLevel(): number {
    return this.call?.connected && !this.state.muted ? this.options.transport.inputLevel() : 0;
  }

  dispose(): void {
    void this.end();
    this.listeners.clear();
  }

  private createCall(): Call {
    const call: Call = {
      connected: false,
      handles: new VoiceHandles(),
      announcements: new AnnouncementQueue(),
      gate: createThreadNotificationGate<string>(
        (key, kind) => this.onThreadEvent(call, key, kind),
        this.clock.schedule,
      ),
      rows: EMPTY_ROWS,
      streams: new Map(),
      lastMessages: new Map(),
      heard: new VoiceHeardRequests(),
      userSpokeLast: false,
      lastSnapshotAt: -Infinity,
      cancelSnapshot: null,
      cancelTick: null,
      cancelWatchdog: null,
      lastUserVoiceAt: -Infinity,
      lastMessageAt: -Infinity,
      lastToolAt: -Infinity,
      lastNudgeAt: -Infinity,
    };
    return call;
  }

  private callbacks(call: Call): VoiceTransportCallbacks {
    const live = () => this.call === call;
    return {
      onConnect: () => {
        if (live() && !call.connected) this.onConnected(call);
      },
      onDisconnect: (error) => {
        if (!live()) return;
        this.cleanup(call);
        this.update({ status: error === null ? "idle" : "error", error, ...IDLE_CALL_STATE });
      },
      onModeChange: (mode) => {
        if (!live()) return;
        call.announcements.agentSpeaking(mode === "speaking", this.clock.now());
        this.update({ mode });
      },
      onMessage: (role, raw) => {
        const text = captionText(role, raw);
        if (!live() || text === null) return;
        const now = this.clock.now();
        if (role === "user") {
          call.userSpokeLast = true;
          call.heard.userSpoke();
          call.lastUserVoiceAt = now;
          call.announcements.userSpoke(now);
          call.announcements.replyOwed(now);
          this.clearWatchdog(call);
          this.update({ userLine: text });
          return;
        }
        call.announcements.agentReplied(now);
        this.update({ agentLine: { text, final: true } });
        this.armWatchdog(call, text);
      },
      onTentativeAgent: (raw) => {
        const text = captionText("agent", raw);
        if (!live() || text === null) return;
        call.announcements.agentDrafting(this.clock.now());
        this.update({ agentLine: { text, final: false } });
      },
      onAgentCorrection: (raw) => {
        const text = captionText("agent", raw);
        if (live() && text !== null) this.update({ agentLine: { text, final: true } });
      },
      onVadScore: (score) => {
        if (!live() || score < VAD_SPEAKING) return;
        const now = this.clock.now();
        call.lastUserVoiceAt = now;
        call.announcements.userSpoke(now);
      },
    };
  }

  private onConnected(call: Call): void {
    const now = this.clock.now();
    call.connected = true;
    call.lastMessageAt = now;
    // The agent opens with its first message.
    call.announcements.agentSpeaking(true, now);
    this.update({ status: "live", error: null, mode: "speaking" });
    if (this.state.muted) {
      this.transportCall("Muting the microphone failed", () =>
        this.options.transport.setMicMuted(true),
      );
    }
    this.refresh(call, true);
    this.tick(call);
  }

  /** Rows from the latest input through the gate, the snapshot and the activity streams. */
  private refresh(call: Call, connecting: boolean): void {
    const previous = call.rows;
    const rows = buildVoiceThreadRows(this.input, this.rowOptions, previous);
    call.rows = rows;
    const changedRows: VoiceThreadRow[] = [];
    // Waiting updates about attention that cleared or threads that left: answered elsewhere, archived.
    const stale = new Set<string>();
    let statusChanged = false;
    for (const row of rows.values()) {
      const prior = previous.get(row.key);
      if (prior === row) continue;
      changedRows.push(row);
      if (prior?.status !== row.status) statusChanged = true;
      if (prior !== undefined && prior.attention !== null && row.attention !== prior.attention) {
        stale.add(row.key);
      }
    }
    let removed = false;
    for (const key of previous.keys()) {
      if (rows.has(key)) continue;
      removed = true;
      stale.add(key);
    }
    // Handles go out in rank order with the first snapshot, before anything else names a thread.
    if (connecting) this.sendSnapshot(call);
    else if (statusChanged || removed) this.scheduleSnapshot(call);
    if (removed) call.gate.retain(new Set(rows.keys()));
    if (stale.size > 0 && call.announcements.retain((item) => !stale.has(item.kind))) {
      this.waitingChanged(call);
    }
    for (const row of changedRows) {
      call.gate.observe(row.key, previous.get(row.key), row, {
        archived: row.shell.archivedAt !== null,
        quiet: row.quiet,
      });
    }
    for (const row of changedRows) {
      if (row.running && !call.streams.has(row.key)) this.startStream(call, row);
    }
    for (const [key, stream] of call.streams) {
      const row = rows.get(key);
      if (row === undefined || !row.running) this.stopStream(call, key, stream, row);
    }
  }

  private projectNames(): string[] {
    return [
      ...new Set(voiceProjectLabels(this.input.projects, this.options.environmentLabel).values()),
    ];
  }

  private scheduleSnapshot(call: Call): void {
    if (call.cancelSnapshot !== null) return;
    const wait = call.lastSnapshotAt + SNAPSHOT_THROTTLE_MS - this.clock.now();
    if (wait <= 0) {
      this.sendSnapshot(call);
      return;
    }
    call.cancelSnapshot = this.clock.schedule(wait, () => {
      call.cancelSnapshot = null;
      if (this.call === call) this.sendSnapshot(call);
    });
  }

  private sendSnapshot(call: Call): void {
    const now = this.clock.now();
    call.lastSnapshotAt = now;
    this.context(
      call,
      buildVoiceSnapshot(call.rows, {
        handles: call.handles,
        openKey: this.openKey,
        projects: this.projectNames(),
        lastMessages: call.lastMessages,
        now,
      }),
      SNAPSHOT_CONTEXT,
    );
  }

  private startStream(call: Call, row: VoiceThreadRow): void {
    const stream: ActivityStream = {
      projection: null,
      lastText: null,
      lastFlushAt: -Infinity,
      cancelFlush: null,
      unsubscribe: () => {},
    };
    call.streams.set(row.key, stream);
    stream.unsubscribe = this.options.subscribeThread(row.ref, (projection) => {
      if (this.call !== call || call.streams.get(row.key) !== stream || projection === null) return;
      stream.projection = projection;
      this.scheduleFlush(call, row.key, stream);
    });
  }

  private scheduleFlush(call: Call, key: string, stream: ActivityStream): void {
    if (stream.cancelFlush !== null) return;
    const wait = stream.lastFlushAt + ACTIVITY_THROTTLE_MS - this.clock.now();
    if (wait <= 0) {
      this.flush(call, key, stream);
      return;
    }
    stream.cancelFlush = this.clock.schedule(wait, () => {
      stream.cancelFlush = null;
      if (this.call === call && call.streams.get(key) === stream) this.flush(call, key, stream);
    });
  }

  private flush(call: Call, key: string, stream: ActivityStream): void {
    const row = call.rows.get(key);
    if (row === undefined || stream.projection === null) return;
    stream.lastFlushAt = this.clock.now();
    const message = lastAssistantMessage(stream.projection);
    if (message !== null) call.lastMessages.set(key, message);
    const handle = call.handles.of(key);
    const text = voiceActivityUpdate(row, handle, stream.projection, true);
    if (text === stream.lastText) return;
    stream.lastText = text;
    this.context(call, text, `thread-${handle}`);
  }

  private stopStream(
    call: Call,
    key: string,
    stream: ActivityStream,
    row: VoiceThreadRow | undefined,
  ): void {
    stream.cancelFlush?.();
    stream.unsubscribe();
    call.streams.delete(key);
    if (row === undefined || stream.projection === null) return;
    const handle = call.handles.of(key);
    this.context(
      call,
      voiceActivityUpdate(row, handle, stream.projection, false),
      `thread-${handle}`,
    );
  }

  private onThreadEvent(call: Call, key: string, kind: ThreadNotificationKind): void {
    if (this.call !== call || !call.connected) return;
    const row = call.rows.get(key);
    if (row === undefined) return;
    const eventKind = kind === "completion" ? "finished" : ATTENTION_EVENTS[row.status];
    if (eventKind === undefined) return;
    void this.describeEvent(call, row, eventKind).then((event) => {
      if (this.call === call && call.connected) this.deliver(call, event);
    });
  }

  private async describeEvent(
    call: Call,
    row: VoiceThreadRow,
    kind: VoiceEventKind,
  ): Promise<VoiceEvent> {
    const event: VoiceEvent = {
      kind,
      key: row.key,
      handle: call.handles.of(row.key),
      title: row.title,
      project: row.project,
      provider: row.provider,
      detail: kind === "failed" || kind === "limited" ? row.error : null,
      requestId: null,
    };
    if (kind !== "finished" && kind !== "approval" && kind !== "input") return event;
    try {
      if (kind === "finished") {
        const message = lastAssistantMessage(await this.options.actions.readThread(row.ref));
        if (message !== null) call.lastMessages.set(row.key, message);
        return { ...event, detail: message };
      }
      const where = voiceRequestTarget(row, this.options.childRequests);
      const pending = derivePendingThreadRequests(await this.options.actions.readThread(where.ref));
      if (kind === "input") {
        const question = call.heard.pick(pending.userInputs);
        if (question === undefined) return event;
        return { ...event, detail: voiceQuestionDetail(question), requestId: question.requestId };
      }
      const approval = call.heard.pick(pending.approvals);
      if (approval === undefined) return event;
      const detail = voiceApprovalDetail(approval);
      return {
        ...event,
        requestId: approval.requestId,
        detail:
          where.subagent === null
            ? detail
            : `for its subagent ${quoted(where.subagent, 80)}${detail === null ? "" : ` ${detail}`}`,
      };
    } catch (error) {
      this.report("Reading a thread for a voice event failed", error);
      return event;
    }
  }

  /** The facts go in as quiet context at once; the spoken message waits for the floor. */
  private deliver(call: Call, event: VoiceEvent): void {
    if (event.kind !== "finished") {
      // The request can be answered elsewhere while the event reads the thread.
      const row = call.rows.get(event.key);
      if (row === undefined || ATTENTION_EVENTS[row.status] !== event.kind) return;
    }
    const { spoken, quiet } = voiceEventMessages(event, this.speakMode);
    this.addFeed(voiceEventFeed(event));
    this.context(call, quiet);
    if (spoken === null) return;
    // Only the spoken update tells the user of its request; the quiet context does not.
    call.announcements.push(
      {
        text: spoken,
        label: voiceEventLabel(event),
        kind: event.key,
        event: event.kind,
        requestId: event.requestId,
      },
      this.clock.now(),
    );
    this.waitingChanged(call);
  }

  private waitingChanged(call: Call): void {
    this.context(call, call.announcements.pendingNote(), PENDING_CONTEXT);
    this.update({ waiting: call.announcements.size });
  }

  private tick(call: Call): void {
    call.cancelTick = this.clock.schedule(TICK_MS, () => {
      if (this.call !== call || !call.connected) return;
      this.drain(call);
      this.heartbeat(call);
      this.tick(call);
    });
  }

  private isUserSpeaking(call: Call, now: number): boolean {
    return now - call.lastUserVoiceAt < USER_HOLD_MS;
  }

  /** Once the agent has finished and the user isn't talking: the first waiting event, or the offer of the rest. */
  private drain(call: Call): void {
    const now = this.clock.now();
    const userSpeaking = this.isUserSpeaking(call, now);
    if (this.state.userSpeaking !== userSpeaking) this.update({ userSpeaking });
    const turn = call.announcements.take(now, userSpeaking);
    if (turn === null) return;
    call.lastMessageAt = now;
    call.userSpokeLast = false;
    if (turn.type === "announce") {
      if (turn.requestId !== null) call.heard.mark(turn.requestId);
      this.waitingChanged(call);
    }
    this.transportCall("Sending an update to the agent failed", () =>
      this.options.transport.sendUserMessage(turn.text),
    );
  }

  private heartbeat(call: Call): void {
    const now = this.clock.now();
    if (this.state.mode === "speaking" || this.isUserSpeaking(call, now)) return;
    if (now - call.lastMessageAt < HEARTBEAT_MS) return;
    call.lastMessageAt = now;
    this.transportCall("Sending a heartbeat failed", () =>
      this.options.transport.sendUserActivity(),
    );
  }

  /**
   * "Let me send that" with no tool call after it freezes a voice agent: nudge it once. The
   * nudge leaves `userSpokeLast` alone: it repeats the user's own request, not a new update.
   */
  private armWatchdog(call: Call, said: string): void {
    this.clearWatchdog(call);
    if (!PROMISE.test(said) || OFFER.test(said)) return;
    const saidAt = this.clock.now();
    const check = () => {
      call.cancelWatchdog = null;
      const now = this.clock.now();
      if (this.call !== call || !call.connected) return;
      if (call.lastToolAt >= saidAt || this.isUserSpeaking(call, now)) return;
      if (this.state.mode === "speaking") {
        call.cancelWatchdog = this.clock.schedule(WATCHDOG_RETRY_MS, check);
        return;
      }
      if (now - call.lastNudgeAt < NUDGE_GAP_MS) return;
      call.lastNudgeAt = now;
      call.lastMessageAt = now;
      call.announcements.replyOwed(now);
      this.transportCall("Nudging the agent failed", () =>
        this.options.transport.sendUserMessage(NUDGE),
      );
    };
    call.cancelWatchdog = this.clock.schedule(WATCHDOG_MS, check);
  }

  private clearWatchdog(call: Call): void {
    call.cancelWatchdog?.();
    call.cancelWatchdog = null;
  }

  private tools(call: Call): Record<string, VoiceToolHandler> {
    const tools = createVoiceTools({
      rows: () => call.rows,
      projects: () => this.input.projects,
      handles: call.handles,
      openThreadKey: () => this.openKey,
      actions: this.options.actions,
      childRequests: this.options.childRequests,
      heard: call.heard,
      userSpokeLast: () => call.userSpokeLast,
      nextUpdate: () => {
        const next = call.announcements.next(this.clock.now());
        if (next === null) return "No updates are waiting.";
        if (next.requestId !== null) call.heard.mark(next.requestId);
        call.userSpokeLast = false;
        this.waitingChanged(call);
        return next.text;
      },
      record: (entry) => this.addFeed(entry),
      environmentLabel: this.options.environmentLabel,
      now: this.clock.now,
    });
    // A tool call means the agent answers its result next: hold the queue for that.
    return Object.fromEntries(
      Object.entries(tools).map(([name, handler]): [string, VoiceToolHandler] => [
        name,
        (parameters) => {
          const now = this.clock.now();
          call.lastToolAt = now;
          call.announcements.replyOwed(now);
          this.clearWatchdog(call);
          return handler(parameters);
        },
      ]),
    );
  }

  /** Quiet context: the agent folds it in and doesn't answer. An id replaces the last one under it. */
  private context(call: Call, text: string, contextId?: string): void {
    if (this.call !== call || !call.connected) return;
    this.transportCall("Sending context to the agent failed", () =>
      this.options.transport.sendContextualUpdate(text, contextId),
    );
  }

  private fail(call: Call, error: string): void {
    this.cleanup(call);
    this.update({ status: "error", error, ...IDLE_CALL_STATE });
  }

  private cleanup(call: Call): void {
    call.connected = false;
    call.cancelTick?.();
    call.cancelWatchdog?.();
    call.cancelSnapshot?.();
    for (const stream of call.streams.values()) {
      stream.cancelFlush?.();
      stream.unsubscribe();
    }
    call.streams.clear();
    call.gate.clear();
    call.announcements.clear();
    if (this.call === call) this.call = null;
  }

  private addFeed(entry: Omit<VoiceFeedEntry, "id" | "at">): void {
    this.feedId += 1;
    const next = { ...entry, id: this.feedId, at: this.clock.now() };
    this.update({ feed: [...this.state.feed, next].slice(-FEED_LIMIT) });
  }

  private update(patch: Partial<VoiceSessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private transportCall(message: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.report(message, error);
    }
  }

  private report(message: string, cause: unknown): void {
    this.options.reportError?.(message, cause);
  }
}
