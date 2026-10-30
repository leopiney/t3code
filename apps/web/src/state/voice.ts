import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentServerConfigsAtom } from "./server";
import { environmentSession } from "./session";

export const voiceEnvironment = {
  createCallToken: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:voice:create-call-token",
    tag: WS_METHODS.voiceCreateCallToken,
  }),
  syncAgent: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:voice:sync-agent",
    tag: WS_METHODS.voiceSyncAgent,
  }),
};

/**
 * The connected environments whose server keeps voice settings. Keep it mounted while calls can
 * start: an unmounted permission read is cold and reads as false.
 */
export const voiceCallCandidatesAtom = Atom.make((get) => {
  const primaryEnvironmentId = get(primaryEnvironmentIdAtom);
  const configs = get(environmentServerConfigsAtom);
  return get(environmentSummaries.connectedEnvironmentIdsAtom).flatMap((environmentId) => {
    const config = configs.get(environmentId);
    if (config?.environment.capabilities.voiceAgent !== true) return [];
    return [
      {
        environmentId,
        primary: environmentId === primaryEnvironmentId,
        // Clients see the redaction marker for a stored key and "" without one.
        hasKey: config.settings.voiceAgent.elevenLabsApiKey !== "",
        canCall: get(voiceEnvironment.createCallToken.permissionAtom(environmentId)),
        sessionLoaded: AsyncResult.isSuccess(
          get(environmentSession.sessionStateAtom(environmentId)),
        ),
      },
    ];
  });
}).pipe(Atom.withLabel("web-voice-call-candidates"));

export type VoiceCallReadiness = "ready" | "noKey" | "noAccess";

/** A session still loading counts as ready: the server checks access when the call starts. */
export const voiceCallReadinessAtom = Atom.make((get): VoiceCallReadiness => {
  const keyed = get(voiceCallCandidatesAtom).filter((candidate) => candidate.hasKey);
  if (keyed.length === 0) return "noKey";
  return keyed.some((candidate) => candidate.canCall || !candidate.sessionLoaded)
    ? "ready"
    : "noAccess";
}).pipe(Atom.withLabel("web-voice-call-readiness"));
