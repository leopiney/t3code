import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { VoiceStartThreadInput } from "@t3tools/client-runtime/voice/types";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  T3_PROJECT_FILE_NAME,
  ThreadId,
  type ResolvedServerSettings,
  type ScopedThreadRef,
  type ServerConfig,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import {
  resolveNewThreadEnvMode,
  resolveProjectSettings,
  type ResolvedProjectSettings,
} from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";

import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";
import { buildProjectThreadStartTurnInput } from "../../lib/projectThreadStartTurn";
import { randomHex } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { projectHasThreadsAtom } from "../../state/project-has-threads";
import { projectEnvironment } from "../../state/projects";
import { VCS_REF_LIST_LIMIT } from "../../state/queries";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { stickyComposerModelSelectionAtom } from "../../state/use-composer-drafts";
import { vcsEnvironment } from "../../state/vcs";

type Project = VoiceStartThreadInput["project"];
type ProjectSettings = ResolvedProjectSettings<ResolvedServerSettings>;

const LOCAL_WORKSPACE = {
  workspaceMode: "local",
  branch: null,
  worktreePath: null,
  startFromOrigin: false,
} as const;

function commandError(result: AtomCommandResult<unknown, unknown>): Error {
  if (isAtomCommandInterrupted(result)) return new Error("the request was cancelled");
  const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
  return error instanceof Error ? error : new Error(String(error));
}

/** The project's t3.json, or null when it is missing or this session can't read files. */
async function readProjectFile(project: Project): Promise<T3ProjectFile | null> {
  if (project.workspaceRoot === "") return null;
  const result = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.readFile({
      environmentId: project.environmentId,
      input: { cwd: project.workspaceRoot, relativePath: T3_PROJECT_FILE_NAME, allowMissing: true },
    }),
    { reportFailure: false },
  );
  if (result._tag !== "Success") return null;
  const file = result.value;
  return file.exists === false || file.truncated ? null : parseT3ProjectFile(file.contents);
}

/** The new-task model: the project's default, else the last one picked, past usage limits. */
function newTaskModel(config: ServerConfig, project: Project, settings: ProjectSettings) {
  const projectDefault = resolveDefaultableModelSelection(
    config,
    settings.settings.defaultModelSelection,
    project.id,
  );
  const sticky = resolveDefaultableModelSelection(
    config,
    appAtomRegistry.get(stickyComposerModelSelectionAtom),
    project.id,
  );
  return resolveNewThreadModelSelection({
    defaultSelection: resolveNewTaskModelSelection({
      draftSelection: null,
      projectDefaultSelection: projectDefault,
      stickySelection: sticky,
      modelOptions: buildModelOptions(config, projectDefault ?? sticky, undefined, project.id),
    }),
    explicitSelection: projectDefault ? null : sticky,
    fallbackSelection: config.settings.fallbackModelSelection ?? null,
    providers: config.providers,
    settings: config.settings,
    projectId: project.id,
    now: Date.now(),
  }).selection;
}

/** The new-task workspace: a worktree off the default branch when the project defaults to one. */
async function newTaskWorkspace(config: ServerConfig, project: Project, settings: ProjectSettings) {
  if (project.workspaceRoot === "" || isScratchProject(project, config.scratchWorkspaceRoot)) {
    return LOCAL_WORKSPACE;
  }
  const mode = resolveNewThreadEnvMode({
    projectSettings: settings,
    workspaceRoot: project.workspaceRoot,
    newProjectsRoot: config.newProjectsRoot,
    projectHasThreads: appAtomRegistry.get(
      projectHasThreadsAtom(project.environmentId)(project.id),
    ),
  });
  if (mode !== "worktree") return LOCAL_WORKSPACE;
  const result = await executeAtomQuery(
    appAtomRegistry,
    vcsEnvironment.listRefs({
      environmentId: project.environmentId,
      input: { cwd: project.workspaceRoot, limit: VCS_REF_LIST_LIMIT },
    }),
    { reportFailure: false },
  );
  if (result._tag !== "Success") throw commandError(result);
  if (!result.value.isRepo) return LOCAL_WORKSPACE;
  // The default may only exist as origin/<default>, so remote refs count too.
  const base =
    result.value.refs.find((ref) => ref.isDefault) ??
    result.value.refs.find((ref) => !ref.isRemote && ref.current);
  if (base === undefined)
    throw new Error(`${project.title} has no branch to start a worktree from`);
  return {
    workspaceMode: "worktree",
    branch: base.name,
    worktreePath: null,
    startFromOrigin: settings.settings.newWorktreesStartFromOrigin,
  } as const;
}

/** Starts a thread with the project's defaults for model, access and workspace, as a new task does. */
export async function startVoiceThread({
  project,
  prompt,
  summary,
}: VoiceStartThreadInput): Promise<ScopedThreadRef> {
  const presentation = appAtomRegistry
    .get(environmentPresentations.presentationsAtom)
    .get(project.environmentId);
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(project.environmentId));
  // Environment reads wait for a connection, which would hang the tool call.
  if (presentation?.connection.phase !== "connected" || config === null) {
    throw new Error(`the environment of ${project.title} is not connected`);
  }
  const settings = resolveProjectSettings(
    config.settings,
    project.id,
    project,
    await readProjectFile(project),
  );
  const modelSelection = newTaskModel(config, project, settings);
  if (modelSelection === null) throw new Error(`no provider is ready to work in ${project.title}`);
  const workspace = await newTaskWorkspace(config, project, settings);
  const metadata = makeTurnCommandMetadata();
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.startTurn,
    {
      environmentId: project.environmentId,
      input: buildProjectThreadStartTurnInput({
        ...metadata,
        ...workspace,
        projectId: project.id,
        projectCwd: project.workspaceRoot,
        text: prompt,
        titleText: summary,
        uploadedAttachments: [],
        modelSelection,
        runtimeMode: settings.settings.defaultRuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        worktreeBranchName: buildTemporaryWorktreeBranchName(randomHex),
      }),
    },
    { reportFailure: false },
  );
  if (result._tag !== "Success") throw commandError(result);
  return { environmentId: project.environmentId, threadId: ThreadId.make(metadata.threadId) };
}
