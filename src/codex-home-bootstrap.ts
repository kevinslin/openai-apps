import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FEATURES_HEADER = "[features]";
const APPS_FEATURE_LINE = "apps = true";

function isTableHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]");
}

export function ensureAppsFeatureEnabledInToml(source: string): string {
  const lines = source.length > 0 ? source.split("\n") : [];
  const featuresHeaderIndex = lines.findIndex((line) => line.trim() === FEATURES_HEADER);

  if (featuresHeaderIndex === -1) {
    const trimmed = source.trimEnd();
    return trimmed.length > 0
      ? `${trimmed}\n\n${FEATURES_HEADER}\n${APPS_FEATURE_LINE}\n`
      : `${FEATURES_HEADER}\n${APPS_FEATURE_LINE}\n`;
  }

  let featuresEndIndex = lines.length;
  for (let index = featuresHeaderIndex + 1; index < lines.length; index += 1) {
    if (isTableHeader(lines[index])) {
      featuresEndIndex = index;
      break;
    }
  }

  for (let index = featuresHeaderIndex + 1; index < featuresEndIndex; index += 1) {
    if (lines[index].trim().startsWith("apps =")) {
      if (lines[index].trim() === APPS_FEATURE_LINE) {
        return source;
      }
      lines[index] = APPS_FEATURE_LINE;
      return lines.join("\n");
    }
  }

  lines.splice(featuresEndIndex, 0, APPS_FEATURE_LINE);
  return lines.join("\n");
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

  const nextConfig = ensureAppsFeatureEnabledInToml(currentConfig);
  if (nextConfig !== currentConfig) {
    await writeFile(configPath, nextConfig, "utf8");
  }
}
