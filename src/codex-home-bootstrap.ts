import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FEATURES_HEADER = "[features]";
const APPS_FEATURE_LINE = "apps = true";
const ANALYTICS_HEADER = "[analytics]";
const ANALYTICS_DISABLED_LINE = "enabled = false";

function isTableHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]");
}

function ensureSettingInTable(params: {
  source: string;
  header: string;
  key: string;
  renderedLine: string;
}): string {
  const { source, header, key, renderedLine } = params;
  const lines = source.length > 0 ? source.split("\n") : [];
  const tableHeaderIndex = lines.findIndex((line) => line.trim() === header);

  if (tableHeaderIndex === -1) {
    const trimmed = source.trimEnd();
    return trimmed.length > 0
      ? `${trimmed}\n\n${header}\n${renderedLine}\n`
      : `${header}\n${renderedLine}\n`;
  }

  let tableEndIndex = lines.length;
  for (let index = tableHeaderIndex + 1; index < lines.length; index += 1) {
    if (isTableHeader(lines[index])) {
      tableEndIndex = index;
      break;
    }
  }

  for (let index = tableHeaderIndex + 1; index < tableEndIndex; index += 1) {
    if (lines[index].trim().startsWith(`${key} =`)) {
      if (lines[index].trim() === renderedLine) {
        return source;
      }
      lines[index] = renderedLine;
      return lines.join("\n");
    }
  }

  lines.splice(tableEndIndex, 0, renderedLine);
  return lines.join("\n");
}

export function ensureAppsFeatureEnabledInToml(source: string): string {
  return ensureSettingInTable({
    source,
    header: FEATURES_HEADER,
    key: "apps",
    renderedLine: APPS_FEATURE_LINE,
  });
}

export function ensureAnalyticsDisabledInToml(source: string): string {
  return ensureSettingInTable({
    source,
    header: ANALYTICS_HEADER,
    key: "enabled",
    renderedLine: ANALYTICS_DISABLED_LINE,
  });
}

export async function ensureBundledCodexHome(params: { codexHomeDir: string }): Promise<void> {
  const configPath = path.join(params.codexHomeDir, "config.toml");

  await mkdir(params.codexHomeDir, { recursive: true });

  let currentConfig = "";
  try {
    currentConfig = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const nextConfig = ensureAnalyticsDisabledInToml(
    ensureAppsFeatureEnabledInToml(currentConfig),
  );
  if (nextConfig !== currentConfig) {
    await writeFile(configPath, nextConfig, "utf8");
  }
}
