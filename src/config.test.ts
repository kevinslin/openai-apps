import { describe, expect, it } from "vitest";
import {
  buildDerivedAppsConfig,
  hashChatgptAppsConfig,
  isConnectorAlwaysAllowed,
  markConnectorAlwaysAllow,
  resolveChatgptAppsConfig,
} from "./config.js";

describe("resolveChatgptAppsConfig", () => {
  it("applies defaults when openai-apps config is absent", () => {
    expect(resolveChatgptAppsConfig({})).toEqual({
      allowDestructiveActions: "never",
      appServer: {
        command: "codex",
        args: [],
      },
      connectors: {},
    });
  });

  it("normalizes app-server args and connector flags", () => {
    const config = resolveChatgptAppsConfig({
      allow_destructive_actions: "on-request",
      appServer: {
        command: "codex-dev",
        args: ["app-server", "--analytics-default-enabled", "--foo"],
      },
      connectors: {
        Slack: {
          enabled: false,
          always_allow: true,
        },
        Gmail: {},
      },
    });

    expect(config.allowDestructiveActions).toBe("on-request");
    expect(config.appServer).toEqual({
      command: "codex-dev",
      args: ["--foo"],
    });
    expect(config.connectors).toEqual({
      Slack: { enabled: false, alwaysAllow: true },
      Gmail: { enabled: true, alwaysAllow: false },
    });
    expect(isConnectorAlwaysAllowed(config, "slack")).toBe(true);
  });

  it("ignores legacy nested enabled flags", () => {
    expect(
      resolveChatgptAppsConfig({
        enabled: false,
        connectors: {
          gmail: {
            enabled: true,
          },
        },
      }),
    ).toEqual({
      allowDestructiveActions: "never",
      appServer: {
        command: "codex",
        args: [],
      },
      connectors: {
        gmail: { enabled: true, alwaysAllow: false },
      },
    });
  });
});

describe("buildDerivedAppsConfig", () => {
  it("mirrors wildcard and connector enablement into the sidecar config", () => {
    const derived = buildDerivedAppsConfig({
      allowDestructiveActions: "always",
      appServer: { command: "codex", args: [] },
      connectors: {
        "*": { enabled: true, alwaysAllow: false },
        slack: { enabled: false, alwaysAllow: false },
      },
    });

    expect(derived).toEqual({
      _default: {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
      },
      slack: {
        enabled: false,
        destructive_enabled: true,
        open_world_enabled: true,
      },
    });
  });

  it("omits optional null-valued fields from sidecar config entries", () => {
    const derived = buildDerivedAppsConfig({
      allowDestructiveActions: "always",
      appServer: { command: "codex", args: [] },
      connectors: {
        gmail: { enabled: true, alwaysAllow: false },
      },
    });

    expect(derived.gmail).toEqual({
      enabled: true,
      destructive_enabled: true,
      open_world_enabled: true,
    });
    expect("default_tools_approval_mode" in (derived.gmail ?? {})).toBe(false);
    expect("default_tools_enabled" in (derived.gmail ?? {})).toBe(false);
    expect("tools" in (derived.gmail ?? {})).toBe(false);
  });

  it("hashes identical normalized configs stably", () => {
    const first = resolveChatgptAppsConfig({
      connectors: { slack: { enabled: true } },
    });
    const second = resolveChatgptAppsConfig({
      connectors: { slack: {} },
    });

    expect(hashChatgptAppsConfig(first)).toBe(hashChatgptAppsConfig(second));
  });

  it("keeps destructive tools enabled in the sidecar config when configured to never allow them", () => {
    const derived = buildDerivedAppsConfig({
      allowDestructiveActions: "never",
      appServer: { command: "codex", args: [] },
      connectors: {
        "*": { enabled: true, alwaysAllow: false },
        gmail: { enabled: true, alwaysAllow: false },
      },
    });

    expect(derived).toEqual({
      _default: {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
      },
      gmail: {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
      },
    });
  });
});

describe("markConnectorAlwaysAllow", () => {
  it("persists always_allow under the plugin connector config", () => {
    expect(
      markConnectorAlwaysAllow(
        {
          plugins: {
            entries: {
              "openai-apps": {
                config: {
                  connectors: {
                    Slack: { enabled: false },
                  },
                },
              },
            },
          },
        },
        "slack",
      ).plugins?.entries?.["openai-apps"]?.config,
    ).toEqual({
      connectors: {
        Slack: { enabled: false, always_allow: true },
      },
    });
  });
});
