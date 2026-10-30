import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import { selectVoiceEnvironment } from "@t3tools/client-runtime/voice/host";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type AuthSessionState,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/session", () => {
  // One family for this app's session atoms and the command permissions that read them.
  let sessionStateAtom: ((id: EnvironmentId) => Atom.Atom<unknown>) | undefined;
  return {
    createEnvironmentSessionAtoms: () => ({
      sessionStateAtom: (sessionStateAtom ??= Atom.family((_id: EnvironmentId) =>
        Atom.make(AsyncResult.initial<AuthSessionState, Error>()).pipe(Atom.keepAlive),
      )),
    }),
  };
});
vi.mock("./presentation", () => ({
  environmentPresentations: {
    presentationsAtom: Atom.make(new Map()).pipe(Atom.keepAlive),
  },
}));

import { environmentPresentations } from "./presentation";
import { environmentSession } from "./session";
import { voiceCallBlockerAtom, voiceCallCandidatesAtom } from "./voice";

interface EnvironmentRow {
  readonly label: string;
  readonly key: boolean;
  readonly grant: "operate" | "read" | "cold";
}

const writable = <A>(atom: Atom.Atom<A>) => atom as unknown as Atom.Writable<A>;

function setUp(rows: ReadonlyArray<EnvironmentRow>) {
  const registry = AtomRegistry.make();
  const presentations = new Map(
    rows.map((row) => [
      EnvironmentId.make(row.label),
      {
        entry: { target: { label: row.label } },
        connection: { phase: "connected" },
        serverConfig: { settings: { voiceAgent: { elevenLabsApiKey: row.key ? "****" : "" } } },
      } as unknown as EnvironmentPresentation,
    ]),
  );
  registry.set(writable(environmentPresentations.presentationsAtom), presentations);
  for (const row of rows) {
    if (row.grant === "cold") continue;
    registry.set(
      writable(environmentSession.sessionStateAtom(EnvironmentId.make(row.label))),
      AsyncResult.success({
        authenticated: true,
        scopes: row.grant === "operate" ? [AuthOrchestrationOperateScope] : [],
      } as unknown as AuthSessionState),
    );
  }
  return registry;
}

it.each<{
  readonly name: string;
  readonly rows: ReadonlyArray<EnvironmentRow>;
  readonly blocker: string | null;
  readonly calls: string | null;
}>([
  {
    name: "no connected environment",
    rows: [],
    blocker: "Connect to an environment to call T3Bud.",
    calls: null,
  },
  {
    name: "no environment holds a key",
    rows: [{ label: "desk", key: false, grant: "operate" }],
    blocker: "Add an ElevenLabs API key in Settings › Voice.",
    calls: null,
  },
  {
    name: "the keyed environment grants read only",
    rows: [{ label: "desk", key: true, grant: "read" }],
    blocker: "This session can't start calls on desk.",
    calls: "desk",
  },
  {
    name: "its session has not loaded yet",
    rows: [{ label: "desk", key: true, grant: "cold" }],
    blocker: null,
    calls: "desk",
  },
  {
    name: "a read-only keyed environment comes first",
    rows: [
      { label: "desk", key: true, grant: "read" },
      { label: "devbox", key: true, grant: "operate" },
    ],
    blocker: null,
    calls: "devbox",
  },
])("when $name, blocks with $blocker and calls through $calls", ({ rows, blocker, calls }) => {
  const registry = setUp(rows);
  expect(registry.get(voiceCallBlockerAtom)).toBe(blocker);
  expect(selectVoiceEnvironment(registry.get(voiceCallCandidatesAtom))).toBe(
    calls === null ? null : EnvironmentId.make(calls),
  );
});
