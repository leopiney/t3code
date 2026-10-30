import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The voice agent's client tools. The server's agent definition and the client handlers both key on these. */
export const VOICE_AGENT_TOOL_NAMES = {
  sendToThread: "t3_send_to_thread",
  stopThread: "t3_stop_thread",
  answerRequest: "t3_answer_request",
  readThread: "t3_read_thread",
  nextUpdate: "t3_next_update",
  openThread: "t3_open_thread",
  startThread: "t3_start_thread",
} as const;
export type VoiceAgentToolName =
  (typeof VOICE_AGENT_TOOL_NAMES)[keyof typeof VOICE_AGENT_TOOL_NAMES];

/** What T3Bud says aloud without being asked: everything, only what needs the user, or nothing. */
export const VoiceAgentSpeakMode = Schema.Literals(["all", "needs", "none"]);
export type VoiceAgentSpeakMode = typeof VoiceAgentSpeakMode.Type;

/** The animal T3Bud appears as. The agent plays the same one. */
export const T3BudAnimal = Schema.Literals(["wolf", "frog", "capybara", "axolotl"]);
export type T3BudAnimal = typeof T3BudAnimal.Type;

export const VoiceCreateCallTokenResult = Schema.Struct({
  token: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
});
export type VoiceCreateCallTokenResult = typeof VoiceCreateCallTokenResult.Type;

export const VoiceSyncAgentResult = Schema.Struct({
  agentId: TrimmedNonEmptyString,
  agentName: TrimmedNonEmptyString,
});
export type VoiceSyncAgentResult = typeof VoiceSyncAgentResult.Type;

export class VoiceAgentError extends Schema.TaggedError<VoiceAgentError>()("VoiceAgentError", {
  reason: Schema.Literals(["notConfigured", "invalidKey", "elevenLabs", "network"]),
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}
