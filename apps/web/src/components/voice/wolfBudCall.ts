import { useAtomValue } from "@effect/atom-react";
import type { VoiceSession } from "@t3tools/client-runtime/voice/session";
import type { ClientSettings } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { registerCommands } from "../../shortcuts/dispatcher";
import { voiceCallReadinessAtom } from "../../state/voice";

// The palette and the shortcut reach the call through here; the session loads with the wolf.
let session: VoiceSession | null = null;
let startWhenLoaded = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isCallActive(): boolean {
  const status = session?.getSnapshot().status;
  return status === "connecting" || status === "live";
}

export const selectWolfBudEnabled = (settings: ClientSettings) => settings.wolfBudEnabled;
export const selectWolfBudSpeaks = (settings: ClientSettings) => settings.wolfBudSpeaks;

/**
 * Starts a call, or ends the one that is on. Nothing starts while no environment can take a
 * call; the wolf's card says why. A press before the wolf loads starts it once it does.
 */
export function toggleWolfBudCall(): void {
  if (session === null) {
    startWhenLoaded = true;
    return;
  }
  if (isCallActive()) void session.end();
  else if (appAtomRegistry.get(voiceCallReadinessAtom) === "ready") void session.start();
}

export function attachWolfBudSession(next: VoiceSession): () => void {
  session = next;
  const unsubscribe = next.subscribe(notify);
  notify();
  if (startWhenLoaded) {
    startWhenLoaded = false;
    void next.start();
  }
  return () => {
    unsubscribe();
    if (session === next) session = null;
    notify();
  };
}

/** The call shortcut, live while WolfBud is shown. */
export function installWolfBudShortcut(): () => void {
  const dispose = registerCommands({
    "voice.toggleCall": (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleWolfBudCall();
    },
  });
  return () => {
    dispose();
    startWhenLoaded = false;
  };
}

export function useWolfBudCallActive(): boolean {
  return useSyncExternalStore(subscribe, isCallActive, () => false);
}

const WOLFBUD_HIDDEN_ATOM = Atom.make(false).pipe(Atom.withLabel("web-wolfbud-hidden"));
const wolfBudCallReadyAtom = Atom.make((get) => get(voiceCallReadinessAtom) === "ready").pipe(
  Atom.withLabel("web-wolfbud-call-ready"),
);

/** Whether a call can start. Reads the permissions only while WolfBud is shown. */
export function useWolfBudCallReady(shown: boolean): boolean {
  return useAtomValue(shown ? wolfBudCallReadyAtom : WOLFBUD_HIDDEN_ATOM);
}
