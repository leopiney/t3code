import type { ComposerHandleRef } from "../../composerHandleContext";
import type { BranchToolbarHandle } from "../BranchToolbar";
import type { ChatComposerHandle } from "./ChatComposer";
import type { ChatShortcutCommands } from "./useChatShortcuts";

const openControl =
  (composerRef: ComposerHandleRef, control: Parameters<ChatComposerHandle["openControl"]>[0]) =>
  ({ event }: { readonly event: KeyboardEvent }) => {
    if (!event.repeat) composerRef.current?.openControl(control);
  };

/** Held keys do not repeat a step. A model with nothing to step leaves the key alone. */
function stepEffort(composerRef: ComposerHandleRef, direction: 1 | -1) {
  return ({ event }: { readonly event: KeyboardEvent }) => {
    if (event.repeat) return;
    if (composerRef.current?.stepReasoningEffort(direction) !== true) return false;
  };
}

/** Chords that open or step the composer's controls and its branch toolbar. Held keys do not repeat them. */
export function composerShortcutCommands(
  composerRef: ComposerHandleRef,
  branchToolbarRef: { readonly current: BranchToolbarHandle | null },
): ChatShortcutCommands {
  return {
    "modelPicker.toggle": ({ event }) => {
      if (!event.repeat) composerRef.current?.toggleModelPicker();
    },
    "composer.increaseEffort": stepEffort(composerRef, 1),
    "composer.decreaseEffort": stepEffort(composerRef, -1),
    "composer.host": openControl(composerRef, "composer.host"),
    "composer.effort": openControl(composerRef, "composer.effort"),
    "composer.mode": openControl(composerRef, "composer.mode"),
    "composer.workspace": openControl(composerRef, "composer.workspace"),
    "composer.branch": ({ event }) => {
      if (!event.repeat) branchToolbarRef.current?.openBranchPicker();
    },
    "composer.previousWorktree": ({ event }) => {
      if (!event.repeat) branchToolbarRef.current?.usePreviousWorktree();
    },
  } satisfies ChatShortcutCommands;
}
