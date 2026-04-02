import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { protocol } from "codex-app-server-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatgptAppsConfig } from "./config.js";
import type { ChatgptAppsStatePaths } from "./state-paths.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("codex-app-server-sdk", () => ({
  CodexAppServerClient: {
    spawn: spawnMock,
  },
}));

const config: ChatgptAppsConfig = {
  allowDestructiveActions: "always",
  appServer: {
    command: "codex",
    args: [],
  },
  connectors: {
    gmail: { enabled: true },
  },
};

async function createTempStatePaths(): Promise<ChatgptAppsStatePaths> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openai-apps-session-analytics-"));
  return {
    rootDir,
    codexHomeDir: path.join(rootDir, "codex-home"),
    snapshotPath: path.join(rootDir, "connectors.snapshot.json"),
    derivedConfigPath: path.join(rootDir, "codex-apps.config.json"),
    refreshDebugPath: path.join(rootDir, "refresh-debug.json"),
  };
}

describe("captureAppServerSnapshot analytics defaults", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("disables analytics on bundle-owned app-server refresh sessions", async () => {
    const statePaths = await createTempStatePaths();

    spawnMock.mockResolvedValue({
      initializeSession: async () => {},
      handleChatgptAuthTokensRefresh: () => () => {},
      loginAccount: async (): Promise<protocol.v2.LoginAccountResponse> => ({
        type: "chatgptAuthTokens",
      }),
      readAccount: async (): Promise<protocol.v2.GetAccountResponse> => ({
        account: null,
        requiresOpenaiAuth: false,
      }),
      getAuthStatus: async (): Promise<protocol.GetAuthStatusResponse> => ({
        authMethod: "chatgpt",
        authToken: null,
        requiresOpenaiAuth: false,
      }),
      listApps: async (): Promise<protocol.v2.AppsListResponse> => ({
        data: [],
        nextCursor: null,
      }),
      writeConfigValue: async (): Promise<protocol.v2.ConfigWriteResponse> => ({
        status: "ok",
        version: "1",
        filePath: "/tmp/openai-apps/config.toml",
        overriddenMetadata: null,
      }),
      close: async () => {},
    });

    try {
      const { captureAppServerSnapshot } = await import("./app-server-session.js");
      await captureAppServerSnapshot({
        config,
        statePaths,
        resolveProjectedAuth: async () => ({
          status: "ok",
          accessToken: "access-token",
          accountId: "acct_123",
          planType: null,
          profileId: "openai-codex:default",
          identity: { email: "user@example.com", profileName: "user@example.com" },
        }),
      });
    } finally {
      await rm(statePaths.rootDir, { recursive: true, force: true });
    }

    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        configOverrides: ["analytics.enabled=false"],
        disableFeatures: ["plugins"],
        analyticsDefaultEnabled: false,
        env: expect.objectContaining({
          ANALYTICS_DEFAULT_ENABLED: "false",
        }),
      }),
    );
  });
});
