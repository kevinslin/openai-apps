import { appendFileSync } from "node:fs";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CodexAppServerClient,
  type ServerRequestContext,
  type protocol,
} from "codex-app-server-sdk";
import {
  writeDerivedAppsConfig,
  type AppServerAppsConfigWriteGate,
} from "./app-server-apps-config.js";
import { resolveAppServerCommand } from "./app-server-command.js";
import type { ChatgptAppsResolvedAuth } from "./auth-projector.js";
import { ensureBundledCodexHome } from "./codex-home-bootstrap.js";
import type { ChatgptAppsConfig, AllowDestructiveActionsMode } from "./config.js";
import type { ChatgptAppsStatePaths } from "./state-paths.js";

type ConfigValueWriteParams = protocol.v2.ConfigValueWriteParams;
type ConfigWriteResponse = protocol.v2.ConfigWriteResponse;
type GetAuthStatusResponse = protocol.GetAuthStatusResponse;
type GetAccountResponse = protocol.v2.GetAccountResponse;
type LoginAccountParams = protocol.v2.LoginAccountParams;
type LoginAccountResponse = protocol.v2.LoginAccountResponse;
type McpServerElicitationRequestParams = protocol.v2.McpServerElicitationRequestParams;
type McpServerElicitationRequestResponse = protocol.v2.McpServerElicitationRequestResponse;
type ToolRequestUserInputParams = protocol.v2.ToolRequestUserInputParams;
type ToolRequestUserInputQuestion = protocol.v2.ToolRequestUserInputQuestion;
type ToolRequestUserInputResponse = protocol.v2.ToolRequestUserInputResponse;
type ThreadReadResponse = protocol.v2.ThreadReadResponse;
type ThreadStartResponse = protocol.v2.ThreadStartResponse;
type TurnCompletedNotification = protocol.v2.TurnCompletedNotification;
type TurnStartResponse = protocol.v2.TurnStartResponse;
type ThreadStartParams = protocol.v2.ThreadStartParams;
type TurnStartParams = protocol.v2.TurnStartParams;
type UserInput = protocol.v2.UserInput;

const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const BUNDLED_CODEX_CONFIG_OVERRIDES = ["analytics.enabled=false"];
const APP_INVOCATION_APPROVAL_POLICY: NonNullable<ThreadStartParams["approvalPolicy"]> = {
  granular: {
    sandbox_approval: false,
    rules: false,
    skill_approval: false,
    request_permissions: true,
    mcp_elicitations: true,
  },
};
const CONNECTOR_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "result", "error"],
  properties: {
    status: {
      type: "string",
      enum: ["success", "failure"],
    },
    result: {
      type: "string",
    },
    error: {
      type: "string",
    },
  },
} as const;

function resolveConversationSessionId(env: NodeJS.ProcessEnv | undefined): string | null {
  for (const candidate of [
    env?.OPENCLAW_SESSION_ID,
    env?.OPENCLAW_CONVERSATION_ID,
    env?.OPENCLAW_SESSION_KEY,
  ]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function serializeDebugValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function resolveTurnTimeoutMs(env: NodeJS.ProcessEnv | undefined): number {
  const rawValue = env?.OPENCLAW_OPENAI_APPS_TURN_TIMEOUT_MS?.trim();
  if (!rawValue) {
    return DEFAULT_TURN_TIMEOUT_MS;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TURN_TIMEOUT_MS;
  }

  return Math.floor(parsed);
}

function writeDebugLog(
  env: NodeJS.ProcessEnv | undefined,
  message: string,
  debugRootDir?: string,
): void {
  const conversationSessionId = resolveConversationSessionId(env);
  const context = conversationSessionId ? ` conversationSessionId=${conversationSessionId}` : "";
  const line = `[openai-apps] ${new Date().toISOString()}${context} ${message}\n`;
  if (env?.OPENCLAW_OPENAI_APPS_DEBUG === "1") {
    process.stderr.write(line);
  }
  if (!debugRootDir) {
    return;
  }
  try {
    appendFileSync(path.join(debugRootDir, "invocation-debug.log"), line);
  } catch {
    // Best effort only.
  }
}

export type AppServerInvocationRoute = {
  connectorId: string;
  appId: string;
  publishedName: string;
  appName: string;
  appInvocationToken: string;
};

type ProjectedAuthResolver = () => Promise<ChatgptAppsResolvedAuth>;

export type AppServerInvocationClient = {
  initializeSession(): Promise<unknown>;
  handleChatgptAuthTokensRefresh(
    handler: () =>
      | {
          accessToken: string;
          chatgptAccountId: string;
          chatgptPlanType?: string | null;
        }
      | Promise<{
          accessToken: string;
          chatgptAccountId: string;
          chatgptPlanType?: string | null;
        }>,
  ): () => void;
  loginAccount(params: LoginAccountParams): Promise<LoginAccountResponse>;
  readAccount(params: { refreshToken: boolean }): Promise<GetAccountResponse>;
  getAuthStatus(params: {
    includeToken: boolean | null;
    refreshToken: boolean | null;
  }): Promise<GetAuthStatusResponse>;
  writeConfigValue(params: ConfigValueWriteParams): Promise<ConfigWriteResponse>;
  startThread(params: ThreadStartParams): Promise<ThreadStartResponse>;
  runTurn(
    params: TurnStartParams,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{
    start: TurnStartResponse;
    completed: TurnCompletedNotification;
  }>;
  readThread(params: { threadId: string; includeTurns: boolean }): Promise<ThreadReadResponse>;
  handleServerRequest<M extends protocol.ServerRequest["method"]>(
    method: M,
    handler: (context: ServerRequestContext<M>) => Promise<unknown> | unknown,
  ): () => void;
  onServerRequest?(listener: (context: ServerRequestContext) => Promise<void> | void): () => void;
  onStderr?(listener: (chunk: string) => void): () => void;
  onClose?(
    listener: (event: {
      code: number | null;
      signal: NodeJS.Signals | null;
      hadError: boolean;
    }) => void,
  ): () => void;
  close(): Promise<void>;
};

type AppServerInvocationClientFactoryParams = {
  command: string;
  args: string[];
  configOverrides: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
};

export type AppServerToolInvoker = (params: {
  config: ChatgptAppsConfig;
  route: AppServerInvocationRoute;
  args: Record<string, unknown> | undefined;
  statePaths: ChatgptAppsStatePaths;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  resolveProjectedAuth: ProjectedAuthResolver;
  handleMcpServerElicitation?: (
    params: McpServerElicitationRequestParams,
  ) => Promise<McpServerElicitationRequestResponse>;
  appsConfigWriteGate?: AppServerAppsConfigWriteGate;
  clientFactory?: (
    params: AppServerInvocationClientFactoryParams,
  ) => Promise<AppServerInvocationClient>;
}) => Promise<CallToolResult>;

function toLoginParams(
  auth: Extract<ChatgptAppsResolvedAuth, { status: "ok" }>,
): LoginAccountParams {
  return {
    type: "chatgptAuthTokens",
    accessToken: auth.accessToken,
    chatgptAccountId: auth.accountId,
    chatgptPlanType: auth.planType,
  };
}

function readInvocationRequest(args: Record<string, unknown> | undefined): string {
  const request = typeof args?.request === "string" ? args.request.trim() : "";
  if (!request) {
    throw new Error('ChatGPT app tools require a non-empty "request" string');
  }
  return request;
}

function buildInvocationInput(
  route: AppServerInvocationRoute,
  args: Record<string, unknown> | undefined,
): UserInput[] {
  const request = readInvocationRequest(args);
  return [
    {
      type: "text",
      text: `$${route.appInvocationToken} ${request}`,
      text_elements: [],
    },
    {
      type: "mention",
      name: route.appName,
      path: `app://${route.appId}`,
    } as UserInput,
  ];
}

function buildDeveloperInstructions(route: AppServerInvocationRoute): string {
  return [
    `You are servicing one OpenClaw connector tool call for ${route.appName}.`,
    "Use the app mentioned in the user input instead of browsing or relying on unrelated tools.",
    "Do not use browser, shell, file, web, image, memory, or unrelated tools.",
    "Do not ask follow-up questions.",
    "Do not fabricate success.",
    'Return only JSON matching the schema {"status":"success|failure","result":"string","error":"string"}.',
  ]
    .filter(Boolean)
    .join("\n");
}

function extractTurnText(response: ThreadReadResponse, turnId: string): string | null {
  const turn = response.thread.turns.find((entry) => entry.id === turnId);
  if (!turn) {
    return null;
  }

  const lastAgentMessage = [...turn.items]
    .reverse()
    .find((item) => item.type === "agentMessage" && item.text.trim().length > 0);
  if (lastAgentMessage?.type === "agentMessage") {
    const trimmed = lastAgentMessage.text.trim();
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { status?: unknown }).status === "string"
      ) {
        const status = (parsed as { status: string }).status;
        const result = (parsed as { result?: unknown }).result;
        const error = (parsed as { error?: unknown }).error;
        if (status === "success" && typeof result === "string" && result.trim().length > 0) {
          return result;
        }
        if (typeof error === "string" && error.trim().length > 0) {
          return error;
        }
      }
    } catch {
      // Plain-text output is still acceptable.
    }
    return lastAgentMessage.text;
  }

  const lastToolResult = [...turn.items]
    .reverse()
    .find((item) => item.type === "mcpToolCall" && item.result !== null);
  if (lastToolResult?.type === "mcpToolCall") {
    const result = lastToolResult.result;
    if (!result) {
      return null;
    }
    if (result.structuredContent !== null) {
      return JSON.stringify(result.structuredContent, null, 2);
    }
    if (result.content.length > 0) {
      return JSON.stringify(result.content, null, 2);
    }
  }

  return null;
}

function buildApprovalError(prefix: string, detail?: string | null): Error {
  return new Error(detail ? `${prefix}: ${detail}` : prefix);
}

function buildUnsupportedServerRequestError(message: string | null | undefined): Error | null {
  const trimmed = message?.trim();
  if (!trimmed) {
    return null;
  }

  const match =
    trimmed.match(/(?:unsupported|unhandled).*server request[:\s]+([a-z0-9_./-]+)/i) ??
    trimmed.match(/\b(item\/tool\/call)\b/i);
  const method = match?.[1]?.trim();
  if (!method) {
    return null;
  }

  return new Error(`App invocation requested unsupported server request: ${method}`);
}

function buildAcceptedMcpServerElicitationResponse(): McpServerElicitationRequestResponse {
  return {
    action: "accept",
    content: {},
    _meta: null,
  };
}

function buildDeclinedMcpServerElicitationResponse(): McpServerElicitationRequestResponse {
  return {
    action: "decline",
    content: null,
    _meta: null,
  };
}

function resolveConnectorNameFromMeta(
  meta: unknown,
  fallback: string | null = null,
): string | null {
  if (
    typeof meta === "object" &&
    meta !== null &&
    typeof (meta as { connector_name?: unknown }).connector_name === "string"
  ) {
    return ((meta as { connector_name: string }).connector_name || "").trim() || null;
  }

  return fallback?.trim() || null;
}

function resolveElicitationConnectorName(
  request: McpServerElicitationRequestParams,
): string | null {
  return resolveConnectorNameFromMeta(request._meta, request.serverName);
}

function buildAutoDeclinedDestructiveActionMessageForConnector(
  connectorName: string | null,
): string {
  const suffix = connectorName ? ` for ${connectorName}` : "";
  return `OpenClaw is configured with allowDestructiveActions=never, so I can't perform write actions${suffix}.`;
}

function buildAutoDeclinedDestructiveActionMessage(
  request: McpServerElicitationRequestParams,
): string {
  return buildAutoDeclinedDestructiveActionMessageForConnector(
    resolveElicitationConnectorName(request),
  );
}

async function resolveMcpServerElicitationResponse(params: {
  mode: AllowDestructiveActionsMode;
  request: McpServerElicitationRequestParams;
  handleMcpServerElicitation?: (
    params: McpServerElicitationRequestParams,
  ) => Promise<McpServerElicitationRequestResponse>;
}): Promise<McpServerElicitationRequestResponse> {
  if (params.mode === "always") {
    return buildAcceptedMcpServerElicitationResponse();
  }
  if (params.mode === "never") {
    return buildDeclinedMcpServerElicitationResponse();
  }
  if (!params.handleMcpServerElicitation) {
    return buildDeclinedMcpServerElicitationResponse();
  }
  return await params.handleMcpServerElicitation(params.request);
}

function pickToolRequestUserInputOptionLabel(params: {
  question: ToolRequestUserInputQuestion;
  mode: "always" | "never";
}): string {
  const options = params.question.options ?? [];
  const preferredNeedles =
    params.mode === "always"
      ? ["allow", "accept", "continue", "approve", "yes"]
      : ["cancel", "decline", "reject", "deny", "no"];
  const labels = options.map((option) => ({
    label: option.label,
    normalized: option.label.trim().toLowerCase(),
  }));

  const exactMatch = labels.find((option) => preferredNeedles.includes(option.normalized));
  if (exactMatch) {
    return exactMatch.label;
  }

  const partialMatch = labels.find((option) =>
    preferredNeedles.some((needle) => option.normalized.includes(needle)),
  );
  if (partialMatch) {
    return partialMatch.label;
  }

  if (options.length > 0) {
    return params.mode === "always" ? options[0].label : options[options.length - 1].label;
  }

  return params.mode === "always" ? "Allow" : "Cancel";
}

function buildToolRequestUserInputResponse(params: {
  mode: AllowDestructiveActionsMode;
  request: ToolRequestUserInputParams;
}): ToolRequestUserInputResponse {
  if (params.mode === "on-request") {
    // TODO: Route requestUserInput approvals through OpenClaw's interactive approval UX.
    throw buildApprovalError("App invocation requested interactive tool input");
  }

  const answerMode = params.mode === "always" ? "always" : "never";
  return {
    answers: Object.fromEntries(
      params.request.questions.map((question) => [
        question.id,
        {
          answers: [pickToolRequestUserInputOptionLabel({ question, mode: answerMode })],
        },
      ]),
    ),
  };
}

export const invokeViaAppServer: AppServerToolInvoker = async (params) => {
  const env = params.env ?? process.env;
  const turnTimeoutMs = resolveTurnTimeoutMs(env);
  writeDebugLog(
    env,
    `invoke start connector=${params.route.connectorId} published=${params.route.publishedName}`,
    params.statePaths.rootDir,
  );

  const auth = await params.resolveProjectedAuth();
  if (auth.status !== "ok") {
    throw new Error(auth.message);
  }
  writeDebugLog(env, "app-server auth resolved", params.statePaths.rootDir);

  const resolvedCommand = await resolveAppServerCommand({
    command: params.config.appServer.command,
    env,
  });
  writeDebugLog(
    env,
    `app-server command resolved command=${resolvedCommand} args=${params.config.appServer.args.join(" ")}`,
    params.statePaths.rootDir,
  );

  await ensureBundledCodexHome({
    codexHomeDir: params.statePaths.codexHomeDir,
  });
  const clientFactory =
    params.clientFactory ??
    (async (factoryParams) => {
      const client = await CodexAppServerClient.spawn({
        bin: factoryParams.command,
        args: factoryParams.args,
        configOverrides: factoryParams.configOverrides,
        cwd: factoryParams.cwd,
        env: factoryParams.env,
        disableFeatures: ["plugins"],
        analyticsDefaultEnabled: false,
        unhandledServerRequestStrategy: "manual",
      });
      return {
        initializeSession: () => client.initializeSession(),
        handleChatgptAuthTokensRefresh: (handler) =>
          client.handleChatgptAuthTokensRefresh(async () => {
            const response = await handler();
            return {
              ...response,
              chatgptPlanType: response.chatgptPlanType ?? null,
            };
          }),
        loginAccount: (loginParams) => client.loginAccount(loginParams),
        readAccount: (readParams) => client.readAccount(readParams),
        getAuthStatus: (statusParams) => client.getAuthStatus(statusParams),
        writeConfigValue: (writeParams) => client.writeConfigValue(writeParams),
        startThread: (startParams) => client.startThread(startParams),
        runTurn: (turnParams, options) => client.runTurn(turnParams, options),
        readThread: (readParams) => client.readThread(readParams),
        handleServerRequest: (method, handler) => client.handleServerRequest(method, handler),
        onServerRequest: (listener) => client.onServerRequest(listener),
        onStderr: (listener) => client.onStderr(listener),
        onClose: (listener) => client.onClose(listener),
        close: async () => {
          await client.close();
        },
      } satisfies AppServerInvocationClient;
    });

  const client = await clientFactory({
    command: resolvedCommand,
    args: params.config.appServer.args,
    configOverrides: BUNDLED_CODEX_CONFIG_OVERRIDES,
    cwd: params.workspaceDir,
    env: {
      ...env,
      CODEX_HOME: params.statePaths.codexHomeDir,
      ANALYTICS_DEFAULT_ENABLED: "false",
    },
  });

  let unsubscribeRefresh: (() => void) | null = null;
  const unsubscribeHandlers: Array<() => void> = [];
  const unsubscribeDebugListeners: Array<() => void> = [];
  try {
    if (client.onStderr) {
      unsubscribeDebugListeners.push(
        client.onStderr((chunk) => {
          writeDebugLog(env, `app-server stderr ${chunk.trimEnd()}`, params.statePaths.rootDir);
        }),
      );
    }
    if (client.onClose) {
      unsubscribeDebugListeners.push(
        client.onClose((event) => {
          writeDebugLog(
            env,
            `app-server close code=${String(event.code)} signal=${String(event.signal)} hadError=${String(event.hadError)}`,
            params.statePaths.rootDir,
          );
        }),
      );
    }

    writeDebugLog(env, "app-server initialize start", params.statePaths.rootDir);
    await client.initializeSession();
    writeDebugLog(env, "app-server initialize done", params.statePaths.rootDir);
    unsubscribeRefresh = client.handleChatgptAuthTokensRefresh(async () => {
      const refreshed = await params.resolveProjectedAuth();
      if (refreshed.status !== "ok") {
        throw new Error(refreshed.message);
      }
      return {
        accessToken: refreshed.accessToken,
        chatgptAccountId: refreshed.accountId,
        chatgptPlanType: refreshed.planType,
      };
    });

    writeDebugLog(env, "app-server login start", params.statePaths.rootDir);
    await client.loginAccount(toLoginParams(auth));
    writeDebugLog(env, "app-server login done", params.statePaths.rootDir);
    writeDebugLog(env, "app-server config ensure start", params.statePaths.rootDir);
    const wroteAppsConfig = await writeDerivedAppsConfig({
      config: params.config,
      writeConfigValue: (writeParams) => client.writeConfigValue(writeParams),
      appsConfigWriteGate: params.appsConfigWriteGate,
    });
    writeDebugLog(
      env,
      wroteAppsConfig ? "app-server config ensure wrote" : "app-server config ensure reused",
      params.statePaths.rootDir,
    );

    let serverRequestError: Error | null = null;
    let autoDeclinedDestructiveActionMessage: string | null = null;
    const handledServerRequests = new Set<string>([
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "account/chatgptAuthTokens/refresh",
    ]);
    const registerFailureHandler = <M extends protocol.ServerRequest["method"]>(
      method: M,
      buildError: (context: ServerRequestContext<M>) => Error,
    ) => {
      unsubscribeHandlers.push(
        client.handleServerRequest(method, async (context) => {
          const error = buildError(context);
          serverRequestError ??= error;
          throw error;
        }),
      );
    };

    unsubscribeHandlers.push(
      client.handleServerRequest("item/permissions/requestApproval", async (context) => {
        return {
          permissions: {
            ...(context.request.params.permissions.network
              ? { network: context.request.params.permissions.network }
              : {}),
            ...(context.request.params.permissions.fileSystem
              ? { fileSystem: context.request.params.permissions.fileSystem }
              : {}),
          },
          scope: "turn",
        };
      }),
    );
    unsubscribeHandlers.push(
      client.handleServerRequest("mcpServer/elicitation/request", async (context) => {
        const response = await resolveMcpServerElicitationResponse({
          mode: params.config.allowDestructiveActions,
          request: context.request.params,
          handleMcpServerElicitation: params.handleMcpServerElicitation,
        });
        if (params.config.allowDestructiveActions === "never" && response.action === "decline") {
          autoDeclinedDestructiveActionMessage ??= buildAutoDeclinedDestructiveActionMessage(
            context.request.params,
          );
        }
        writeDebugLog(
          env,
          `app-server elicitation resolved action=${response.action}`,
          params.statePaths.rootDir,
        );
        return response;
      }),
    );
    unsubscribeHandlers.push(
      client.handleServerRequest("item/tool/requestUserInput", async (context) => {
        const response = buildToolRequestUserInputResponse({
          mode: params.config.allowDestructiveActions,
          request: context.request.params,
        });
        if (params.config.allowDestructiveActions === "never") {
          autoDeclinedDestructiveActionMessage ??=
            buildAutoDeclinedDestructiveActionMessageForConnector(params.route.appName);
        }
        writeDebugLog(
          env,
          `app-server requestUserInput resolved answers=${serializeDebugValue(response.answers)}`,
          params.statePaths.rootDir,
        );
        return response;
      }),
    );
    registerFailureHandler("item/commandExecution/requestApproval", () =>
      buildApprovalError("App invocation requested command approval"),
    );
    registerFailureHandler("item/fileChange/requestApproval", () =>
      buildApprovalError("App invocation requested file change approval"),
    );
    if (client.onServerRequest) {
      unsubscribeHandlers.push(
        client.onServerRequest(async (context) => {
          writeDebugLog(
            env,
            `app-server request method=${context.request.method} params=${serializeDebugValue(context.request.params)}`,
            params.statePaths.rootDir,
          );
          if (handledServerRequests.has(context.request.method)) {
            return;
          }
          const error =
            buildUnsupportedServerRequestError(
              `Unhandled server request: ${context.request.method}`,
            ) ?? new Error(`Unhandled server request: ${context.request.method}`);
          serverRequestError ??= error;
          await context.respondError(error.message);
        }),
      );
    }

    let invocationInput: UserInput[];
    try {
      invocationInput = buildInvocationInput(params.route, params.args);
      writeDebugLog(
        env,
        `buildInvocationInput route=${serializeDebugValue(params.route)} args=${serializeDebugValue(params.args)} input=${serializeDebugValue(invocationInput)}`,
        params.statePaths.rootDir,
      );
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      writeDebugLog(
        env,
        `buildInvocationInput failed route=${serializeDebugValue(params.route)} args=${serializeDebugValue(params.args)} error=${serializeDebugValue(normalizedError.message)}`,
        params.statePaths.rootDir,
      );
      throw normalizedError;
    }

    writeDebugLog(env, "app-server thread start request", params.statePaths.rootDir);
    const threadStart = await client.startThread({
      cwd: params.workspaceDir ?? process.cwd(),
      approvalPolicy: APP_INVOCATION_APPROVAL_POLICY,
      developerInstructions: buildDeveloperInstructions(params.route),
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    const threadId = threadStart.thread.id;
    writeDebugLog(env, `app-server thread started threadId=${threadId}`, params.statePaths.rootDir);

    writeDebugLog(env, "app-server turn start", params.statePaths.rootDir);
    const run = await client.runTurn(
      {
        threadId,
        cwd: params.workspaceDir ?? process.cwd(),
        approvalPolicy: APP_INVOCATION_APPROVAL_POLICY,
        outputSchema: CONNECTOR_OUTPUT_SCHEMA as unknown as TurnStartParams["outputSchema"],
        input: invocationInput,
      },
      { timeoutMs: turnTimeoutMs },
    );
    writeDebugLog(
      env,
      `app-server turn completed status=${run.completed.turn.status}`,
      params.statePaths.rootDir,
    );

    if (serverRequestError) {
      throw serverRequestError;
    }
    if (run.completed.turn.status !== "completed") {
      const unsupportedServerRequestError = buildUnsupportedServerRequestError(
        run.completed.turn.error?.message ?? null,
      );
      if (unsupportedServerRequestError) {
        throw unsupportedServerRequestError;
      }
      const message =
        run.completed.turn.error?.message ?? `Turn ended with status ${run.completed.turn.status}`;
      throw new Error(message);
    }

    if (autoDeclinedDestructiveActionMessage) {
      writeDebugLog(
        env,
        "app-server invocation auto-declined destructive action",
        params.statePaths.rootDir,
      );
      return {
        content: [{ type: "text", text: autoDeclinedDestructiveActionMessage }],
      };
    }

    const thread = await client.readThread({
      threadId,
      includeTurns: true,
    });
    const text = extractTurnText(thread, run.start.turn.id);
    if (!text) {
      throw new Error("App invocation completed without a usable final result");
    }

    writeDebugLog(env, "app-server invocation produced final text", params.statePaths.rootDir);
    return {
      content: [{ type: "text", text }],
    };
  } catch (error) {
    const normalizedError =
      buildUnsupportedServerRequestError(error instanceof Error ? error.message : String(error)) ??
      (error instanceof Error ? error : new Error(String(error)));
    const message = normalizedError.stack ?? normalizedError.message;
    writeDebugLog(env, `app-server invoke failed error=${message}`, params.statePaths.rootDir);
    throw normalizedError;
  } finally {
    for (const unsubscribe of unsubscribeDebugListeners) {
      unsubscribe();
    }
    for (const unsubscribe of unsubscribeHandlers) {
      unsubscribe();
    }
    unsubscribeRefresh?.();
    await client.close();
  }
};
