import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PidViewConfig {
  /** Provider/model id for vision, e.g. "anthropic/claude-sonnet-4-20250514" or "openai/gpt-4o" */
  visionModel?: string;
}

const CONFIG_FILE = join(homedir(), ".pi", "agent", "pid-view.json");

/**
 * Where the configuration lived before the extension was named `pid-view`.
 *
 * Read only when the new file is absent, and never written. Nothing is asked of the user: an
 * existing setting keeps working, and the next save moves it across. The old file is left where it
 * is — it is the user's, and deleting it would be this extension deciding that for them.
 */
const LEGACY_CONFIG_FILE = join(homedir(), ".pi", "agent", "pi-view.json");

function ensureDir() {
  const dir = join(homedir(), ".pi", "agent");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readFile(path: string): PidViewConfig | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf-8")) as PidViewConfig;
  } catch {
    return undefined;
  }
}

export function loadConfig(): PidViewConfig {
  return readFile(CONFIG_FILE) ?? readFile(LEGACY_CONFIG_FILE) ?? {};
}

export function saveConfig(cfg: PidViewConfig): void {
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
