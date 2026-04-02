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

function createThreadStartResponse(): protocol.v2.ThreadStartResponse {
  return {
    thread: {
      id: "thr_123",
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 0,
      updatedAt: 0,
      status: "idle",
      path: null,
      cwd: "/tmp",
      cliVersion: "0.0.0",
      source: "appServer",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp",
    approvalPolicy: null,
    approvalsReviewer: null,
    sandbox: null,
    reasoningEffort: null,
  } as unknown as protocol.v2.ThreadStartResponse;
}

function createThreadReadResponse(items: protocol.v2.ThreadItem[]): protocol.v2.ThreadReadResponse {
  return {
    thread: {
      id: "thr_123",
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 0,
      updatedAt: 0,
      status: "idle",
      path: null,
      cwd: "/tmp",
      cliVersion: "0.0.0",
      source: "appServer",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [
        {
          id: "turn_123",
          status: "completed",
          error: null,
          items,
        },
      ],
    },
  } as unknown as protocol.v2.ThreadReadResponse;
}

async function createTempStatePaths(): Promise<ChatgptAppsStatePaths> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openai-apps-invoker-analytics-"));
  return {
    rootDir,
    codexHomeDir: path.join(rootDir, "codex-home"),
    snapshotPath: path.join(rootDir, "connectors.snapshot.json"),
    derivedConfigPath: path.join(rootDir, "codex-apps.config.json"),
    refreshDebugPath: path.join(rootDir, "refresh-debug.json"),
  };
}

describe("invokeViaAppServer analytics defaults", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("disables analytics on bundle-owned app-server invocation sessions", async () => {
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
      writeConfigValue: async (): Promise<protocol.v2.ConfigWriteResponse> => ({
        status: "ok",
        version: "1",
        filePath: "/tmp/openai-apps/config.toml",
        overriddenMetadata: null,
      }),
      startThread: async () => createThreadStartResponse(),
      runTurn: async () => ({
        start: {
          turn: {
            id: "turn_123",
            items: [],
            status: "inProgress",
            error: null,
          },
        },
        completed: {
          threadId: "thr_123",
          turn: {
            id: "turn_123",
            items: [],
            status: "completed",
            error: null,
          },
        },
      }),
      readThread: async () =>
        createThreadReadResponse([
          {
            type: "agentMessage",
            id: "msg_1",
            phase: "final_answer",
            text: "ok",
          },
        ]),
      handleServerRequest: () => () => {},
      onServerRequest: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
    });

    try {
      const { invokeViaAppServer } = await import("./app-server-invoker.js");
      const result = await invokeViaAppServer({
        config,
        route: {
          connectorId: "gmail",
          appId: "asdk_app_gmail",
          publishedName: "chatgpt_app_gmail",
          appName: "Gmail",
          appInvocationToken: "gmail",
        },
        args: { request: "Summarize my recent emails" },
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

      expect(result).toEqual({
        content: [{ type: "text", text: "ok" }],
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
        unhandledServerRequestStrategy: "manual",
      }),
    );
  });
});
