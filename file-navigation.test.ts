import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceFilePath } from "./lib/file-navigation";
import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";

const workspace = { path: "/work/repo", environmentId: "env", hostId: "host" };
const source: PluginFileOpenerSource = {
  kind: "workspace", threadId: "thread", environmentId: "env", projectId: "project",
};

test("file links resolve against the correct workspace and host", () => {
  assert.equal(workspaceFilePath("src/my file.ts", source, workspace), "src/my file.ts");
  const hostSource = { ...source, kind: "host" as const };
  assert.equal(workspaceFilePath("/work/repo/README.md", hostSource, workspace), "README.md");
  for (const path of ["/work/repo-other/README.md", "/etc/hosts", "/work/repo/../secret"]) {
    assert.equal(workspaceFilePath(path, hostSource, workspace), null);
  }
  for (const path of ["../secret", "/absolute", "src/../../secret", "src\\file.ts"]) {
    assert.equal(workspaceFilePath(path, source, workspace), null);
  }
  assert.equal(workspaceFilePath("README.md", { ...source, environmentId: "other" }, workspace), null);
  assert.equal(workspaceFilePath("README.md", { ...source, experimental_hostId: "other" }, workspace), null);
  assert.equal(workspaceFilePath("README.md", { ...source, kind: "thread-storage" }, workspace), null);
});
