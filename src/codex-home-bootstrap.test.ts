import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureAppsFeatureEnabledInToml, ensureBundledCodexHome } from "./codex-home-bootstrap.js";

describe("codex home bootstrap", () => {
  it("adds the apps feature block when config.toml is empty", () => {
    expect(ensureAppsFeatureEnabledInToml("")).toBe("[features]\napps = true\n");
  });

  it("enables apps inside an existing features table", () => {
    expect(
      ensureAppsFeatureEnabledInToml(
        ['model = "gpt-5.4"', "", "[features]", "apps = false", "shell_snapshot = true", ""].join(
          "\n",
        ),
      ),
    ).toBe(
      ['model = "gpt-5.4"', "", "[features]", "apps = true", "shell_snapshot = true", ""].join(
        "\n",
      ),
    );
  });

  it("appends the apps feature block when config.toml has no features table", () => {
    expect(ensureAppsFeatureEnabledInToml("[apps._default]\nenabled = true\n")).toBe(
      "[apps._default]\nenabled = true\n\n[features]\napps = true\n",
    );
  });

  it("updates config.toml without creating a codex apps cache", async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), "openai-apps-bootstrap-target-"));
    const targetCodexHomeDir = path.join(targetRoot, "codex-home");

    await mkdir(targetCodexHomeDir, { recursive: true });
    await writeFile(
      path.join(targetCodexHomeDir, "config.toml"),
      "[apps._default]\nenabled = true\n",
    );

    try {
      await ensureBundledCodexHome({
        codexHomeDir: targetCodexHomeDir,
      });

      expect(await readFile(path.join(targetCodexHomeDir, "config.toml"), "utf8")).toContain(
        "[features]\napps = true",
      );
      await expect(
        stat(path.join(targetCodexHomeDir, "cache", "codex_apps_tools")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });
});
