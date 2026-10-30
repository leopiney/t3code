import {
  VOICE_AGENT_TOOL_NAMES,
  type RuntimeRequestId,
  type VoiceAgentToolName,
} from "@t3tools/contracts";

import { scopedProjectKey, scopedThreadKey } from "../environment/scoped.ts";
import type { EnvironmentProject } from "../state/models.ts";
import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
} from "../state/pendingUserInput.ts";
import {
  derivePendingThreadRequests,
  type PendingThreadRequests,
  type ThreadUserInputQuestion,
} from "../state/threadRequests.ts";
import {
  clip,
  quoted,
  SUBAGENT_OUT_OF_REACH,
  voiceApprovalDetail,
  voicePendingAnswer,
  voiceProjectLabels,
  voiceQuestionDetail,
  voiceReadAnswer,
  voiceRequestTarget,
  VOICE_READ_FOCUSES,
  type VoiceHandles,
  type VoiceReadFocus,
} from "./context.ts";
import type {
  VoiceActions,
  VoiceChildRequests,
  VoiceDelivery,
  VoiceFeedEntry,
  VoiceThreadRow,
  VoiceToolHandler,
} from "./types.ts";

/**
 * The requests the agent was given to say or read this call, in order with the user's
 * transcripts. A voice answer counts only once the user spoke after the agent heard of the
 * request, so a yes never lands on a request nobody told them about.
 */
export class VoiceHeardRequests {
  private readonly heard = new Map<RuntimeRequestId, { readonly first: number; last: number }>();
  private sequence = 0;
  private userSpokeAt = 0;

  /** The agent got the request to say or read: a spoken update, or a tool result. */
  mark(requestId: RuntimeRequestId): void {
    this.sequence += 1;
    const heard = this.heard.get(requestId);
    if (heard === undefined) {
      this.heard.set(requestId, { first: this.sequence, last: this.sequence });
    } else {
      heard.last = this.sequence;
    }
  }

  /** A user transcript arrived. */
  userSpoke(): void {
    this.sequence += 1;
    this.userSpokeAt = this.sequence;
  }

  has(requestId: RuntimeRequestId): boolean {
    return this.heard.has(requestId);
  }

  /** The user spoke after the agent first heard of the request. */
  userSpokeSince(requestId: RuntimeRequestId): boolean {
    const heard = this.heard.get(requestId);
    return heard !== undefined && this.userSpokeAt > heard.first;
  }

  /** The pending request heard last, else the first one. */
  pick<Request extends { readonly requestId: RuntimeRequestId }>(
    pending: ReadonlyArray<Request>,
  ): Request | undefined {
    let picked: Request | undefined;
    let pickedAt = 0;
    for (const request of pending) {
      const at = this.heard.get(request.requestId)?.last ?? 0;
      if (at > pickedAt) {
        picked = request;
        pickedAt = at;
      }
    }
    return picked ?? pending[0];
  }
}

export interface VoiceToolContext {
  readonly rows: () => ReadonlyMap<string, VoiceThreadRow>;
  readonly projects: () => ReadonlyArray<EnvironmentProject>;
  readonly handles: VoiceHandles;
  readonly openThreadKey: () => string | null;
  readonly actions: VoiceActions;
  readonly childRequests: VoiceChildRequests;
  readonly heard: VoiceHeardRequests;
  /** The user spoke after the app's last update, so what the agent does now answers them. */
  readonly userSpokeLast: () => boolean;
  /** Takes the next waiting announcement, or says none is waiting. */
  readonly nextUpdate: () => string;
  readonly record: (entry: Omit<VoiceFeedEntry, "id" | "at">) => void;
  readonly environmentLabel?: Parameters<typeof voiceProjectLabels>[1];
  readonly now: () => number;
}

const ASK_FIRST =
  "The user has not spoken since the app's last update, so this is not their request yet. Ask them first, then call again once they agree.";
const ASK_ABOUT_REQUEST =
  "The user has not spoken since this request or the app's last update reached you, so this is not their answer yet. Ask them first, then call again once they answer.";

/** Approving or answering by voice needs the user's word after the agent heard of the request. */
function userAnswered(context: VoiceToolContext, requestId: RuntimeRequestId): boolean {
  return context.userSpokeLast() && context.heard.userSpokeSince(requestId);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === "" ? "it failed for an unknown reason" : quoted(message, 300);
}

type Resolved<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reply: string };

function resolveThread(
  context: VoiceToolContext,
  value: unknown,
): Resolved<{ readonly row: VoiceThreadRow; readonly handle: string }> {
  const rows = context.rows();
  const wanted = text(value);
  const found = (row: VoiceThreadRow) =>
    ({ ok: true, value: { row, handle: context.handles.of(row.key) } }) as const;
  if (wanted === "") {
    const openKey = context.openThreadKey();
    const open = openKey === null ? undefined : rows.get(openKey);
    return open === undefined
      ? {
          ok: false,
          reply: "No thread is open in the app. Pass thread with the handle of the one you mean.",
        }
      : found(open);
  }
  if (/^t\d+$/i.test(wanted)) {
    const key = context.handles.keyOf(wanted);
    const row = key === null ? undefined : rows.get(key);
    if (row !== undefined) return found(row);
    return {
      ok: false,
      reply:
        key === null
          ? `There is no thread ${wanted}. Use a handle from the latest snapshot.`
          : `${wanted} is gone: it was archived or deleted.`,
    };
  }
  const matches = [...rows.values()].filter(
    (row) => row.title.toLowerCase() === wanted.toLowerCase(),
  );
  if (matches.length === 1) return found(matches[0]!);
  return {
    ok: false,
    reply:
      matches.length === 0
        ? `No thread is called ${quoted(wanted, 80)}. Use a handle from the latest snapshot.`
        : `Several threads are called ${quoted(wanted, 80)}: ${matches
            .map((row) => `${context.handles.of(row.key)} in ${quoted(row.project, 80)}`)
            .join(", ")}. Pass the handle.`,
  };
}

function resolveProject(context: VoiceToolContext, value: unknown): Resolved<EnvironmentProject> {
  const projects = context.projects();
  const labels = voiceProjectLabels(projects, context.environmentLabel);
  const named = projects.map((project) => ({
    project,
    label:
      labels.get(
        scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }),
      ) ?? project.title,
  }));
  const wanted = text(value).toLowerCase();
  if (wanted === "")
    return { ok: false, reply: "Pass project: the name of the project to start in." };
  const exact = named.filter(
    ({ project, label }) =>
      label.toLowerCase() === wanted || project.title.trim().toLowerCase() === wanted,
  );
  const candidates =
    exact.length > 0 ? exact : named.filter(({ label }) => label.toLowerCase().includes(wanted));
  if (candidates.length === 1) return { ok: true, value: candidates[0]!.project };
  const names = (candidates.length > 0 ? candidates : named)
    .map(({ label }) => quoted(label, 80))
    .join(", ");
  return {
    ok: false,
    reply:
      candidates.length === 0
        ? `No project matches ${quoted(text(value), 80)}. Projects: ${names || "none"}.`
        : `Several projects match ${quoted(text(value), 80)}: ${names}. Ask the user which one.`,
  };
}

type QuestionOption = ThreadUserInputQuestion["options"][number];

function matchOption(question: ThreadUserInputQuestion, answer: string) {
  const wanted = answer.trim().toLowerCase();
  return question.options.find(
    (option) =>
      option.label.trim().toLowerCase() === wanted || option.value?.trim().toLowerCase() === wanted,
  );
}

function matchAll(
  question: ThreadUserInputQuestion,
  values: ReadonlyArray<string>,
): QuestionOption[] | null {
  const options = values.map((value) => matchOption(question, value));
  return options.every((option) => option !== undefined) ? [...new Set(options)] : null;
}

/** The options the values name, or null when one names none. A multi-select answer can list several in one value. */
function matchOptions(
  question: ThreadUserInputQuestion,
  values: ReadonlyArray<string>,
): QuestionOption[] | null {
  const whole = matchAll(question, values);
  if (whole !== null || !question.multiSelect) return whole;
  return matchAll(
    question,
    values.flatMap((value) =>
      value
        .split(/,|&|\band\b/i)
        .map((piece) => piece.trim())
        .filter((piece) => piece !== ""),
    ),
  );
}

function answerList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  if (Array.isArray(value)) return value.flatMap(answerList);
  return [];
}

function optionLabels(question: ThreadUserInputQuestion): string {
  return question.options.map((option) => quoted(option.label, 60)).join(", ");
}

/** The agent's answers, by question order or by question id or text, as composer drafts. */
function answerDrafts(
  questions: ReadonlyArray<ThreadUserInputQuestion>,
  parameters: Record<string, unknown>,
): Resolved<Record<string, PendingUserInputDraftAnswer>> {
  const given = parameters.answers;
  const single = answerList(parameters.answer);
  if (Array.isArray(given) && questions.length > 1 && given.length > questions.length) {
    return {
      ok: false,
      reply: `It asks ${questions.length} questions but got ${given.length} answers. Pass one per question, in order.`,
    };
  }
  const byQuestion = questions.map((question, index) => {
    // The only question takes every entry, so a multi-select answer can list several.
    if (Array.isArray(given)) return answerList(questions.length === 1 ? given : given[index]);
    if (typeof given === "object" && given !== null) {
      const entries = Object.entries(given);
      const entry = entries.find(
        ([key]) =>
          key === question.id ||
          key.trim().toLowerCase() === question.question.toLowerCase() ||
          key.trim().toLowerCase() === question.header.toLowerCase(),
      );
      return answerList(entry?.[1]);
    }
    return questions.length === 1 ? single : [];
  });
  if (questions.length > 1 && given === undefined && single.length > 0) {
    return {
      ok: false,
      reply: `It asks ${questions.length} questions. Pass answers as a list in question order.`,
    };
  }
  const drafts: Record<string, PendingUserInputDraftAnswer> = {};
  for (const [index, question] of questions.entries()) {
    const values = byQuestion[index] ?? [];
    if (values.length === 0) continue;
    const options = matchOptions(question, values);
    if (options !== null) {
      if (!question.multiSelect && options.length > 1) {
        return {
          ok: false,
          reply: `${quoted(question.question, 200)} takes one answer. Options: ${optionLabels(question)}.`,
        };
      }
      drafts[question.id] = {
        selectedOptionValues: options.map((option) => option.value ?? option.label),
      };
      continue;
    }
    if (question.allowCustomAnswer === false) {
      return {
        ok: false,
        reply: `${quoted(values.join(", "), 120)} is not an option for ${quoted(question.question, 200)}. Options: ${optionLabels(question)}.`,
      };
    }
    drafts[question.id] = { customAnswer: values.join(", ") };
  }
  return { ok: true, value: drafts };
}

const SEND_RESULTS: Record<VoiceDelivery, (handle: string, provider: string) => string> = {
  started: (handle, provider) => `Sent to ${handle}. ${provider} started on it.`,
  steered: (handle, provider) =>
    `Steered into ${handle}'s running turn. ${provider} takes it into account now.`,
  queued: (handle, provider) =>
    `Queued for ${handle}. ${provider} gets it when the current turn ends.`,
};

const SEND_FEED: Record<VoiceDelivery, string> = {
  started: "sent",
  steered: "steered",
  queued: "queued",
};

/** The agent's client tools, keyed by `VOICE_AGENT_TOOL_NAMES`. Each answers in plain text. */
export function createVoiceTools(
  context: VoiceToolContext,
): Record<VoiceAgentToolName, VoiceToolHandler> {
  return {
    [VOICE_AGENT_TOOL_NAMES.sendToThread]: async (parameters) => {
      const prompt = text(parameters.prompt);
      if (prompt === "") return "No prompt given: put what the agent should do in prompt.";
      const target = resolveThread(context, parameters.thread);
      if (!target.ok) return target.reply;
      const { row, handle } = target.value;
      if (!context.userSpokeLast()) return ASK_FIRST;
      let delivery: VoiceDelivery;
      try {
        delivery = await context.actions.send({
          ref: row.ref,
          text: prompt,
          mode: !row.running ? "auto" : parameters.when === "now" ? "steer" : "queue",
          runtimeMode: row.shell.runtimeMode,
          interactionMode: row.shell.interactionMode,
        });
      } catch (error) {
        return `That did not go through: ${failure(error)}. Tell the user it failed.`;
      }
      const summary = text(parameters.summary) || clip(prompt, 60);
      context.record({
        tone: "action",
        title: row.title,
        text: `${summary} · ${SEND_FEED[delivery]}`,
      });
      return SEND_RESULTS[delivery](handle, row.provider);
    },

    [VOICE_AGENT_TOOL_NAMES.stopThread]: async (parameters) => {
      const target = resolveThread(context, parameters.thread);
      if (!target.ok) return target.reply;
      const { row, handle } = target.value;
      if (!row.running) return `Nothing is running in ${handle}.`;
      try {
        await context.actions.stop(row.ref);
      } catch (error) {
        return `Could not stop ${handle}: ${failure(error)}.`;
      }
      context.record({ tone: "action", title: row.title, text: "stopped" });
      return `Stopped ${handle}.`;
    },

    [VOICE_AGENT_TOOL_NAMES.answerRequest]: async (parameters) => {
      const target = resolveThread(context, parameters.thread);
      if (!target.ok) return target.reply;
      const { row, handle } = target.value;
      const where = voiceRequestTarget(row, context.childRequests);
      const label =
        where.subagent === null ? handle : `${handle}'s subagent ${quoted(where.subagent, 80)}`;
      const answerer = where.subagent === null ? `${row.provider} in ${handle}` : label;
      let pending: PendingThreadRequests;
      try {
        pending = derivePendingThreadRequests(await context.actions.readThread(where.ref));
      } catch (error) {
        return `Could not read ${handle}: ${failure(error)}.`;
      }
      const decision = text(parameters.decision);
      const approval = context.heard.pick(pending.approvals);
      const question = context.heard.pick(pending.userInputs);
      if (approval !== undefined && (decision !== "" || question === undefined)) {
        const detail = voiceApprovalDetail(approval);
        const what = detail === null ? "" : ` ${detail}`;
        if (decision === "") {
          context.heard.mark(approval.requestId);
          return `${label} waits for approval${what}. Pass decision: approve_once or decline.`;
        }
        if (decision !== "approve_once" && decision !== "decline") {
          return "By voice you can only approve once or decline. For anything broader the user has to answer in the app.";
        }
        if (approval.responseCapability !== "live") {
          return `That approval can't be answered any more: ${label} stopped waiting for it.`;
        }
        if (!context.heard.has(approval.requestId)) {
          context.heard.mark(approval.requestId);
          return `${label} waits for approval${what}, which the user has not heard about. Ask them about it, then call again.`;
        }
        if (decision === "approve_once" && !userAnswered(context, approval.requestId)) {
          return ASK_ABOUT_REQUEST;
        }
        try {
          await context.actions.respondToApproval(
            where.ref,
            approval.requestId,
            decision === "approve_once" ? "accept" : "decline",
          );
        } catch (error) {
          return `That did not go through: ${failure(error)}.`;
        }
        const approved = decision === "approve_once";
        context.record({
          tone: "action",
          title: row.title,
          text: approved ? "approved once" : "declined",
        });
        return approved
          ? `Approved once the request${what}. ${answerer} carries on.`
          : `Declined the request${what}. ${answerer} gets told no.`;
      }
      if (question !== undefined) {
        if (question.responseCapability === "not_resumable") {
          return `That question can't be answered any more: ${label} stopped waiting for it.`;
        }
        if (!context.heard.has(question.requestId)) {
          context.heard.mark(question.requestId);
          return `${label} asks ${voiceQuestionDetail(question) ?? "a question"}, which the user has not heard. Ask them, then call again with their answer.`;
        }
        if (!userAnswered(context, question.requestId)) return ASK_ABOUT_REQUEST;
        const drafts = answerDrafts(question.questions, parameters);
        if (!drafts.ok) return drafts.reply;
        const answers = buildPendingUserInputAnswers(question.questions, drafts.value);
        if (answers === null) {
          const missing = question.questions
            .filter((entry) => drafts.value[entry.id] === undefined)
            .map((entry) => quoted(entry.question, 120))
            .join(", ");
          return `Missing an answer for ${missing}. Pass answer, or answers in question order.`;
        }
        try {
          await context.actions.respondToUserInput(where.ref, question.requestId, answers);
        } catch (error) {
          return `That did not go through: ${failure(error)}.`;
        }
        context.record({ tone: "action", title: row.title, text: "answered" });
        return `Answered. ${answerer} carries on.`;
      }
      if (row.shell.pendingSubagentRequest === "approval" && where.subagent === null) {
        return `${handle}: ${SUBAGENT_OUT_OF_REACH}`;
      }
      return `Nothing is waiting on the user in ${handle}.`;
    },

    [VOICE_AGENT_TOOL_NAMES.readThread]: async (parameters) => {
      const target = resolveThread(context, parameters.thread);
      if (!target.ok) return target.reply;
      const { row, handle } = target.value;
      const focus: VoiceReadFocus =
        VOICE_READ_FOCUSES.find((candidate) => candidate === parameters.focus) ?? "overview";
      try {
        if (focus !== "pending_request") {
          const projection = await context.actions.readThread(row.ref);
          return voiceReadAnswer(focus, row, handle, projection, context.now());
        }
        const where = voiceRequestTarget(row, context.childRequests);
        const pending = derivePendingThreadRequests(await context.actions.readThread(where.ref));
        const approval = context.heard.pick(pending.approvals);
        const question = context.heard.pick(pending.userInputs);
        if (approval !== undefined) context.heard.mark(approval.requestId);
        if (question !== undefined) context.heard.mark(question.requestId);
        return voicePendingAnswer(row, handle, context.now(), {
          approval,
          question,
          subagent: where.subagent,
        });
      } catch (error) {
        return `Could not read ${handle}: ${failure(error)}.`;
      }
    },

    [VOICE_AGENT_TOOL_NAMES.nextUpdate]: async () => context.nextUpdate(),

    [VOICE_AGENT_TOOL_NAMES.openThread]: async (parameters) => {
      if (text(parameters.thread) === "") return "Pass thread: the handle of the thread to open.";
      const target = resolveThread(context, parameters.thread);
      if (!target.ok) return target.reply;
      const { row, handle } = target.value;
      try {
        await context.actions.openThread(row.ref);
      } catch (error) {
        return `Could not open ${handle}: ${failure(error)}.`;
      }
      return `Opened ${handle} in the app.`;
    },

    [VOICE_AGENT_TOOL_NAMES.startThread]: async (parameters) => {
      const prompt = text(parameters.prompt);
      if (prompt === "") return "No prompt given: put what the new thread should do in prompt.";
      const target = resolveProject(context, parameters.project);
      if (!target.ok) return target.reply;
      if (!context.userSpokeLast()) return ASK_FIRST;
      const project = target.value;
      const summary = text(parameters.summary) || clip(prompt, 60);
      let handle: string;
      try {
        const ref = await context.actions.startThread({ project, prompt, summary });
        handle = context.handles.of(scopedThreadKey(ref));
      } catch (error) {
        return `Could not start the thread: ${failure(error)}.`;
      }
      context.record({ tone: "action", title: summary, text: `started in ${project.title}` });
      return `Started ${handle} in ${quoted(project.title, 60)}. It is working on it.`;
    },
  };
}
