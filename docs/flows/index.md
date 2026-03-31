# OpenAI Apps Flow Index

- [`ref.openai-apps-list-tools.md`](./ref.openai-apps-list-tools.md) - How the bundle boots, refreshes or reuses connector snapshots, and publishes MCP tools for `listTools`.
- [`ref.openai-apps-call-tool.md`](./ref.openai-apps-call-tool.md) - How a published ChatGPT app tool is routed and invoked via `callTool`, including per-call app-server setup and failure guards.
- [`ref.openai-apps-call-tool-mcp-elicitation.md`](./ref.openai-apps-call-tool-mcp-elicitation.md) - How MCP elicitations are handled during `callTool`, including `allow_destructive_actions` behavior and turn impact.
- [`ref.openai-apps-connector-record-derivation.md`](./ref.openai-apps-connector-record-derivation.md) - How raw `app/list` results are normalized into persisted connector records used for publication and routing.
- [`ref.openai-apps-runtime-env.md`](./ref.openai-apps-runtime-env.md) - How runtime environment variables and OpenClaw state paths are inferred before config load and MCP bridge startup.
- [`ref.openai-apps-projected-auth.md`](./ref.openai-apps-projected-auth.md) - How OpenClaw `openai-codex` OAuth state is projected into ChatGPT-compatible auth, including profile selection and token refresh.
