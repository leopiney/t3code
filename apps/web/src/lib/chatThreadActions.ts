import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ScopedProjectRef,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import type { ComposerThreadDraftState, DraftThreadEnvMode } from "../composerDraftStore";
import {
  providerInstanceEntriesFor,
  resolveProjectDefaultProviderModelSelection,
} from "../providerInstances";

type ComposerModelSelectionState = Pick<
  ComposerThreadDraftState,
  "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
>;

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveNewThreadModelSelectionOverride(input: {
  readonly projectDefaultSelection: ModelSelection | null;
  readonly carrySelection: ModelSelection | null;
  readonly carrySourceDraftId: string | null;
  readonly destinationDraftId: string;
}): ModelSelection | null {
  return (
    input.projectDefaultSelection ??
    (input.carrySourceDraftId === input.destinationDraftId ? null : input.carrySelection)
  );
}

/**
 * The model New thread starts on: the project's default, else the composer's carried or sticky
 * pick when it can run, else the first ready provider. Usage limits move only the defaults to
 * the fallback model. `override` is what New thread writes over the draft's own pick.
 */
export function resolveNewThreadModelDefaults(input: {
  readonly projectDefault: ModelSelection | null;
  readonly composerPick: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings;
  readonly projectId: ProjectId;
  readonly now: number;
}) {
  const { projectDefault, composerPick, providers, settings, projectId } = input;
  const firstReady = () =>
    resolveProjectDefaultProviderModelSelection(providers, settings, projectId);
  const resolved = resolveNewThreadModelSelection({
    defaultSelection: projectDefault ?? (composerPick === null ? firstReady() : null),
    fallbackSelection: settings.fallbackModelSelection ?? null,
    providers,
    settings,
    projectId,
    now: input.now,
  });
  const override = resolved.fallback ? resolved.selection : projectDefault;
  const pickRuns =
    composerPick !== null &&
    providerInstanceEntriesFor(providers, settings, projectId).some(
      (entry) => entry.instanceId === composerPick.instanceId && entry.enabled && entry.isAvailable,
    );
  return {
    override,
    selection: override ?? (pickRuns ? composerPick : null) ?? resolved.selection ?? firstReady(),
  };
}

export function hasExplicitComposerModelSelection(
  draft: ComposerModelSelectionState | null | undefined,
): boolean {
  const activeProvider = draft?.activeProvider;
  return (
    draft?.modelSelectionExplicit === true &&
    activeProvider !== null &&
    activeProvider !== undefined &&
    draft.modelSelectionByProvider[activeProvider] !== undefined
  );
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef);
  return true;
}
