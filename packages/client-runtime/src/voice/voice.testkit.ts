import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  presentThreadShell,
  scopeProject,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "../state/models.ts";
import { v2Project, v2Projection, v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import type { VoiceClock, VoiceTransport, VoiceTransportStart } from "./types.ts";

export const environmentId = EnvironmentId.make("environment-local");
/** Epoch ms of `2026-06-20T00:00:00Z`, the fixtures' now. */
export const T0 = Date.parse("2026-06-20T00:00:00.000Z");

const iso = (ms: number) => DateTime.makeUnsafe(ms);

export function project(id: string, title: string): EnvironmentProject {
  return scopeProject(environmentId, { ...v2Project, id: ProjectId.make(id), title });
}

type ShellFields = Partial<OrchestrationV2ThreadShell>;

export function shell(id: string, fields: ShellFields = {}): EnvironmentThreadShell {
  const threadId = ThreadId.make(id);
  return presentThreadShell(environmentId, {
    ...v2ThreadShell,
    id: threadId,
    projectId: v2Project.id,
    title: id,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    ...fields,
  });
}

export const runId = (threadId: string) => RunId.make(`${threadId}-run`);

export function workingFields(threadId: string, startedAt: number): ShellFields {
  return {
    status: "running",
    latestRunId: runId(threadId),
    activeRunId: runId(threadId),
    latestRunStartedAt: iso(startedAt),
  };
}

export function finishedFields(threadId: string, completedAt: number): ShellFields {
  return {
    status: "completed",
    latestRunId: runId(threadId),
    activeRunId: null,
    latestRunStartedAt: iso(completedAt - 60_000),
    latestRunCompletedAt: iso(completedAt),
  };
}

export function approvalFields(threadId: string, askedAt: number): ShellFields {
  return {
    ...workingFields(threadId, askedAt - 60_000),
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make(`${threadId}-approval`),
      kind: "command",
      createdAt: iso(askedAt),
    },
  };
}

export function failedFields(threadId: string, completedAt: number, error: string): ShellFields {
  return {
    ...finishedFields(threadId, completedAt),
    status: "failed",
    lastError: error,
  };
}

export function itemBase(id: string, run: RunId | null = null) {
  return {
    id: TurnItemId.make(id),
    threadId: v2ThreadShell.id,
    runId: run,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: v2Projection.updatedAt,
  };
}

type Item<T extends OrchestrationV2TurnItem["type"]> = Extract<
  OrchestrationV2TurnItem,
  { type: T }
>;

export function commandItem(
  id: string,
  input: string,
  fields: Partial<Item<"command_execution">> = {},
): OrchestrationV2TurnItem {
  return { ...itemBase(id, null), type: "command_execution", input, ...fields };
}

export function fileChangeItem(
  id: string,
  fileName: string,
  fields: Partial<Item<"file_change">> = {},
): OrchestrationV2TurnItem {
  return { ...itemBase(id, null), type: "file_change", fileName, ...fields };
}

export function run(id: RunId, status: OrchestrationV2Run["status"], prompt: MessageId) {
  return {
    id,
    threadId: v2ThreadShell.id,
    ordinal: 1,
    providerInstanceId: v2ThreadShell.providerInstanceId,
    modelSelection: v2ThreadShell.modelSelection,
    providerThreadId: null,
    userMessageId: prompt,
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: v2Projection.updatedAt,
    startedAt: v2Projection.updatedAt,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2Run;
}

export function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  run: RunId | null = null,
): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(id),
    threadId: v2ThreadShell.id,
    runId: run,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: false,
    createdBy: role === "user" ? "user" : "agent",
    creationSource: "web",
    createdAt: v2Projection.updatedAt,
    updatedAt: v2Projection.updatedAt,
  };
}

export function projection(
  fields: Partial<OrchestrationV2ThreadProjection> = {},
): OrchestrationV2ThreadProjection {
  return { ...v2Projection, ...fields };
}

const requestNode = NodeId.make("request-node");

/** A projection waiting on one live command approval. */
export function approvalProjection(
  prompt: string,
  id = "approval-request",
): OrchestrationV2ThreadProjection {
  const requestId = RuntimeRequestId.make(id);
  return projection({
    runtimeRequests: [
      {
        id: requestId,
        nodeId: requestNode,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
        createdAt: v2Projection.updatedAt,
        resolvedAt: null,
      },
    ],
    turnItems: [
      {
        ...itemBase(`${id}-item`, null),
        type: "approval_request",
        requestId,
        requestKind: "command",
        prompt,
      },
    ],
  });
}

/** A projection waiting on one live question with options. */
export function questionProjection(
  fields: { readonly multiSelect?: boolean; readonly allowCustomAnswer?: boolean } = {},
): OrchestrationV2ThreadProjection {
  const requestId = RuntimeRequestId.make("question-request");
  return projection({
    runtimeRequests: [
      {
        id: requestId,
        nodeId: requestNode,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
        createdAt: v2Projection.updatedAt,
        resolvedAt: null,
      },
    ],
    turnItems: [
      {
        ...itemBase("question-item", null),
        type: "user_input_request",
        requestId,
        questions: [
          {
            id: "database",
            header: "Database",
            question: "Which database should it use?",
            allowCustomAnswer: fields.allowCustomAnswer ?? false,
            ...(fields.multiSelect === undefined ? {} : { multiSelect: fields.multiSelect }),
            options: [
              { label: "Postgres", value: "postgres", description: "The server one" },
              { label: "SQLite", description: "The file one" },
            ],
          },
        ],
      },
    ],
  });
}

/** A clock whose scheduled work runs only when the test advances it. */
export function createTestClock(start = T0) {
  let now = start;
  let sequence = 0;
  const tasks = new Map<number, { readonly at: number; readonly run: () => void }>();
  const clock: VoiceClock = {
    now: () => now,
    schedule: (delayMs, task) => {
      sequence += 1;
      const id = sequence;
      tasks.set(id, { at: now + Math.max(0, delayMs), run: task });
      return () => tasks.delete(id);
    },
  };
  const nextDue = (until: number) =>
    [...tasks]
      .filter(([, task]) => task.at <= until)
      .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
  return {
    clock,
    advance(ms: number) {
      const until = now + ms;
      for (let due = nextDue(until); due !== undefined; due = nextDue(until)) {
        tasks.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
  };
}

export type SentToAgent =
  | { readonly type: "context"; readonly text: string; readonly contextId: string | undefined }
  | { readonly type: "message"; readonly text: string };

/** A transport that records what the session sends; the test plays the agent's side. */
export function createTestTransport() {
  const sent: SentToAgent[] = [];
  let started: VoiceTransportStart | null = null;
  const transport: VoiceTransport = {
    start: async (options) => {
      started = options;
    },
    end: async () => {},
    sendContextualUpdate: (text, contextId) => {
      sent.push({ type: "context", text, contextId });
    },
    sendUserMessage: (text) => {
      sent.push({ type: "message", text });
    },
    sendUserActivity: () => {},
    setMicMuted: () => {},
    inputLevel: () => 0,
    outputLevel: () => 0,
  };
  return {
    transport,
    sent,
    started(): VoiceTransportStart {
      if (started === null) throw new Error("The transport was not started.");
      return started;
    },
  };
}
