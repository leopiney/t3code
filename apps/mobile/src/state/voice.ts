import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";
import { environmentSession } from "./session";

export const voiceEnvironment = {
  createCallToken: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "voice call token",
    tag: WS_METHODS.voiceCreateCallToken,
  }),
  syncAgent: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "voice agent setup",
    tag: WS_METHODS.voiceSyncAgent,
  }),
};

/**
 * Connected environments as voice call candidates. Keep it mounted while a call can start:
 * a cold permission read is false.
 */
export const voiceCallCandidatesAtom = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom)].flatMap(([environmentId, presentation]) => {
    if (presentation.connection.phase !== "connected") return [];
    return [
      {
        environmentId,
        label: presentation.entry.target.label,
        // Mobile has no local environment to prefer.
        primary: false,
        hasKey: (presentation.serverConfig?.settings.voiceAgent.elevenLabsApiKey ?? "") !== "",
        canCall: get(voiceEnvironment.createCallToken.permissionAtom(environmentId)),
        sessionLoaded: AsyncResult.isSuccess(
          get(environmentSession.sessionStateAtom(environmentId)),
        ),
      },
    ];
  }),
).pipe(Atom.withLabel("mobile-voice-call-candidates"));

/** Why this device can't place a call, or null when it can or the sessions are still loading. */
export const voiceCallBlockerAtom = Atom.make((get): string | null => {
  const candidates = get(voiceCallCandidatesAtom);
  if (candidates.length === 0) return "Connect to an environment to call T3Bud.";
  const keyed = candidates.filter((candidate) => candidate.hasKey);
  const [first] = keyed;
  if (first === undefined) return "Add an ElevenLabs API key in Settings › Voice.";
  if (keyed.some((candidate) => candidate.canCall || !candidate.sessionLoaded)) return null;
  return keyed.length === 1
    ? `This session can't start calls on ${first.label}.`
    : "This session can't start calls on the environments with an ElevenLabs key.";
}).pipe(Atom.withLabel("mobile-voice-call-blocker"));
