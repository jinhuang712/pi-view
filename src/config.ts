import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PiViewConfig {
  /** Provider/model id for vision, e.g. "anthropic/claude-sonnet-4-20250514" or "openai/gpt-4o" */
  visionModel?: string;
}

const CONFIG_FILE = join(homedir(), ".pi", "agent", "pi-view.json");

function ensureDir() {
  const dir = join(homedir(), ".pi", "agent");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadConfig(): PiViewConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed as PiViewConfig;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: PiViewConfig): void {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

export function getVisionModelString(): string | undefined {
  const cfg = loadConfig();
  return cfg.visionModel?.trim() || undefined;
}

export function setVisionModelString(modelStr: string | undefined): void {
  const cfg = loadConfig();
  if (!modelStr) {
    delete cfg.visionModel;
  } else {
    cfg.visionModel = modelStr.trim();
  }
  saveConfig(cfg);
}

export function parseVisionModelId(modelStr: string): { provider: string; id: string } | null {
  const idx = modelStr.indexOf("/");
  if (idx === -1) return null;
  const provider = modelStr.slice(0, idx).trim();
  const id = modelStr.slice(idx + 1).trim();
  if (!provider || !id) return null;
  return { provider, id };
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
