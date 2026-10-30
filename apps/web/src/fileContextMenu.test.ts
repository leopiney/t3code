import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fileContextMenuOpenLabel, resolveFileContextMenuAbsolutePath } from "./fileContextMenu";

const BASE_TARGET = {
  environmentId: EnvironmentId.make("environment-local"),
  filePath: "src/index.ts",
  workspaceRoot: "/workspace/project",
};

describe("fileContextMenuOpenLabel", () => {
  it("names the system browser for a local html file", () => {
    expect(fileContextMenuOpenLabel("/tmp/report.html", true)).toBe("Open in browser");
    expect(fileContextMenuOpenLabel("/tmp/report.HTML", true)).toBe("Open in browser");
    expect(fileContextMenuOpenLabel("/tmp/report.html:12", true)).toBe("Open in browser");
  });

  it("keeps Open for other files and for a remote environment", () => {
    expect(fileContextMenuOpenLabel("/tmp/report.ts", true)).toBe("Open");
    expect(fileContextMenuOpenLabel("/tmp/report.pdf", true)).toBe("Open");
    expect(fileContextMenuOpenLabel("/tmp/report.html", false)).toBe("Open");
  });
});

describe("resolveFileContextMenuAbsolutePath", () => {
  it("strips the repository prefix when the repo root is nested in the workspace", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "packages/app/src/index.ts",
      }),
    ).toBe("/workspace/project/packages/app/src/index.ts");
  });

  it("returns null for paths outside the workspace when a repository root is set", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "other/src/index.ts",
      }),
    ).toBeNull();
  });

  it("rejects absolute paths without a workspace root, matching diff path resolution", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: undefined,
        filePath: "/absolute/src/index.ts",
      }),
    ).toBeNull();
  });
});
