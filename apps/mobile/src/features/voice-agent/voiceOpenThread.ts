import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { parseActiveThreadPath } from "../keyboard/hardwareKeyboardCommands";

/** The thread on screen, which WolfBud's tools act on when the agent names none. */
export const voiceOpenThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:voice-agent-open-thread"),
);

/** Called with the workspace pathname on every root navigation state change. */
export function setVoiceAgentPathname(pathname: string): void {
  const next = parseActiveThreadPath(pathname);
  const current = appAtomRegistry.get(voiceOpenThreadAtom);
  if (next?.environmentId === current?.environmentId && next?.threadId === current?.threadId) {
    return;
  }
  appAtomRegistry.set(voiceOpenThreadAtom, next);
}
