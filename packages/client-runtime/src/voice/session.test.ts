import { VOICE_AGENT_TOOL_NAMES, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentThreadShell } from "../state/models.ts";
import { WORKING_EXIT_GRACE_MS } from "../state/threadInbox.ts";
import { AFTER_AGENT_MS } from "./announcements.ts";
import { ACTIVITY_THROTTLE_MS, NUDGE, NUDGE_GAP_MS, VoiceSession, WATCHDOG_MS } from "./session.ts";
import type {
  VoiceActions,
  VoiceSessionState,
  VoiceThreadSubscriber,
  VoiceThreadsInput,
} from "./types.ts";
import {
  approvalFields,
  approvalProjection,
  commandItem,
  createTestClock,
  createTestTransport,
  environmentId,
  finishedFields,
  message,
  project,
  projection,
  run,
  runId,
  shell,
  T0,
  workingFields,
  type SentToAgent,
} from "./voice.testkit.ts";

const projects = [project("project-v2", "shop")];
const threads = (...list: VoiceThreadsInput["threads"]): VoiceThreadsInput => ({
  threads: list,
  projects,
});

const messages = (sent: ReadonlyArray<SentToAgent>) =>
  sent.flatMap((entry) => (entry.type === "message" ? [entry.text] : []));

function stubActions(read: () => Promise<OrchestrationV2ThreadProjection>): VoiceActions {
  return {
    send: async () => "started",
    stop: async () => {},
    respondToApproval: async () => {},
    respondToUserInput: async () => {},
    readThread: read,
    openThread: () => {},
    startThread: async () => {
      throw new Error("not in this test");
    },
  };
}

/** A connected call over the test transport; the agent is still speaking its greeting. */
async function liveCall(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly read?: () => Promise<OrchestrationV2ThreadProjection>;
  readonly actions?: Partial<VoiceActions>;
  readonly subscribeThread?: VoiceThreadSubscriber;
}) {
  const { clock, advance } = createTestClock();
  const { transport, sent, started } = createTestTransport();
  const session = new VoiceSession({
    transport,
    createCallToken: async () => ({ token: "token", environmentId }),
    actions: { ...stubActions(input.read ?? (async () => projection())), ...input.actions },
    subscribeThread: input.subscribeThread ?? (() => () => {}),
    childRequests: () => [],
    clock,
  });
  session.setThreads(threads(...input.threads));
  await session.start();
  started().callbacks.onConnect();
  return { session, sent, started, advance };
}

function nextState(session: VoiceSession, matches: (state: VoiceSessionState) => boolean) {
  return new Promise<VoiceSessionState>((resolve) => {
    const stop = session.subscribe(() => {
      const state = session.getSnapshot();
      if (!matches(state)) return;
      stop();
      resolve(state);
    });
  });
}

describe("VoiceSession", () => {
  it("tells of a finished thread aloud once the floor is free", async () => {
    const { session, sent, started, advance } = await liveCall({
      threads: [shell("cart", workingFields("cart", T0 - 60_000))],
      read: async () =>
        projection({ messages: [message("answer", "assistant", "All 48 tests pass.")] }),
    });
    started().callbacks.onModeChange("listening");

    session.setThreads(threads(shell("cart", finishedFields("cart", T0))));
    const delivered = nextState(session, (state) => state.feed.length === 1);
    advance(WORKING_EXIT_GRACE_MS);
    await delivered;
    advance(AFTER_AGENT_MS);

    const fact =
      't1 "cart" in "shop" (Codex) finished its turn. Its final message: "All 48 tests pass."';
    expect(sent).toContainEqual({
      type: "context",
      text: `[agent activity] ${fact}`,
      contextId: undefined,
    });
    expect(messages(sent)).toEqual([
      `[agent event] ${fact} Tell the user the gist in one short sentence.`,
    ]);
    expect(session.getSnapshot()).toMatchObject({
      status: "live",
      waiting: 0,
      environmentId,
      feed: [{ tone: "ok", title: "cart", text: "finished" }],
    });
  });

  it("drops a waiting update once its request is answered elsewhere", async () => {
    const { session, sent, started, advance } = await liveCall({
      threads: [shell("auth", workingFields("auth", T0 - 60_000))],
      read: async () => approvalProjection("pnpm db:migrate"),
    });
    const queued = nextState(session, (state) => state.waiting === 1);
    session.setThreads(threads(shell("auth", approvalFields("auth", T0))));
    await queued;

    session.setThreads(threads(shell("auth", workingFields("auth", T0 - 60_000))));
    expect(session.getSnapshot().waiting).toBe(0);
    started().callbacks.onModeChange("listening");
    advance(AFTER_AGENT_MS);

    expect(messages(sent)).toEqual([]);
  });

  it("drops waiting updates a quieter speak mode no longer tells", async () => {
    const { session, sent, started, advance } = await liveCall({
      threads: [
        shell("cart", workingFields("cart", T0 - 60_000)),
        shell("search", workingFields("search", T0 - 60_000)),
      ],
    });
    const queued = nextState(session, (state) => state.waiting === 2);
    session.setThreads(
      threads(
        shell("cart", finishedFields("cart", T0)),
        shell("search", finishedFields("search", T0)),
      ),
    );
    advance(WORKING_EXIT_GRACE_MS);
    await queued;

    session.setSpeakMode("needs");
    expect(session.getSnapshot().waiting).toBe(0);
    started().callbacks.onModeChange("listening");
    advance(AFTER_AGENT_MS);

    expect(messages(sent)).toEqual([]);
  });

  it("does not count an approval the agent got only as quiet context as told", async () => {
    const respondToApproval = vi.fn<VoiceActions["respondToApproval"]>(async () => {});
    const { session, sent, started } = await liveCall({
      threads: [shell("stripe", workingFields("stripe", T0 - 60_000))],
      read: async () => approvalProjection("pnpm db:migrate"),
      actions: { respondToApproval },
    });
    const { callbacks, clientTools } = started();
    // The agent is still greeting, so the spoken update waits and only the quiet context is out.
    const queued = nextState(session, (state) => state.waiting === 1);
    session.setThreads(threads(shell("stripe", approvalFields("stripe", T0))));
    await queued;
    expect(messages(sent)).toEqual([]);

    callbacks.onMessage("user", "Yes, go ahead.");
    expect(
      await clientTools[VOICE_AGENT_TOOL_NAMES.answerRequest]!({
        thread: "t1",
        decision: "approve_once",
      }),
    ).toMatch(/which the user has not heard about/);
    expect(respondToApproval).not.toHaveBeenCalled();
  });

  it("approves only once the user has answered the app's last update", async () => {
    const respondToApproval = vi.fn<VoiceActions["respondToApproval"]>(async () => {});
    const { session, sent, started, advance } = await liveCall({
      threads: [shell("stripe", workingFields("stripe", T0 - 60_000))],
      read: async () => approvalProjection("pnpm db:migrate"),
      actions: { respondToApproval },
    });
    const { callbacks, clientTools } = started();
    callbacks.onModeChange("listening");
    callbacks.onMessage("user", "Hey, what's going on?");
    callbacks.onMessage("agent", "All quiet so far.");

    const queued = nextState(session, (state) => state.waiting === 1);
    session.setThreads(threads(shell("stripe", approvalFields("stripe", T0))));
    await queued;
    advance(AFTER_AGENT_MS);
    expect(messages(sent)).toEqual([
      expect.stringMatching(/^\[agent event\] t1 "stripe" .* to run a command: "pnpm db:migrate"/),
    ]);

    // The update itself can't stand in for the user's yes, whatever an agent wrote into it.
    const approve = () =>
      clientTools[VOICE_AGENT_TOOL_NAMES.answerRequest]!({
        thread: "t1",
        decision: "approve_once",
      });
    expect(await approve()).toMatch(/^The user has not spoken since this request/);
    expect(respondToApproval).not.toHaveBeenCalled();

    callbacks.onMessage("user", "Yes, go ahead.");
    expect(await approve()).toMatch(/^Approved once the request to run a command/);
    expect(respondToApproval).toHaveBeenCalledOnce();
  });

  it("nudges an agent that promised to relay something and called no tool, never after an offer", async () => {
    const { sent, started, advance } = await liveCall({ threads: [] });
    const { callbacks, clientTools } = started();
    callbacks.onModeChange("listening");
    const nudges = () => messages(sent).filter((text) => text === NUDGE).length;

    callbacks.onMessage("agent", "One sec, let me check.");
    advance(WATCHDOG_MS);
    expect(nudges()).toBe(1);

    advance(NUDGE_GAP_MS);
    callbacks.onMessage("agent", "Say yes and I'll approve it.");
    advance(WATCHDOG_MS);
    callbacks.onMessage("agent", "Say the word and I'll send it.");
    advance(WATCHDOG_MS);
    callbacks.onMessage("agent", "Sending that now.");
    await clientTools[VOICE_AGENT_TOOL_NAMES.nextUpdate]!({});
    advance(WATCHDOG_MS);

    expect(nudges()).toBe(1);
  });

  it("streams throttled activity for running threads only while they run and the call is live", async () => {
    const listeners = new Map<string, (projection: OrchestrationV2ThreadProjection) => void>();
    const unsubscribed: string[] = [];
    const subscribeThread = vi.fn<VoiceThreadSubscriber>((ref, listener) => {
      listeners.set(ref.threadId, listener);
      return () => unsubscribed.push(ref.threadId);
    });
    const { session, sent, advance } = await liveCall({
      threads: [
        shell("busy", workingFields("busy", T0 - 60_000)),
        shell("idle", finishedFields("idle", T0 - 60_000)),
      ],
      subscribeThread,
    });
    expect(subscribeThread.mock.calls.map(([ref]) => ref.threadId)).toEqual(["busy"]);

    const prompt = message("prompt", "user", "Fix checkout", runId("busy"));
    const busyProjection = (steps: number) =>
      projection({
        runs: [run(runId("busy"), "running", prompt.id)],
        messages: [prompt],
        turnItems: Array.from({ length: steps }, (_, index) =>
          commandItem(`step-${index}`, `step ${index}`, { runId: runId("busy") }),
        ),
      });
    const activity = () =>
      sent.flatMap((entry) =>
        entry.type === "context" && entry.contextId === "thread-t1" ? [entry.text] : [],
      );
    listeners.get("busy")!(busyProjection(1));
    listeners.get("busy")!(busyProjection(2));
    expect(activity()).toEqual([
      '[agent activity] t1 "busy" in "shop" (Codex) is working on: "Fix checkout". 1 step so far. Latest steps, oldest first: Ran "step 0".',
    ]);
    advance(ACTIVITY_THROTTLE_MS);
    expect(activity()).toHaveLength(2);
    expect(activity()[1]).toMatch(/2 steps so far/);

    session.setThreads(
      threads(
        shell("busy", finishedFields("busy", T0 + ACTIVITY_THROTTLE_MS)),
        shell("next", workingFields("next", T0)),
      ),
    );
    expect(unsubscribed).toEqual(["busy"]);
    expect(activity()[2]).toBe(
      '[agent activity] t1 "busy" in "shop" (Codex) is not working any more. Its last steps, oldest first: Ran "step 0"; Ran "step 1".',
    );
    expect(subscribeThread.mock.calls.map(([ref]) => ref.threadId)).toEqual(["busy", "next"]);

    await session.end();
    expect(unsubscribed).toEqual(["busy", "next"]);
    expect(session.getSnapshot()).toMatchObject({ status: "idle", environmentId: null });
  });
});
