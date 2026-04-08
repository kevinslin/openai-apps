import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { protocol } from "codex-app-server-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  createAppServerAppsConfigWriteGate,
  type AppServerAppsConfigWriteGate,
} from "./app-server-apps-config.js";
import {
  invokeViaAppServer,
  type AppServerInvocationRoute,
  type AppServerToolInvoker,
} from "./app-server-invoker.js";
import { resolveChatgptAppsProjectedAuth } from "./auth-projector.js";
import {
  hashChatgptAppsConfig,
  isConnectorAlwaysAllowed,
  markConnectorAlwaysAllow,
  OPENAI_APPS_PLUGIN_ID,
  resolveChatgptAppsConfig,
} from "./config.js";
import {
  assertValidPersistedConnectorRecord,
  normalizeConnectorKey,
  shouldExcludeConnectorId,
  type PersistedConnectorRecord,
} from "./connector-record.js";
import { ensureFreshSnapshot } from "./refresh-snapshot.js";
import { computeSnapshotKey, type PersistedConnectorSnapshot } from "./snapshot-cache.js";
import {
  requestOpenClawPluginApproval,
  type PluginApprovalDecision,
  type PluginApprovalRequest,
} from "./openclaw-plugin-approval.js";
import { resolveChatgptAppsStatePaths } from "./state-paths.js";

export const MCP_SERVER_NAME = "openai-apps";
const ROUTING_META_KEY = "openclaw/chatgpt-apps";
const DEFAULT_ALWAYS_ALLOW_PERSIST_IDLE_MS = 5_000;
const DEFAULT_ALWAYS_ALLOW_PERSIST_MAX_RETRIES = 3;
const MAX_ALWAYS_ALLOW_PERSIST_RETRY_DELAY_MS = 60_000;
const CONNECTOR_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    request: {
      type: "string",
      description:
        "Natural-language instruction to send to this ChatGPT app. For clear read-only requests, prefer a sensible default scope instead of asking a redundant follow-up first.",
    },
  },
  required: ["request"],
} satisfies Tool["inputSchema"];

type BridgeRoute = AppServerInvocationRoute;
type McpServerElicitationRequestParams = protocol.v2.McpServerElicitationRequestParams;

type BridgeToolCache = {
  snapshotKey: string;
  tools: Tool[];
  routes: Map<string, BridgeRoute>;
};

function buildConnectorConfigState(configuredConnectors: Record<string, { enabled: boolean }>): {
  wildcardEnabled: boolean;
  enabledConnectorIds: Set<string>;
  disabledConnectorIds: Set<string>;
} {
  let wildcardEnabled = false;
  const enabledConnectorIds = new Set<string>();
  const disabledConnectorIds = new Set<string>();

  for (const [connectorId, connector] of Object.entries(configuredConnectors)) {
    const trimmedId = connectorId.trim();
    if (!trimmedId) {
      continue;
    }
    if (trimmedId === "*") {
      wildcardEnabled = connector.enabled === true;
      continue;
    }
    const normalized = normalizeConnectorKey(trimmedId);
    if (!normalized) {
      continue;
    }
    if (connector.enabled) {
      enabledConnectorIds.add(normalized);
      continue;
    }
    disabledConnectorIds.add(normalized);
  }

  return {
    wildcardEnabled,
    enabledConnectorIds,
    disabledConnectorIds,
  };
}

function buildAllowedConnectorIds(params: {
  connectors: PersistedConnectorRecord[];
  configuredConnectors: Record<string, { enabled: boolean }>;
}): Set<string> {
  const { wildcardEnabled, enabledConnectorIds, disabledConnectorIds } = buildConnectorConfigState(
    params.configuredConnectors,
  );

  const allowed = new Set<string>();
  for (const connector of params.connectors) {
    assertValidPersistedConnectorRecord(connector);
    if (!connector.isAccessible || !connector.isEnabled) {
      continue;
    }
    if (
      shouldExcludeConnectorId(connector.connectorId) ||
      disabledConnectorIds.has(connector.connectorId)
    ) {
      continue;
    }
    if (
      Object.keys(params.configuredConnectors).length === 0 ||
      wildcardEnabled ||
      enabledConnectorIds.has(connector.connectorId)
    ) {
      allowed.add(connector.connectorId);
    }
  }

  return allowed;
}

function buildAppRouteByConnectorId(
  connectors: PersistedConnectorRecord[],
): Map<string, BridgeRoute> {
  const routes = new Map<string, BridgeRoute>();

  for (const connector of connectors) {
    assertValidPersistedConnectorRecord(connector);
    if (routes.has(connector.connectorId)) {
      throw new Error(
        `Duplicate connector snapshot record for connector: ${connector.connectorId}`,
      );
    }
    routes.set(connector.connectorId, {
      connectorId: connector.connectorId,
      appId: connector.appId,
      publishedName: connector.publishedName,
      appName: connector.appName,
      appInvocationToken: connector.appInvocationToken,
    });
  }

  return routes;
}

function buildConnectorRoutingHint(connector: PersistedConnectorRecord): string {
  return [
    `Use this tool for requests that clearly belong to ${connector.appName}.`,
    "For clear read-only requests, call the tool directly even when the exact slice, filters, or time window are slightly underspecified.",
    "Choose a sensible default and let the final answer mention the assumption briefly.",
  ].join(" ");
}

function buildToolDescription(connector: PersistedConnectorRecord): string {
  return [
    connector.description.trim(),
    buildConnectorRoutingHint(connector),
    "Send a natural-language instruction in the request field.",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildPublishedTool(route: BridgeRoute, connector: PersistedConnectorRecord): Tool {
  return {
    name: route.publishedName,
    description: buildToolDescription(connector),
    inputSchema: CONNECTOR_TOOL_INPUT_SCHEMA,
    _meta: {
      [ROUTING_META_KEY]: {
        connectorId: route.connectorId,
      },
    },
  };
}

type PublicationState = {
  config: ReturnType<typeof resolveChatgptAppsConfig>;
  snapshot: PersistedConnectorSnapshot;
};

type PluginApprovalRequester = (
  request: PluginApprovalRequest,
) => Promise<PluginApprovalDecision | null>;
type ConnectorAlwaysAllowPersister = (connectorId: string) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatJsonForPrompt(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify(String(value));
  }
}

function resolveDisplayedElicitationPayload(params: McpServerElicitationRequestParams): unknown {
  if (isRecord(params._meta) && isRecord(params._meta.tool_params)) {
    return params._meta.tool_params;
  }
  if (params._meta !== null) {
    return params._meta;
  }
  if (params.mode === "url") {
    return {
      url: params.url,
      elicitationId: params.elicitationId,
    };
  }
  return {
    requestedSchema: params.requestedSchema,
  };
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  const explicitPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }
  const stateDir =
    env.OPENCLAW_STATE_DIR?.trim() || path.join(env.HOME || os.homedir(), ".openclaw");
  return path.join(stateDir, "openclaw.json");
}

function resolveAlwaysAllowPersistIdleMs(env: NodeJS.ProcessEnv): number {
  const rawValue = env.OPENCLAW_OPENAI_APPS_ALWAYS_ALLOW_PERSIST_IDLE_MS?.trim();
  if (!rawValue) {
    return DEFAULT_ALWAYS_ALLOW_PERSIST_IDLE_MS;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_ALWAYS_ALLOW_PERSIST_IDLE_MS;
  }
  return parsed;
}

function buildDestructiveActionApprovalRequest(params: {
  elicitation: McpServerElicitationRequestParams;
  route: BridgeRoute;
}): PluginApprovalRequest {
  const { elicitation, route } = params;
  const meta = isRecord(elicitation._meta) ? elicitation._meta : null;
  const connectorName =
    typeof meta?.connector_name === "string" ? meta.connector_name : route.appName;
  const toolTitle = typeof meta?.tool_title === "string" ? meta.tool_title : "destructive action";
  const payload = formatJsonForPrompt(resolveDisplayedElicitationPayload(elicitation));
  const message =
    typeof elicitation.message === "string" && elicitation.message.trim().length > 0
      ? elicitation.message.trim()
      : "Approve this ChatGPT app write action.";

  return {
    pluginId: OPENAI_APPS_PLUGIN_ID,
    title: truncate(`Approve ${connectorName} ${toolTitle}?`, 80),
    description: truncate(`${message}\nApp payload: ${payload}`, 256),
    severity: "warning",
    toolName: route.publishedName,
  };
}

export class ChatgptAppsMcpBridge {
  private readonly server: Server;
  private readonly loadOpenClawConfig: () => OpenClawConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly workspaceDir?: string;
  private readonly ensureFreshSnapshot;
  private readonly resolveProjectedAuth;
  private readonly appServerInvoker: AppServerToolInvoker;
  private readonly appsConfigWriteGate: AppServerAppsConfigWriteGate;
  private readonly requestPluginApproval: PluginApprovalRequester;
  private readonly persistConnectorAlwaysAllow: ConnectorAlwaysAllowPersister;
  private readonly alwaysAllowPersistIdleMs: number;
  private readonly runtimeAlwaysAllowConnectorIds = new Set<string>();
  private readonly pendingAlwaysAllowConnectorIds = new Set<string>();
  private alwaysAllowPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private alwaysAllowPersistFailureCount = 0;
  private activeToolCalls = 0;
  private lastToolActivityAtMs = 0;
  private toolCache: BridgeToolCache | null = null;
  private toolCachePromise: Promise<BridgeToolCache> | null = null;

  constructor(params: {
    loadOpenClawConfig: () => OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    ensureFreshSnapshot?: typeof ensureFreshSnapshot;
    resolveProjectedAuth?: typeof resolveChatgptAppsProjectedAuth;
    appServerInvoker?: AppServerToolInvoker;
    requestPluginApproval?: PluginApprovalRequester;
    persistConnectorAlwaysAllow?: ConnectorAlwaysAllowPersister;
  }) {
    this.loadOpenClawConfig = params.loadOpenClawConfig;
    this.env = params.env ?? process.env;
    this.workspaceDir = params.workspaceDir;
    this.ensureFreshSnapshot = params.ensureFreshSnapshot ?? ensureFreshSnapshot;
    this.resolveProjectedAuth = params.resolveProjectedAuth ?? resolveChatgptAppsProjectedAuth;
    this.appServerInvoker = params.appServerInvoker ?? invokeViaAppServer;
    this.appsConfigWriteGate = createAppServerAppsConfigWriteGate();
    this.requestPluginApproval = params.requestPluginApproval ?? requestOpenClawPluginApproval;
    this.persistConnectorAlwaysAllow =
      params.persistConnectorAlwaysAllow ??
      (async (connectorId) => {
        const configPath = resolveConfigPath(this.env);
        try {
          const rawConfig = JSON.parse(await readFile(configPath, "utf8")) as OpenClawConfig;
          const nextConfig = markConnectorAlwaysAllow(rawConfig, connectorId);
          await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
        } catch (error) {
          const message =
            error instanceof Error ? error.message : error === undefined ? "unknown error" : String(error);
          console.error(
            `Failed to persist openai-apps always_allow for connector ${connectorId} at ${configPath}: ${message}`,
          );
          throw new Error(
            `Failed to persist openai-apps always_allow for connector ${connectorId} at ${configPath}: ${message}`,
          );
        }
      });
    this.alwaysAllowPersistIdleMs = resolveAlwaysAllowPersistIdleMs(this.env);

    this.server = new Server(
      {
        name: MCP_SERVER_NAME,
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {
            listChanged: true,
          },
        },
      },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      if (request.params?.cursor) {
        return { tools: [] };
      }
      return {
        tools: await this.listTools(),
      };
    });

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request): Promise<CallToolResult> =>
        await this.callTool(request.params.name, request.params.arguments),
    );
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    this.toolCache = null;
    this.toolCachePromise = null;
    this.clearAlwaysAllowPersistTimer();
    await this.flushPendingAlwaysAllowConnectors({ scheduleRetry: false });
    this.clearAlwaysAllowPersistTimer();
    await this.server.close();
  }

  async listTools(): Promise<Tool[]> {
    const publicationState = await this.getPublicationState();
    const cache = await this.getToolCache(publicationState);
    return cache.tools;
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    this.activeToolCalls += 1;
    this.recordToolActivity();
    try {
      const publicationState = await this.getPublicationState();
      const cache = await this.getToolCache(publicationState);
      const route = cache.routes.get(name);
      if (!route) {
        throw new Error(`Unknown ChatGPT app tool: ${name}`);
      }

      return await this.appServerInvoker({
        config: publicationState.config,
        route,
        args,
        statePaths: resolveChatgptAppsStatePaths(this.env),
        workspaceDir: this.workspaceDir,
        env: this.env,
        appsConfigWriteGate: this.appsConfigWriteGate,
        handleMcpServerElicitation: async (elicitation) =>
          await this.handleMcpServerElicitation({
            elicitation,
            route,
            config: publicationState.config,
          }),
        resolveProjectedAuth: async () =>
          await this.resolveProjectedAuth({
            config: this.loadOpenClawConfig(),
            agentDir: this.env.OPENCLAW_AGENT_DIR,
          }),
      });
    } finally {
      this.activeToolCalls = Math.max(0, this.activeToolCalls - 1);
      this.recordToolActivity();
      if (this.activeToolCalls === 0 && this.pendingAlwaysAllowConnectorIds.size > 0) {
        await this.flushPendingAlwaysAllowConnectors();
      } else {
        this.scheduleAlwaysAllowPersistence();
      }
    }
  }

  private async getPublicationState(): Promise<PublicationState> {
    const refreshResult = await this.ensureFreshSnapshot({
      loadOpenClawConfig: this.loadOpenClawConfig,
      env: this.env,
      workspaceDir: this.workspaceDir,
      appsConfigWriteGate: this.appsConfigWriteGate,
    });
    if (refreshResult.status !== "ok") {
      throw new Error(refreshResult.message);
    }

    return {
      config: refreshResult.config,
      snapshot: refreshResult.snapshot,
    };
  }

  private async getToolCache(publicationState: PublicationState): Promise<BridgeToolCache> {
    const snapshotKey = `snapshot:${computeSnapshotKey(publicationState.snapshot)}:${hashChatgptAppsConfig(publicationState.config)}`;
    if (this.toolCache?.snapshotKey === snapshotKey) {
      return this.toolCache;
    }
    if (this.toolCachePromise) {
      return await this.toolCachePromise;
    }

    this.toolCachePromise = this.buildToolCacheFromSnapshot(
      publicationState.snapshot,
      publicationState.config,
    );
    try {
      this.toolCache = await this.toolCachePromise;
      return this.toolCache;
    } finally {
      this.toolCachePromise = null;
    }
  }

  private async buildToolCacheFromSnapshot(
    snapshot: PersistedConnectorSnapshot,
    config: ReturnType<typeof resolveChatgptAppsConfig>,
  ): Promise<BridgeToolCache> {
    const allowedConnectorIds = buildAllowedConnectorIds({
      connectors: snapshot.connectors,
      configuredConnectors: config.connectors,
    });
    const routes = new Map<string, BridgeRoute>();
    const tools: Tool[] = [];

    if (allowedConnectorIds.size === 0) {
      return {
        snapshotKey: `snapshot:${computeSnapshotKey(snapshot)}:${hashChatgptAppsConfig(config)}`,
        tools,
        routes,
      };
    }

    const appRoutes = buildAppRouteByConnectorId(snapshot.connectors);
    const connectorById = new Map<string, PersistedConnectorRecord>();
    for (const connector of snapshot.connectors) {
      const validatedConnector = assertValidPersistedConnectorRecord(connector);
      if (connectorById.has(validatedConnector.connectorId)) {
        throw new Error(
          `Duplicate connector snapshot record for connector: ${validatedConnector.connectorId}`,
        );
      }
      connectorById.set(validatedConnector.connectorId, validatedConnector);
    }

    for (const connectorId of [...allowedConnectorIds].sort()) {
      const route = appRoutes.get(connectorId);
      if (!route) {
        throw new Error(`Missing connector snapshot record for connector: ${connectorId}`);
      }
      const connector = connectorById.get(connectorId);
      if (!connector) {
        throw new Error(`Missing connector snapshot metadata for connector: ${connectorId}`);
      }
      const tool = buildPublishedTool(route, connector);
      tools.push(tool);
      routes.set(tool.name, route);
    }

    return {
      snapshotKey: `snapshot:${computeSnapshotKey(snapshot)}:${hashChatgptAppsConfig(config)}`,
      tools,
      routes,
    };
  }

  private async handleMcpServerElicitation(params: {
    elicitation: McpServerElicitationRequestParams;
    route: BridgeRoute;
    config: ReturnType<typeof resolveChatgptAppsConfig>;
  }) {
    if (
      this.runtimeAlwaysAllowConnectorIds.has(params.route.connectorId) ||
      isConnectorAlwaysAllowed(params.config, params.route.connectorId)
    ) {
      return {
        action: "accept",
        content: {},
        _meta: null,
      } as const;
    }

    const decision = await this.requestPluginApproval(
      buildDestructiveActionApprovalRequest({
        elicitation: params.elicitation,
        route: params.route,
      }),
    );

    if (decision !== "allow-once" && decision !== "allow-always") {
      return {
        action: "decline",
        content: null,
        _meta: null,
      } as const;
    }

    if (decision === "allow-always") {
      this.runtimeAlwaysAllowConnectorIds.add(params.route.connectorId);
      this.pendingAlwaysAllowConnectorIds.add(params.route.connectorId);
      this.alwaysAllowPersistFailureCount = 0;
      this.scheduleAlwaysAllowPersistence();
    }

    return {
      action: "accept",
      content: {},
      _meta: null,
    } as const;
  }

  private recordToolActivity(): void {
    this.lastToolActivityAtMs = Date.now();
  }

  private clearAlwaysAllowPersistTimer(): void {
    if (this.alwaysAllowPersistTimer) {
      clearTimeout(this.alwaysAllowPersistTimer);
      this.alwaysAllowPersistTimer = null;
    }
  }

  private scheduleAlwaysAllowPersistence(delayOverrideMs?: number): void {
    if (this.pendingAlwaysAllowConnectorIds.size === 0) {
      return;
    }
    this.clearAlwaysAllowPersistTimer();

    const idleForMs = Date.now() - this.lastToolActivityAtMs;
    const delayMs = Math.max(
      0,
      delayOverrideMs ??
        (this.activeToolCalls > 0
          ? this.alwaysAllowPersistIdleMs
          : Math.max(0, this.alwaysAllowPersistIdleMs - idleForMs)),
    );

    this.alwaysAllowPersistTimer = setTimeout(() => {
      this.alwaysAllowPersistTimer = null;
      const idleForMs = Date.now() - this.lastToolActivityAtMs;
      if (this.activeToolCalls > 0 || idleForMs < this.alwaysAllowPersistIdleMs) {
        this.scheduleAlwaysAllowPersistence();
        return;
      }
      void this.flushPendingAlwaysAllowConnectors();
    }, delayMs);
  }

  private async flushPendingAlwaysAllowConnectors(
    params: { scheduleRetry?: boolean } = { scheduleRetry: true },
  ): Promise<boolean> {
    this.clearAlwaysAllowPersistTimer();
    const connectorIds = [...this.pendingAlwaysAllowConnectorIds];
    if (connectorIds.length === 0) {
      this.alwaysAllowPersistFailureCount = 0;
      return true;
    }
    this.pendingAlwaysAllowConnectorIds.clear();

    const failedConnectorIds: string[] = [];
    for (const connectorId of connectorIds) {
      try {
        await this.persistConnectorAlwaysAllow(connectorId);
      } catch {
        failedConnectorIds.push(connectorId);
      }
    }

    for (const connectorId of failedConnectorIds) {
      this.pendingAlwaysAllowConnectorIds.add(connectorId);
    }
    if (failedConnectorIds.length > 0) {
      this.alwaysAllowPersistFailureCount += 1;
      if (
        params.scheduleRetry === false ||
        this.alwaysAllowPersistFailureCount > DEFAULT_ALWAYS_ALLOW_PERSIST_MAX_RETRIES
      ) {
        console.error(
          `Failed to persist always_allow for connector(s) after ${this.alwaysAllowPersistFailureCount} attempts: ${failedConnectorIds.join(", ")}`,
        );
        return false;
      }
      const retryDelayMs = Math.min(
        this.alwaysAllowPersistIdleMs * 2 ** (this.alwaysAllowPersistFailureCount - 1),
        MAX_ALWAYS_ALLOW_PERSIST_RETRY_DELAY_MS,
      );
      this.scheduleAlwaysAllowPersistence(retryDelayMs);
      return false;
    }
    this.alwaysAllowPersistFailureCount = 0;
    return true;
  }
}

export async function runChatgptAppsMcpBridgeStdio(params: {
  loadOpenClawConfig: () => OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): Promise<void> {
  const bridge = new ChatgptAppsMcpBridge(params);
  await bridge.connect(new StdioServerTransport());
}
