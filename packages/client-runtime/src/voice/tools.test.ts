import {
  RuntimeRequestId,
  ThreadId,
  VOICE_AGENT_TOOL_NAMES,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { scopedThreadKey } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "../state/models.ts";
import { buildVoiceThreadRows, VoiceHandles } from "./context.ts";
import { createVoiceTools, VoiceHeardRequests } from "./tools.ts";
import type { VoiceActions, VoiceDelivery } from "./types.ts";
import {
  approvalFields,
  approvalProjection,
  environmentId,
  finishedFields,
  project,
  projection,
  questionProjection,
  shell,
  T0,
  workingFields,
} from "./voice.testkit.ts";

const keyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey({ environmentId, threadId: thread.id });

const REQUESTED: Record<string, VoiceDelivery> = {
  auto: "started",
  steer: "steered",
  queue: "queued",
};

function harness(
  thread: EnvironmentThreadShell,
  options: {
    readonly open?: boolean;
    readonly read?: OrchestrationV2ThreadProjection;
    readonly children?: ReadonlyArray<EnvironmentThreadShell>;
    /** False: the agent has not been told of the fixtures' requests. */
    readonly heard?: boolean;
  } = {},
) {
  const projects = [project("project-v2", "shop")];
  const rows = buildVoiceThreadRows({ threads: [thread], projects });
  const handles = new VoiceHandles();
  handles.of(keyOf(thread));
  const heard = new VoiceHeardRequests();
  if (options.heard !== false) {
    // The user heard of the fixtures' requests and answered.
    heard.mark(RuntimeRequestId.make("approval-request"));
    heard.mark(RuntimeRequestId.make("question-request"));
    heard.userSpoke();
  }
  const actions = {
    send: vi.fn<VoiceActions["send"]>(async ({ mode }) => REQUESTED[mode]!),
    stop: vi.fn<VoiceActions["stop"]>(async () => {}),
    respondToApproval: vi.fn<VoiceActions["respondToApproval"]>(async () => {}),
    respondToUserInput: vi.fn<VoiceActions["respondToUserInput"]>(async () => {}),
    readThread: vi.fn<VoiceActions["readThread"]>(async () => options.read ?? projection()),
    openThread: vi.fn<VoiceActions["openThread"]>(),
    startThread: vi.fn<VoiceActions["startThread"]>(async () => ({
      environmentId,
      threadId: ThreadId.make("started"),
    })),
  };
  const tools = createVoiceTools({
    rows: () => rows,
    projects: () => projects,
    handles,
    openThreadKey: () => (options.open === false ? null : keyOf(thread)),
    actions,
    childRequests: () => options.children ?? [],
    heard,
    userSpokeLast: () => true,
    nextUpdate: () => "No updates are waiting.",
    record: () => {},
    now: () => T0,
  });
  return { tools, actions, heard };
}

describe("t3_send_to_thread", () => {
  it.each([
    [
      true,
      "now",
      "steer",
      "steered",
      "Steered into t1's running turn. Codex takes it into account now.",
    ],
    // A provider that can neither steer nor restart gets the steer queued.
    [true, "now", "steer", "queued", "Queued for t1. Codex gets it when the current turn ends."],
    [
      true,
      "after_current",
      "queue",
      "queued",
      "Queued for t1. Codex gets it when the current turn ends.",
    ],
    [false, "now", "auto", "started", "Sent to t1. Codex started on it."],
    [false, "after_current", "auto", "started", "Sent to t1. Codex started on it."],
  ] as const)(
    "a thread running=%s sent %s dispatches %s and reports it %s",
    async (running, when, mode, delivery, reply) => {
      const thread = shell(
        "cart",
        running ? workingFields("cart", T0 - 60_000) : finishedFields("cart", T0 - 60_000),
      );
      const { tools, actions } = harness(thread);
      actions.send.mockResolvedValueOnce(delivery);

      const result = await tools[VOICE_AGENT_TOOL_NAMES.sendToThread]({
        thread: "t1",
        prompt: "Fix the lint too",
        when,
        summary: "fix the lint",
      });

      expect(result).toBe(reply);
      expect(actions.send).toHaveBeenCalledWith({
        ref: { environmentId, threadId: thread.id },
        text: "Fix the lint too",
        mode,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
    },
  );

  it("reports an unknown handle and a missing open thread without acting", async () => {
    const { tools, actions } = harness(shell("cart"), { open: false });

    expect(
      await tools[VOICE_AGENT_TOOL_NAMES.sendToThread]({ thread: "t9", prompt: "Go", when: "now" }),
    ).toBe("There is no thread t9. Use a handle from the latest snapshot.");
    expect(await tools[VOICE_AGENT_TOOL_NAMES.sendToThread]({ prompt: "Go", when: "now" })).toBe(
      "No thread is open in the app. Pass thread with the handle of the one you mean.",
    );
    expect(actions.send).not.toHaveBeenCalled();
  });
});

describe("t3_answer_request", () => {
  const waiting = () =>
    harness(shell("stripe", workingFields("stripe", T0 - 60_000)), {
      read: approvalProjection("pnpm db:migrate"),
    });

  it.each([
    [
      "approve_once",
      "accept",
      'Approved once the request to run a command: "pnpm db:migrate". Codex in t1 carries on.',
    ],
    [
      "decline",
      "decline",
      'Declined the request to run a command: "pnpm db:migrate". Codex in t1 gets told no.',
    ],
  ] as const)("answers %s with %s", async (decision, sent, reply) => {
    const { tools, actions } = waiting();

    expect(await tools[VOICE_AGENT_TOOL_NAMES.answerRequest]({ decision })).toBe(reply);
    expect(actions.respondToApproval).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: ThreadId.make("stripe") }),
      RuntimeRequestId.make("approval-request"),
      sent,
    );
  });

  it.each(["approve_always", "acceptForSession", "accept"])(
    "refuses the broader decision %s",
    async (decision) => {
      const { tools, actions } = waiting();

      expect(await tools[VOICE_AGENT_TOOL_NAMES.answerRequest]({ decision })).toBe(
        "By voice you can only approve once or decline. For anything broader the user has to answer in the app.",
      );
      expect(actions.respondToApproval).not.toHaveBeenCalled();
    },
  );

  it("asks for a decision and says what the approval wants", async () => {
    const { tools } = waiting();

    expect(await tools[VOICE_AGENT_TOOL_NAMES.answerRequest]({})).toBe(
      't1 waits for approval to run a command: "pnpm db:migrate". Pass decision: approve_once or decline.',
    );
  });

  it("answers only the approval the user heard about, once they speak after hearing it", async () => {
    const { tools, actions, heard } = waiting();
    // The described request was answered elsewhere and the agent asked for another.
    actions.readThread.mockResolvedValue(approvalProjection("git push --force", "approval-b"));
    const approve = () => tools[VOICE_AGENT_TOOL_NAMES.answerRequest]({ decision: "approve_once" });

    expect(await approve()).toBe(
      't1 waits for approval to run a command: "git push --force", which the user has not heard about. Ask them about it, then call again.',
    );
    // The refusal told the agent, not the user: a retry without their word is refused too.
    expect(await approve()).toMatch(/^The user has not spoken since this request/);
    expect(actions.respondToApproval).not.toHaveBeenCalled();

    heard.userSpoke();
    expect(await approve()).toBe(
      'Approved once the request to run a command: "git push --force". Codex in t1 carries on.',
    );
    expect(actions.respondToApproval).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: ThreadId.make("stripe") }),
      RuntimeRequestId.make("approval-b"),
      "accept",
    );
  });

  it("answers a hidden subagent's approval on the subagent", async () => {
    const parent: EnvironmentThreadShell = {
      ...shell("parent", workingFields("parent", T0 - 60_000)),
      pendingSubagentRequest: "approval",
    };
    const child = shell("child", approvalFields("child", T0));
    const { tools, actions } = harness(parent, { children: [child] });
    actions.readThread.mockImplementation(async (ref) =>
      ref.threadId === child.id ? approvalProjection("pnpm db:migrate") : projection(),
    );

    expect(await tools[VOICE_AGENT_TOOL_NAMES.answerRequest]({ decision: "approve_once" })).toBe(
      'Approved once the request to run a command: "pnpm db:migrate". t1\'s subagent "child" carries on.',
    );
    expect(actions.respondToApproval).toHaveBeenCalledWith(
      { environmentId, threadId: child.id },
      RuntimeRequestId.make("approval-request"),
      "accept",
    );
  });

  it.each([
    [
      {},
      { answer: "MySQL" },
      '"MySQL" is not an option for "Which database should it use?". Options: "Postgres", "SQLite".',
      null,
    ],
    [
      {},
      { answers: ["Postgres", "SQLite"] },
      '"Which database should it use?" takes one answer. Options: "Postgres", "SQLite".',
      null,
    ],
    [{}, { answer: "postgres" }, "Answered. Codex in t1 carries on.", { database: "postgres" }],
    [
      { multiSelect: true },
      { answers: ["Postgres", "SQLite"] },
      "Answered. Codex in t1 carries on.",
      { database: ["postgres", "SQLite"] },
    ],
    [
      { multiSelect: true },
      { answer: "Postgres, SQLite" },
      "Answered. Codex in t1 carries on.",
      { database: ["postgres", "SQLite"] },
    ],
  ] as const)(
    "answers a question %j given %j with the options it offers",
    async (question, parameters, reply, answers) => {
      const { tools, actions } = harness(shell("db", workingFields("db", T0 - 60_000)), {
        read: questionProjection(question),
      });

      expect(await tools[VOICE_AGENT_TOOL_NAMES.answerRequest](parameters)).toBe(reply);
      if (answers === null) {
        expect(actions.respondToUserInput).not.toHaveBeenCalled();
      } else {
        expect(actions.respondToUserInput).toHaveBeenCalledWith(
          expect.objectContaining({ threadId: ThreadId.make("db") }),
          RuntimeRequestId.make("question-request"),
          answers,
        );
      }
    },
  );

  it("answers a question only once the user speaks after the agent heard it", async () => {
    const { tools, actions, heard } = harness(shell("db", workingFields("db", T0 - 60_000)), {
      read: questionProjection(),
      heard: false,
    });
    const answer = () => tools[VOICE_AGENT_TOOL_NAMES.answerRequest]({ answer: "Postgres" });

    expect(await answer()).toMatch(/which the user has not heard\. Ask them/);
    expect(await answer()).toMatch(/^The user has not spoken since this request/);
    expect(actions.respondToUserInput).not.toHaveBeenCalled();

    heard.userSpoke();
    expect(await answer()).toBe("Answered. Codex in t1 carries on.");
  });
});
