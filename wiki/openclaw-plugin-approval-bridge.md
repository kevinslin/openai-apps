# OpenClaw Plugin Approval Bridge

`openai-apps` supports three destructive-action modes:

- `always`: app-server elicitations are accepted automatically.
- `never`: app-server elicitations are declined automatically.
- `on-request`: app-server elicitations are converted into OpenClaw plugin approval requests.

## Gateway RPC Flow

For `on-request`, the bridge calls:

```ts
plugin.approval.request({
  pluginId: "openai-apps",
  title,
  description,
  severity: "warning",
  toolName: "chatgpt_app_google_calendar",
  timeoutMs: 120_000,
  twoPhase: true
})
```

If the request is accepted for routing, the gateway returns an approval id. The bridge then calls:

```ts
plugin.approval.waitDecision({ id })
```

Valid decisions are:

- `allow-once`: accept this single app-server elicitation.
- `deny`: decline this single app-server elicitation.
- `allow-always`: accept this elicitation and persist an app-specific `always_allow` flag.

## Persistent Always Allow

`allow-always` is persisted in OpenClaw plugin config:

```json
{
  "plugins": {
    "entries": {
      "openai-apps": {
        "config": {
          "allow_destructive_actions": "on-request",
          "connectors": {
            "google_calendar": {
              "enabled": true,
              "always_allow": true
            }
          }
        }
      }
    }
  }
}
```

The bridge also keeps an in-process `always_allow` cache after the user selects `allow-always`. This matters because the MCP server process may have loaded the plugin config before the gateway write completed; the cache makes the next invocation skip the prompt immediately, and the config write makes the behavior survive restart.

Persistence is queued instead of being written inside the elicitation callback. OpenClaw treats changes under `plugins.entries.openai-apps.config` as restart-worthy, so writing synchronously during elicitation can restart the gateway while the app-server write action is still in flight. The runtime cache applies immediately; the durable `always_allow` write runs after the active app-tool call returns.

## Failure Behavior

If the gateway returns no approval route, times out, or returns an unknown decision, the bridge declines the app-server elicitation. This keeps write actions fail-closed unless the user explicitly approved them or configured the app for `always_allow`.
