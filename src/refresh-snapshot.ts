import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { AppServerAppsConfigWriteGate } from "./app-server-apps-config.js";
import { captureAppServerSnapshot, type AppServerRefreshCapture } from "./app-server-session.js";
import type { ChatgptAppsResolvedAuth } from "./auth-projector.js";
import { resolveChatgptAppsProjectedAuth } from "./auth-projector.js";
import { resolveChatgptAppsConfig } from "./config.js";
import { deriveConnectorRecordsFromApps } from "./connector-record.js";
import {
  buildAuthIdentityKey,
  isSnapshotFresh,
  readPersistedSnapshot,
  SNAPSHOT_VERSION,
  writePersistedSnapshot,
  writeRefreshDebug,
  type PersistedConnectorSnapshot,
} from "./snapshot-cache.js";
import { resolveChatgptAppsStatePaths, type ChatgptAppsStatePaths } from "./state-paths.js";

const REFRESH_TIMEOUT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function resolveRefreshTimeoutMs(env: NodeJS.ProcessEnv): number {
  const rawValue = env.OPENCLAW_OPENAI_APPS_REFRESH_TIMEOUT_MS?.trim();
  if (!rawValue) {
    return REFRESH_TIMEOUT_MS;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return REFRESH_TIMEOUT_MS;
  }
  const timeoutMs = Math.floor(parsed);
  if (timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS) {
    return REFRESH_TIMEOUT_MS;
  }
  return timeoutMs;
}

function resolveEffectiveRefreshTimeoutMs(
  refreshTimeoutMs: number | undefined,
  env: NodeJS.ProcessEnv,
): number {
  if (refreshTimeoutMs === undefined) {
    return resolveRefreshTimeoutMs(env);
  }
  if (!Number.isFinite(refreshTimeoutMs)) {
    return resolveRefreshTimeoutMs(env);
  }
  const timeoutMs = Math.floor(refreshTimeoutMs);
  if (timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS) {
    return resolveRefreshTimeoutMs(env);
  }
  return timeoutMs;
}

export type EnsureFreshSnapshotResult =
  | {
      status: "ok";
      source: "cache" | "refresh";
      snapshot: PersistedConnectorSnapshot;
      config: ReturnType<typeof resolveChatgptAppsConfig>;
      openclawConfig: OpenClawConfig;
      statePaths: ChatgptAppsStatePaths;
    }
  | {
      status: "error";
      reason: "auth" | "refresh";
      message: string;
      config: ReturnType<typeof resolveChatgptAppsConfig>;
      openclawConfig: OpenClawConfig;
      statePaths: ChatgptAppsStatePaths;
    };

export async function ensureFreshSnapshot(params: {
  loadOpenClawConfig: () => OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  now?: () => number;
  resolveProjectedAuth?: (params: {
    config: OpenClawConfig;
    agentDir?: string;
  }) => Promise<ChatgptAppsResolvedAuth>;
  captureSnapshot?: (params: {
    config: ReturnType<typeof resolveChatgptAppsConfig>;
    statePaths: ChatgptAppsStatePaths;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    resolveProjectedAuth: () => Promise<ChatgptAppsResolvedAuth>;
    appsConfigWriteGate?: AppServerAppsConfigWriteGate;
    now?: () => number;
  }) => Promise<AppServerRefreshCapture>;
  statePaths?: ChatgptAppsStatePaths;
  refreshTimeoutMs?: number;
  appsConfigWriteGate?: AppServerAppsConfigWriteGate;
}): Promise<EnsureFreshSnapshotResult> {
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now;
  const openclawConfig = params.loadOpenClawConfig();
  const config = resolveChatgptAppsConfig(
    openclawConfig.plugins?.entries?.["openai-apps"]?.config ?? {},
  );
  const statePaths = params.statePaths ?? resolveChatgptAppsStatePaths(env);

  const resolveProjectedAuth =
    params.resolveProjectedAuth ??
    (async (authParams) =>
      await resolveChatgptAppsProjectedAuth({
        config: authParams.config,
        agentDir: authParams.agentDir,
      }));
  const auth = await resolveProjectedAuth({
    config: openclawConfig,
    agentDir: env.OPENCLAW_AGENT_DIR,
  });

  if (auth.status !== "ok") {
    await writeRefreshDebug({
      statePaths,
      debug: {
        updatedAt: new Date(now()).toISOString(),
        status: "failure",
        message: auth.message,
      },
    });
    return {
      status: "error",
      reason: "auth",
      message: auth.message,
      config,
      openclawConfig,
      statePaths,
    };
  }

  const currentSnapshot = await readPersistedSnapshot(statePaths.snapshotPath);
  const freshnessInputs = {
    accountId: auth.accountId,
    authIdentityKey: buildAuthIdentityKey(auth.identity),
  };

  if (
    currentSnapshot &&
    isSnapshotFresh({
      snapshot: currentSnapshot,
      inputs: freshnessInputs,
      now: now(),
    })
  ) {
    await writeRefreshDebug({
      statePaths,
      debug: {
        updatedAt: new Date(now()).toISOString(),
        status: "success",
        source: "cache",
        accountId: auth.accountId,
      },
    });
    return {
      status: "ok",
      source: "cache",
      snapshot: currentSnapshot,
      config,
      openclawConfig,
      statePaths,
    };
  }

  const captureSnapshot =
    params.captureSnapshot ??
    (async (captureParams) =>
      await captureAppServerSnapshot({
        config: captureParams.config,
        statePaths: captureParams.statePaths,
        workspaceDir: captureParams.workspaceDir,
        env: captureParams.env,
        resolveProjectedAuth: async () =>
          await resolveProjectedAuth({
            config: openclawConfig,
            agentDir: env.OPENCLAW_AGENT_DIR,
          }),
        appsConfigWriteGate: captureParams.appsConfigWriteGate,
        now,
      }));

  try {
    const capture = await Promise.race([
      captureSnapshot({
        config,
        statePaths,
        workspaceDir: params.workspaceDir,
        env,
        resolveProjectedAuth: async () =>
          await resolveProjectedAuth({
            config: openclawConfig,
            agentDir: env.OPENCLAW_AGENT_DIR,
          }),
        appsConfigWriteGate: params.appsConfigWriteGate,
        now,
      }),
      new Promise<AppServerRefreshCapture>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Timed out refreshing ChatGPT apps snapshot"));
        }, resolveEffectiveRefreshTimeoutMs(params.refreshTimeoutMs, env));
      }),
    ]);
    const nextSnapshot: PersistedConnectorSnapshot = {
      version: SNAPSHOT_VERSION,
      fetchedAt: new Date(now()).toISOString(),
      projectedAt: capture.projectedAt,
      accountId: auth.accountId,
      authIdentityKey: buildAuthIdentityKey(auth.identity),
      connectors: deriveConnectorRecordsFromApps(capture.apps),
    };
    await writePersistedSnapshot({
      statePaths,
      snapshot: nextSnapshot,
    });
    await writeRefreshDebug({
      statePaths,
      debug: {
        updatedAt: new Date(now()).toISOString(),
        status: "success",
        source: "refresh",
        accountId: auth.accountId,
      },
    });
    return {
      status: "ok",
      source: "refresh",
      snapshot: nextSnapshot,
      config,
      openclawConfig,
      statePaths,
    };
  } catch (error) {
    await writeRefreshDebug({
      statePaths,
      debug: {
        updatedAt: new Date(now()).toISOString(),
        status: "failure",
        message: error instanceof Error ? error.message : String(error),
        accountId: auth.accountId,
      },
    });
    return {
      status: "error",
      reason: "refresh",
      message: error instanceof Error ? error.message : String(error),
      config,
      openclawConfig,
      statePaths,
    };
  }
}
