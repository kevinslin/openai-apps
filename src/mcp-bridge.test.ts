import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import type { PersistedConnectorRecord } from "./connector-record.js";
import { ChatgptAppsMcpBridge } from "./mcp-bridge.js";
import type { PersistedConnectorSnapshot } from "./snapshot-cache.js";
import { resolveChatgptAppsStatePaths } from "./state-paths.js";

function createConfig(
  connectors: Record<string, { enabled: boolean }> = { slack: { enabled: true } },
): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "openai-apps": {
          config: {
            connectors,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createConnectorRecord(
  overrides: Partial<PersistedConnectorRecord> = {},
): PersistedConnectorRecord {
  return {
    connectorId: "slack",
    appId: "asdk_app_slack",
    appName: "Slack",
    publishedName: "chatgpt_app_slack",
    appInvocationToken: "slack",
    description: "Chat with Slack workspaces.",
    pluginDisplayNames: ["Slack"],
    isAccessible: true,
    isEnabled: true,
    ...overrides,
  };
}

function createPersistedSnapshot(): PersistedConnectorSnapshot {
  return {
    version: 2,
    fetchedAt: "2026-03-29T18:00:00.000Z",
    projectedAt: "2026-03-29T18:00:00.000Z",
    accountId: "acct_123",
    authIdentityKey: "user@example.com",
    connectors: [createConnectorRecord()],
  };
}

async function writeSnapshot(stateDir: string, snapshot = createPersistedSnapshot()) {
  const statePaths = resolveChatgptAppsStatePaths({
    OPENCLAW_STATE_DIR: stateDir,
    HOME: os.tmpdir(),
  });
  await mkdir(path.dirname(statePaths.snapshotPath), { recursive: true });
  await writeFile(statePaths.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

async function createStateDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "openai-apps-bridge-"));
}

function createBridgeEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    OPENCLAW_STATE_DIR: stateDir,
  };
}

describe("ChatgptAppsMcpBridge", () => {
  it("publishes one connector-level tool per enabled connector record", async () => {
    const stateDir = await createStateDir();
    await writeSnapshot(stateDir);
    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: createBridgeEnv(stateDir),
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot: createPersistedSnapshot(),
        config: {
          allowDestructiveActions: "never",
          appServer: { command: "codex", args: [] },
          connectors: { slack: { enabled: true } },
        },
        openclawConfig: createConfig(),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
    });

    try {
      await expect(bridge.listTools()).resolves.toEqual([
        expect.objectContaining({
          name: "chatgpt_app_slack",
          description: expect.not.stringContaining("server-side capability"),
          inputSchema: expect.objectContaining({
            required: ["request"],
          }),
        }),
      ]);
    } finally {
      await bridge.close();
    }
  });

  it("does not publish internal collab apps under wildcard enablement", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    snapshot.connectors.push(
      createConnectorRecord({
        connectorId: "collab",
        appId: "collab",
        appName: "Collab",
        publishedName: "chatgpt_app_collab",
        appInvocationToken: "collab",
        description: "Internal collab dispatch.",
        pluginDisplayNames: ["Collab"],
      }),
    );
    await writeSnapshot(stateDir, snapshot);

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig({ "*": { enabled: true } }),
      env: createBridgeEnv(stateDir),
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          allowDestructiveActions: "never",
          appServer: { command: "codex", args: [] },
          connectors: { "*": { enabled: true } },
        },
        openclawConfig: createConfig({ "*": { enabled: true } }),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
    });

    try {
      const tools = await bridge.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["chatgpt_app_slack"]);
    } finally {
      await bridge.close();
    }
  });

  it("fails publication when a connector snapshot record is malformed", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    snapshot.connectors = [
      createConnectorRecord({
        publishedName: "not-the-published-name",
      }),
    ];
    await writeSnapshot(stateDir, snapshot);

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: createBridgeEnv(stateDir),
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          allowDestructiveActions: "never",
          appServer: { command: "codex", args: [] },
          connectors: { slack: { enabled: true } },
        },
        openclawConfig: createConfig(),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
    });

    try {
      await expect(bridge.listTools()).rejects.toThrow("mismatched publishedName");
    } finally {
      await bridge.close();
    }
  });

  it("fails publication when the snapshot contains duplicate connector ids", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    snapshot.connectors.push(
      createConnectorRecord({
        appId: "asdk_app_slack_2",
      }),
    );
    await writeSnapshot(stateDir, snapshot);

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig({ "*": { enabled: true } }),
      env: createBridgeEnv(stateDir),
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          allowDestructiveActions: "never",
          appServer: { command: "codex", args: [] },
          connectors: { "*": { enabled: true } },
        },
        openclawConfig: createConfig({ "*": { enabled: true } }),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
    });

    try {
      await expect(bridge.listTools()).rejects.toThrow(
        "Duplicate connector snapshot record for connector: slack",
      );
    } finally {
      await bridge.close();
    }
  });

  it("routes connector tools through the app-server invoker", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    await writeSnapshot(stateDir, snapshot);
    const appServerInvoker = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: createBridgeEnv(stateDir),
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          allowDestructiveActions: "never",
          appServer: { command: "codex", args: [] },
          connectors: { slack: { enabled: true } },
        },
        openclawConfig: createConfig(),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      appServerInvoker,
    });

    try {
      const result = await bridge.callTool("chatgpt_app_slack", {
        request: "Send a launch update to #team",
      });

      expect(result).toEqual({
        content: [{ type: "text", text: "ok" }],
      });
      expect(appServerInvoker).toHaveBeenCalledWith(
        expect.objectContaining({
          handleMcpServerElicitation: expect.any(Function),
          route: {
            connectorId: "slack",
            appId: "asdk_app_slack",
            publishedName: "chatgpt_app_slack",
            appName: "Slack",
            appInvocationToken: "slack",
          },
          args: {
            request: "Send a launch update to #team",
          },
        }),
      );
    } finally {
      await bridge.close();
    }
  });

  it("shares the same apps config write gate across refresh and tool invocation", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    await writeSnapshot(stateDir, snapshot);

    let refreshGate: unknown = null;
    let invokeGate: unknown = null;
    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: createBridgeEnv(stateDir),
      ensureFreshSnapshot: async (params) => {
        refreshGate = params.appsConfigWriteGate;
        return {
          status: "ok",
          source: "cache",
          snapshot,
          config: {
            allowDestructiveActions: "never",
            appServer: { command: "codex", args: [] },
            connectors: { slack: { enabled: true } },
          },
          openclawConfig: createConfig(),
          statePaths: resolveChatgptAppsStatePaths({
            OPENCLAW_STATE_DIR: stateDir,
            HOME: os.tmpdir(),
          }),
        };
      },
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      appServerInvoker: vi.fn(async (params) => {
        invokeGate = params.appsConfigWriteGate;
        return {
          content: [{ type: "text" as const, text: "ok" }],
        };
      }),
    });

    try {
      await bridge.listTools();
      await bridge.callTool("chatgpt_app_slack", {
        request: "Send a launch update to #team",
      });

      expect(refreshGate).toBeTruthy();
      expect(invokeGate).toBe(refreshGate);
    } finally {
      await bridge.close();
    }
  });

  it("requests OpenClaw plugin approval for destructive actions when configured for on-request", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    await writeSnapshot(stateDir, snapshot);

    const appServerInvoker = vi.fn(async (params) => {
      const response = await params.handleMcpServerElicitation?.({
        threadId: "thr_123",
        turnId: "turn_123",
        serverName: "codex_apps",
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_name: "Slack",
          tool_title: "post_message",
          tool_params: {
            channel: "#launch",
            text: "Ship it",
          },
        },
        message: "Allow Slack to post a message?",
        requestedSchema: {
          type: "object",
          properties: {},
        },
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
      };
    });
    const requestPluginApproval = vi.fn(async () => "allow-once" as const);

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: createBridgeEnv(stateDir),
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          allowDestructiveActions: "on-request",
          appServer: { command: "codex", args: [] },
          connectors: { slack: { enabled: true } },
        },
        openclawConfig: createConfig(),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      appServerInvoker,
      requestPluginApproval,
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: "chatgpt_app_slack",
        arguments: {
          request: "Send a launch update to #launch",
        },
      });

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action: "accept",
              content: {},
              _meta: null,
            }),
          },
        ],
      });
      expect(requestPluginApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "openai-apps",
          title: "Approve Slack post_message?",
          severity: "warning",
          toolName: "chatgpt_app_slack",
        }),
      );
      const approvalRequest = requestPluginApproval.mock.calls[0]?.[0];
      expect(approvalRequest?.description).toContain("Allow Slack to post a message?");
      expect(approvalRequest?.description).toContain("App payload:");
      expect(approvalRequest?.description).toContain('"channel": "#launch"');
      expect(approvalRequest?.description).toContain('"text": "Ship it"');
    } finally {
      await Promise.all([client.close(), bridge.close()]);
    }
  });

  it("maps denied OpenClaw plugin approvals back to the app-server decline payload", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    await writeSnapshot(stateDir, snapshot);

    const appServerInvoker = vi.fn(async (params) => {
      const response = await params.handleMcpServerElicitation?.({
        threadId: "thr_123",
        turnId: "turn_123",
        serverName: "codex_apps",
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_name: "Slack",
          tool_title: "post_message",
          tool_params: {
            channel: "#launch",
          },
        },
        message: "Allow Slack to post a message?",
        requestedSchema: {
          type: "object",
          properties: {},
        },
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
      };
    });
    const requestPluginApproval = vi.fn(async () => "deny" as const);

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: createBridgeEnv(stateDir),
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          allowDestructiveActions: "on-request",
          appServer: { command: "codex", args: [] },
          connectors: { slack: { enabled: true } },
        },
        openclawConfig: createConfig(),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      appServerInvoker,
      requestPluginApproval,
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: "chatgpt_app_slack",
        arguments: {
          request: "Send a launch update to #launch",
        },
      });

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action: "decline",
              content: null,
              _meta: null,
            }),
          },
        ],
      });
    } finally {
      await Promise.all([client.close(), bridge.close()]);
    }
  });

  it("persists allow-always plugin approvals and skips the next prompt", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    await writeSnapshot(stateDir, snapshot);
    const requestPluginApproval = vi.fn(async () => "allow-always" as const);
    const persistConnectorAlwaysAllow = vi.fn(async () => {});

    const appServerInvoker = vi.fn(async (params) => {
      const response = await params.handleMcpServerElicitation?.({
        threadId: "thr_123",
        turnId: "turn_123",
        serverName: "codex_apps",
        mode: "form",
        _meta: {
          connector_name: "Slack",
          tool_title: "post_message",
          tool_params: {
            channel: "#launch",
          },
        },
        message: "Allow Slack to post a message?",
        requestedSchema: {
          type: "object",
          properties: {},
        },
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
      };
    });

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: createBridgeEnv(stateDir),
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          allowDestructiveActions: "on-request",
          appServer: { command: "codex", args: [] },
          connectors: { slack: { enabled: true } },
        },
        openclawConfig: createConfig(),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      appServerInvoker,
      requestPluginApproval,
      persistConnectorAlwaysAllow,
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

    try {
      await client.callTool({
        name: "chatgpt_app_slack",
        arguments: { request: "Send a launch update to #launch" },
      });
      await client.callTool({
        name: "chatgpt_app_slack",
        arguments: { request: "Send a launch update to #launch again" },
      });

      expect(requestPluginApproval).toHaveBeenCalledTimes(1);
      expect(persistConnectorAlwaysAllow).toHaveBeenCalledWith("slack");
    } finally {
      await Promise.all([client.close(), bridge.close()]);
    }
  });

  it("does not fail an approved app call when allow-always persistence fails", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    await writeSnapshot(stateDir, snapshot);
    const requestPluginApproval = vi.fn(async () => "allow-always" as const);
    const persistConnectorAlwaysAllow = vi.fn(async () => {
      throw new Error("config is read-only");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const appServerInvoker = vi.fn(async (params) => {
      await params.handleMcpServerElicitation?.({
        threadId: "thr_123",
        turnId: "turn_123",
        serverName: "codex_apps",
        mode: "form",
        _meta: {
          connector_name: "Slack",
          tool_title: "post_message",
          tool_params: {
            channel: "#launch",
          },
        },
        message: "Allow Slack to post a message?",
        requestedSchema: {
          type: "object",
          properties: {},
        },
      });

      return {
        content: [{ type: "text" as const, text: "posted" }],
      };
    });

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig(),
      env: createBridgeEnv(stateDir),
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          allowDestructiveActions: "on-request",
          appServer: { command: "codex", args: [] },
          connectors: { slack: { enabled: true } },
        },
        openclawConfig: createConfig(),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
      appServerInvoker,
      requestPluginApproval,
      persistConnectorAlwaysAllow,
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

    try {
      await expect(
        client.callTool({
          name: "chatgpt_app_slack",
          arguments: { request: "Send a launch update to #launch" },
        }),
      ).resolves.toEqual({
        content: [{ type: "text", text: "posted" }],
      });
      expect(persistConnectorAlwaysAllow).toHaveBeenCalledWith("slack");
    } finally {
      await Promise.all([client.close(), bridge.close()]);
      consoleError.mockRestore();
    }
  });

  it("honors wildcard enablement with explicit disables", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    snapshot.connectors.push(
      createConnectorRecord({
        connectorId: "gmail",
        appId: "asdk_app_gmail",
        appName: "Gmail",
        publishedName: "chatgpt_app_gmail",
        appInvocationToken: "gmail",
        description: "Read mail.",
        pluginDisplayNames: ["Gmail"],
      }),
    );
    await writeSnapshot(stateDir, snapshot);

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () =>
        createConfig({
          "*": { enabled: true },
          gmail: { enabled: false },
        }),
      env: createBridgeEnv(stateDir),
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          allowDestructiveActions: "never",
          appServer: { command: "codex", args: [] },
          connectors: {
            "*": { enabled: true },
            gmail: { enabled: false },
          },
        },
        openclawConfig: createConfig({
          "*": { enabled: true },
          gmail: { enabled: false },
        }),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
    });

    try {
      const tools = await bridge.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["chatgpt_app_slack"]);
    } finally {
      await bridge.close();
    }
  });

  it("adds generic routing hints for published app tools", async () => {
    const stateDir = await createStateDir();
    const snapshot = createPersistedSnapshot();
    snapshot.connectors = [
      createConnectorRecord({
        connectorId: "gmail",
        appId: "asdk_app_gmail",
        appName: "Gmail",
        publishedName: "chatgpt_app_gmail",
        appInvocationToken: "gmail",
        description: "Find and reference emails from your inbox",
        pluginDisplayNames: ["Gmail"],
      }),
    ];
    await writeSnapshot(stateDir, snapshot);

    const bridge = new ChatgptAppsMcpBridge({
      loadOpenClawConfig: () => createConfig({ gmail: { enabled: true } }),
      env: createBridgeEnv(stateDir),
      ensureFreshSnapshot: async () => ({
        status: "ok",
        source: "cache",
        snapshot,
        config: {
          allowDestructiveActions: "never",
          appServer: { command: "codex", args: [] },
          connectors: { gmail: { enabled: true } },
        },
        openclawConfig: createConfig({ gmail: { enabled: true } }),
        statePaths: resolveChatgptAppsStatePaths({
          OPENCLAW_STATE_DIR: stateDir,
          HOME: os.tmpdir(),
        }),
      }),
      resolveProjectedAuth: async () => ({
        status: "ok",
        accessToken: "access-token",
        accountId: "acct_123",
        planType: null,
        profileId: "openai-codex:default",
        identity: { email: "user@example.com", profileName: "user@example.com" },
      }),
    });

    try {
      await expect(bridge.listTools()).resolves.toEqual([
        expect.objectContaining({
          name: "chatgpt_app_gmail",
          description: expect.stringContaining(
            "For clear read-only requests, call the tool directly",
          ),
          inputSchema: expect.objectContaining({
            properties: expect.objectContaining({
              request: expect.objectContaining({
                description: expect.stringContaining(
                  "prefer a sensible default scope instead of asking a redundant follow-up first",
                ),
              }),
            }),
          }),
        }),
      ]);
    } finally {
      await bridge.close();
    }
  });
});
