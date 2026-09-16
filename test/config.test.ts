import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The rename's only cost to a user: the file their vision model is written in.
 *
 * `config.ts` resolves both paths from `homedir()` when the module first loads, so `HOME` is moved
 * before the import and every case runs against one fake home. Nothing here touches the real one.
 */

const home = mkdtempSync(join(tmpdir(), "pid-view-home-"));
process.env.HOME = home;
const agent = join(home, ".pi", "agent");
mkdirSync(agent, { recursive: true });

const NEW = join(agent, "pid-view.json");
const LEGACY = join(agent, "pi-view.json");

const { getConfigPath, getVisionModelString, loadConfig, setVisionModelString } = await import(
  "../src/config.ts"
);

const write = (path: string, model: string) =>
  writeFileSync(path, JSON.stringify({ visionModel: model }, null, 2));
const clear = () => {
  rmSync(NEW, { force: true });
  rmSync(LEGACY, { force: true });
};

test("nothing configured reads as nothing, not as a crash", () => {
  clear();
  assert.deepEqual(loadConfig(), {});
  assert.equal(getVisionModelString(), undefined);
});

test("a setting written under the old name is still read", () => {
  clear();
  write(LEGACY, "openai-codex/gpt-5.6-luna");
  assert.equal(getVisionModelString(), "openai-codex/gpt-5.6-luna");
});

test("the next save moves it across, and leaves the old file alone", () => {
  clear();
  write(LEGACY, "openai-codex/gpt-5.6-luna");
  setVisionModelString("anthropic/claude-sonnet-4-20250514");

  assert.ok(existsSync(NEW), "the new file is written");
  assert.equal(
    JSON.parse(readFileSync(NEW, "utf-8")).visionModel,
    "anthropic/claude-sonnet-4-20250514",
  );
  // The old file is the user's. Reading it is this extension's business; deleting it is not.
  assert.equal(JSON.parse(readFileSync(LEGACY, "utf-8")).visionModel, "openai-codex/gpt-5.6-luna");
});

test("with both on disk the new name wins", () => {
  clear();
  write(LEGACY, "openai-codex/gpt-5.6-luna");
  write(NEW, "anthropic/claude-sonnet-4-20250514");
  assert.equal(getVisionModelString(), "anthropic/claude-sonnet-4-20250514");
});

test("the path reported to the user is the one that is written", () => {
  assert.equal(getConfigPath(), NEW);
});

test("clearing the model empties the new file without resurrecting the old one", () => {
  clear();
  write(LEGACY, "openai-codex/gpt-5.6-luna");
  setVisionModelString(undefined);
  assert.deepEqual(JSON.parse(readFileSync(NEW, "utf-8")), {});
  assert.equal(getVisionModelString(), undefined);
});

test.after(() => rmSync(home, { recursive: true, force: true }));
