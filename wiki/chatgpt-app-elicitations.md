# ChatGPT App Elicitations

ChatGPT app-server write actions can issue `mcpServer/elicitation/request` server requests during a tool invocation. OpenClaw's MCP client does not expose app-server elicitations to the user, so `openai-apps` intercepts these requests and maps them onto OpenClaw plugin approvals.

## Request Shape

The app-server SDK type is `protocol.v2.McpServerElicitationRequestParams`.

Common fields:

- `threadId`: app-server thread id
- `turnId`: nullable app-server turn id
- `serverName`: app connector/server identifier such as `google_calendar`
- `message`: human-facing approval prompt
- `_meta`: connector-specific metadata or `null`

Form-mode write elicitations use:

```ts
{
  threadId: "thr_123",
  turnId: "turn_123",
  serverName: "google_calendar",
  mode: "form",
  message: "Confirm event creation.",
  requestedSchema: { type: "object", properties: {} },
  _meta: {
    codex_approval_kind: "mcp_tool_call",
    connector_name: "Google Calendar",
    tool_title: "create_event",
    tool_params: {
      title: "OpenClaw Gerbil Elicitation 123"
    }
  }
}
```

URL-mode elicitations use:

```ts
{
  threadId: "thr_123",
  turnId: null,
  serverName: "example",
  mode: "url",
  message: "Approve this action.",
  url: "https://...",
  elicitationId: "elicit_123",
  _meta: null
}
```

## Local Mapping

`openai-apps` displays `_meta.tool_params` when present. If `tool_params` is absent, it falls back to `_meta`; for URL-mode requests it falls back to `{ url, elicitationId }`; otherwise it falls back to `{ requestedSchema }`.

The app-server response remains the MCP elicitation default:

```ts
{ action: "accept", content: {}, _meta: null }
```

or:

```ts
{ action: "decline", content: null, _meta: null }
```
