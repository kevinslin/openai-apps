# OpenAI Apps

<img width="256" height="256" alt="OpenAI Apps logo" src="https://github.com/user-attachments/assets/de90cd83-d56d-4b3b-be25-f81d1b8524c6" />

Use [ChatGPT apps](https://chatgpt.com/features/apps/) inside OpenClaw.

## Prerequisites

Requires the [OpenAI provider](https://docs.openclaw.ai/providers/openai#openai) with ChatGPT sign-in.

## Quickstart

1. Clone this repo:

```bash
git clone https://github.com/kevinslin/openai-apps.git
cd openai-apps
```

2. Install the local bundle into OpenClaw:

```bash
openclaw plugins install .
```

3. Enable the bundle in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      ...
      "openai-apps": {
        "enabled": true,
        "config": {
          "allow_destructive_actions": "always",
          "connectors": {
            "*": {
              "enabled": true
            }
          }
        }
      }
    }
  }
}
```

4. Authenticate once with OpenAI Codex:

```bash
openclaw models auth login --provider openai-codex
```

5. Restart the OpenClaw gateway so plugin config changes are loaded.
6. Open your normal OpenClaw chat/TUI session and issue an app-backed request (examples in `Usage` below).

## Usage

```text
summarize my recent emails
```
<img width="2026" height="678" alt="CleanShot 2026-03-30 at 18 38 20@2x" src="https://github.com/user-attachments/assets/24141007-7c1c-4e4a-9123-2fe8fd28f9b4" />

```text
add a calendar event reminding me to walk my gerbil tomorrow at 7am for 30 minutes
```
<img width="2192" height="340" alt="CleanShot 2026-03-30 at 18 39 50@2x" src="https://github.com/user-attachments/assets/5fba2827-016b-4353-bc53-a0c5375b3b5c" />


## Configuration

All bundle config lives under `plugins.entries["openai-apps"].config`.


- `allow_destructive_actions`: Controls destructive app-action elicitations. Use `"always"` to auto-accept, `"on-request"` to prompt through the MCP client when supported, or `"never"` to auto-decline. Defaults to `"never"`.
- `connectors`: Per-app enablement map. Use explicit connector ids like `gmail`, `linear`, or `google_calendar`.
- `connectors["*"]`: Enables all accessible ChatGPT apps, with explicit connector entries able to disable individual apps.
- `appServer.command` / `appServer.args`: Override how the bundle launches `codex app-server`.

Example with one explicitly enabled connector:

```json
{
  "plugins": {
    "entries": {
      "openai": {
        "enabled": true
      },
      "openai-apps": {
        "enabled": true,
        "config": {
          "allow_destructive_actions": "never",
          "connectors": {
            "gmail": {
              "enabled": true
            }
          }
        }
      }
    }
  }
}
```

### Wildcard Configuration

To enable all accessible ChatGPT apps, use `*`:

```json
{
  "plugins": {
    "entries": {
      "openai": {
        "enabled": true
      },
      "openai-apps": {
        "enabled": true,
        "config": {
          "allow_destructive_actions": "never",
          "connectors": {
            "*": {
              "enabled": true
            }
          }
        }
      }
    }
  }
}
```

You can combine wildcard enablement with explicit disables:

```json
{
  "plugins": {
    "entries": {
      "openai-apps": {
        "enabled": true,
        "config": {
          "allow_destructive_actions": "never",
          "connectors": {
            "*": {
              "enabled": true
            },
            "slack": {
              "enabled": false
            }
          }
        }
      }
    }
  }
}
```

## Limitations

- Currently, destructive actions do not support on-demand elicitation (dynamic permission prompts). The OpenClaw PI MCP client does not currently support MCP [elicitations](https://modelcontextprotocol.io/specification/draft/client/elicitation#capabilities).


## Runtime State

The bundle keeps its runtime state under `plugin-runtimes/openai-apps/`.

- `codex-home/`: shared `CODEX_HOME` used for both snapshot refresh and per-tool invocation
- `connectors.snapshot.json`: persisted connector records derived from `app/list`
- `refresh-debug.json`: last refresh result/debug payload written by the bundle

Both refresh and invocation launch `codex app-server` with the same bundle-owned `codex-home`. Invocation still starts a fresh app-server thread for every tool call, but it now rewrites the derived `apps` config into the app-server-managed config inside that shared home before starting the turn instead of using a temporary invocation-only home.

## Snapshot Shape

The persisted snapshot under `plugin-runtimes/openai-apps/connectors.snapshot.json` stores
connector-level records derived from `app/list`. It does not persist raw
`inventory` or any status payload.

Example:

```json
{
  "version": 2,
  "fetchedAt": "2026-03-30T18:00:00.000Z",
  "projectedAt": "2026-03-30T18:00:00.000Z",
  "accountId": "acct_123",
  "authIdentityKey": "user@example.com",
  "connectors": [
    {
      "connectorId": "gmail",
      "appId": "asdk_app_gmail",
      "appName": "Gmail",
      "publishedName": "chatgpt_app_gmail",
      "appInvocationToken": "gmail",
      "description": "Read and send Gmail messages.",
      "pluginDisplayNames": ["Gmail"],
      "isAccessible": true,
      "isEnabled": true
    }
  ]
}
```

## Internals

This bundle:

- publishes one local MCP tool per enabled ChatGPT app connector
- uses `codex app-server` as the single authority for both tool publication and invocation
- reads OpenClaw-rooted `openai-codex` auth and projects it into the spawned app-server session

Published tool names use the `chatgpt_app_<connectorId>` namespace. Each tool accepts a single natural-language `request` string and executes the app on a fresh app-server thread.

For more information on plugin internal logic, see [flows](./docs/flows/index.md).

## Appendix

### Calls to App Server

Setting the developer message

```js
[
  {
    approvalPolicy: {
      granular: {
        sandbox_approval: false,
        rules: false,
        skill_approval: false,
        request_permissions: true,
        mcp_elicitations: true,
      },
    },
    developerInstructions:
      'You are servicing one OpenClaw connector tool call for Gmail. Use the app mentioned in the user input instead of browsing or relying on unrelated tools. Do not use browser, shell, file, web, image, memory, or unrelated tools. Do not ask follow-up questions. Do not fabricate success. Return only JSON matching the schema {"status":"success|failure","result":"string","error":"string"}.',
    ephemeral: false,
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  },
];
```

Example call

```js
[
  {
    text: "$gmail Summarize my recent emails",
    text_elements: [],
    type: "text",
  },
  {
    name: "Gmail",
    path: "app://asdk_app_gmail",
    type: "mention",
  },
];
```
