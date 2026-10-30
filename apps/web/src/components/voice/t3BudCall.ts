import { useAtomValue } from "@effect/atom-react";
import type { VoiceSession } from "@t3tools/client-runtime/voice/session";
import type { ClientSettings, T3BudAnimal } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { registerCommands } from "../../shortcuts/dispatcher";
import { voiceCallReadinessAtom } from "../../state/voice";

// The palette and the shortcut reach the call through here; the session loads with T3Bud.
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

export const selectT3BudEnabled = (settings: ClientSettings) => settings.t3BudEnabled;
export const selectT3BudSpeaks = (settings: ClientSettings) => settings.t3BudSpeaks;
export const selectT3BudAnimal = (settings: ClientSettings) => settings.t3BudAnimal;

const ASSET_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
/** An animal's 3D head (`glb`) or its flat icon on the night disc (`png`). */
export const t3BudAssetUrl = (animal: T3BudAnimal, kind: "glb" | "png") =>
  `${ASSET_BASE}/t3bud/${animal}.${kind}`;

/**
 * Starts a call, or ends the one that is on. Nothing starts while no environment can take a
 * call; T3Bud's card says why. A press before T3Bud loads starts it once it does.
 */
export function toggleT3BudCall(): void {
  if (session === null) {
    startWhenLoaded = true;
    return;
  }
  if (isCallActive()) void session.end();
  else if (appAtomRegistry.get(voiceCallReadinessAtom) === "ready") void session.start();
}

export function attachT3BudSession(next: VoiceSession): () => void {
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

/** The call shortcut, live while T3Bud is shown. */
export function installT3BudShortcut(): () => void {
  const dispose = registerCommands({
    "voice.toggleCall": (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleT3BudCall();
    },
  });
  return () => {
    dispose();
    startWhenLoaded = false;
  };
}

export function useT3BudCallActive(): boolean {
  return useSyncExternalStore(subscribe, isCallActive, () => false);
}

const T3BUD_HIDDEN_ATOM = Atom.make(false).pipe(Atom.withLabel("web-t3bud-hidden"));
const t3BudCallReadyAtom = Atom.make((get) => get(voiceCallReadinessAtom) === "ready").pipe(
  Atom.withLabel("web-t3bud-call-ready"),
);

/** Whether a call can start. Reads the permissions only while T3Bud is shown. */
export function useT3BudCallReady(shown: boolean): boolean {
  return useAtomValue(shown ? t3BudCallReadyAtom : T3BUD_HIDDEN_ATOM);
}
