import { callGatewayTool } from "openclaw/plugin-sdk/browser-support";

export type PluginApprovalDecision = "allow-once" | "allow-always" | "deny";

export type PluginApprovalRequest = {
  pluginId: string;
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
  toolName?: string;
  timeoutMs?: number;
};

type PluginApprovalGatewayResult = {
  id?: string;
  decision?: string | null;
};

const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 120_000;

function isPluginApprovalDecision(value: unknown): value is PluginApprovalDecision {
  return value === "allow-once" || value === "allow-always" || value === "deny";
}

export async function requestOpenClawPluginApproval(
  request: PluginApprovalRequest,
): Promise<PluginApprovalDecision | null> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;
  const gatewayTimeoutMs = timeoutMs + 10_000;
  const requestResult = await callGatewayTool<PluginApprovalGatewayResult>(
    "plugin.approval.request",
    { timeoutMs: gatewayTimeoutMs },
    {
      pluginId: request.pluginId,
      title: request.title,
      description: request.description,
      severity: request.severity,
      toolName: request.toolName,
      timeoutMs,
      twoPhase: true,
    },
    { expectFinal: false },
  );

  if (Object.prototype.hasOwnProperty.call(requestResult, "decision")) {
    return isPluginApprovalDecision(requestResult.decision) ? requestResult.decision : null;
  }

  if (!requestResult.id) {
    return null;
  }

  const waitResult = await callGatewayTool<PluginApprovalGatewayResult>(
    "plugin.approval.waitDecision",
    { timeoutMs: gatewayTimeoutMs },
    { id: requestResult.id },
  );
  return isPluginApprovalDecision(waitResult.decision) ? waitResult.decision : null;
}
