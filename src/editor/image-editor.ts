import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { imageBasename, isImagePastePath, ANY_IMAGE_PATH_IN_TEXT } from "../constants.ts";

/**
 * ImageAwareEditor: shortens long temp image paths to [ image-xxx.png ] in render,
 * with distinct accent+bolder styling.
 *
 * Implementation: pure render-time replacement (no state mutation) for MVP.
 * Cursor misalignment for the shortened segment is a known small tradeoff;
 * paste markers already handle atomics for large pastes. Image paths are typically
 * single tokens at end of line, so misalignment impact is minimal.
 *
 * Future: add atomic segment handling for [ image-*.png ] similar to paste markers.
 */

function styleImageToken(filename: string, theme: any): string {
  // Distinct pill: accent + bold + underline, different from normal editor text
  try {
    // theme.underline may not exist on EditorTheme, fallback to bold+accent
    const inner = `[ ${filename} ]`;
    let styled = theme.fg("accent", theme.bold(inner));
    // Try underline if available on theme helpers
    try {
      if (typeof theme.underline === "function") styled = theme.underline(styled);
    } catch {}
    return styled;
  } catch {
    return `[ ${filename} ]`;
  }
}

// Regex to detect image paths for replacement in render output
// We operate on rendered lines which are ANSI strings, but paths are plain substrings inside
const IMAGE_PATH_FOR_RENDER = /(?:\/[^\s:;,"']+\.(?:png|jpg|jpeg|webp|gif|bmp))/gi;

export class ImageAwareEditor extends CustomEditor {
  private globalTheme: any;
  private imageMap = new Map<string, string>();
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: any, globalTheme?: any) {
    super(tui, theme, keybindings, options);
    this.globalTheme = globalTheme;
  }

  private pillForPath(fullPath: string): string {
    const base = imageBasename(fullPath);
    const pill = `[ ${base} ]`;
    // Store mapping pill -> fullPath (last wins if duplicate basename, which is rare for otty-paste)
    this.imageMap.set(pill, fullPath);
    return pill;
  }

  private replaceImagePathsWithPills(text: string): string {
    // Find all image-like absolute paths and replace those that are paste paths or very long
    return text.replace(ANY_IMAGE_PATH_IN_TEXT, (fullPath: string) => {
      if (!isImagePastePath(fullPath) && fullPath.length < 40) return fullPath;
      return this.pillForPath(fullPath);
    });
  }

  override insertTextAtCursor(text: string): void {
    if (!text) return;
    const processed = this.replaceImagePathsWithPills(text);
    super.insertTextAtCursor(processed);
  }

  override setText(text: string): void {
    if (text.includes("/") && (text.includes(".png") || text.includes(".jpg") || text.includes(".webp") || text.includes(".gif"))) {
      // Clear stale mappings that are no longer referenced
      const processed = this.replaceImagePathsWithPills(text);
      super.setText(processed);
      // Prune map to only pills still present
      const still = new Map<string, string>();
      for (const [pill, full] of this.imageMap) if (processed.includes(pill)) still.set(pill, full);
      this.imageMap = still;
    } else {
      // If new text has no pill, clear map
      if (!text.includes("[ image-")) this.imageMap.clear();
      super.setText(text);
    }
  }

  /**
   * Expand both pi's paste markers and pi-view's image pills.
   * Overriding expandPasteMarkers ensures submitValue() (which calls
   * expandPasteMarkers directly, not getExpandedText) also restores
   * full image paths. This was the root cause of "[ image-xxx.png ]"
   * being sent to the LLM without the /var/folders/... prefix.
   */
  override expandPasteMarkers(text: string): string {
    let expanded = super.expandPasteMarkers(text);
    // 1) Expand pills tracked in imageMap (normal path)
    for (const [pill, full] of this.imageMap) {
      if (expanded.includes(pill)) expanded = expanded.split(pill).join(full);
    }
    // 2) Fallback: text still contains a pill but map is missing
    //    (e.g. after editor re-creation via setCustomEditorComponent which
    //    copies text via getText() not getExpandedText(), or user typed
    //    the pill manually). Try sync filesystem guess.
    const pillRe = /\[\s*(image-[^\]]+\.(?:png|jpg|jpeg|webp|gif|bmp))\s*\]/gi;
    // Collect all pills first to avoid mutating string while iterating with global RegExp
    const pills = [...expanded.matchAll(pillRe)];
    const seen = new Set<string>();
    for (const m of pills) {
      const basename = m[1]!.trim();
      if (seen.has(basename)) continue;
      seen.add(basename);
      const fullPill = m[0];
      // Skip if already expanded (map had it)
      if (this.imageMap.has(fullPill)) continue;
      // Also skip if expanded no longer contains pill (already replaced by earlier iteration)
      if (!expanded.includes(fullPill)) continue;
      const guessed = this.tryGuessImagePathSync(basename);
      if (guessed) {
        this.imageMap.set(fullPill, guessed);
        expanded = expanded.split(fullPill).join(guessed);
      }
    }
    return expanded;
  }

  private tryGuessImagePathSync(basename: string): string | null {
    const bases = [
      join(tmpdir(), "otty-paste", basename),
      join("/tmp", "otty-paste", basename),
      join(tmpdir(), basename),
      join("/tmp", basename),
    ];
    for (const p of bases) {
      try { if (existsSync(p)) return p; } catch {}
    }
    // Also try TMPDIR env variant (macOS /var/folders/...)
    const envTmp = process.env.TMPDIR;
    if (envTmp) {
      const p = join(envTmp, "otty-paste", basename);
      try { if (existsSync(p)) return p; } catch {}
    }
    return null;
  }

  override getExpandedText(): string {
    // super.getExpandedText() -> this.expandPasteMarkers(...) which now also expands image pills
    return super.getExpandedText();
  }

  override submitValue(): void {
    // Ensure pills are expanded via overridden expandPasteMarkers.
    // Calling super will use our expandPasteMarkers, so full paths reach onSubmit.
    super.submitValue();
  }

  override handleInput(data: string): void {
    // Intercept bracketed paste that contains image paths so stored text is pill (fixes wrap width)
    if (data.includes("\x1b[200~")) {
      const pasteRe = /\x1b\[200~([\s\S]*?)\x1b\[201~/g;
      let last = 0;
      let out = "";
      let m: RegExpExecArray | null;
      let changed = false;
      while ((m = pasteRe.exec(data)) !== null) {
        out += data.slice(last, m.index);
        const pasted = m[1] ?? "";
        const processed = this.replaceImagePathsWithPills(pasted);
        if (processed !== pasted) changed = true;
        out += `\x1b[200~${processed}\x1b[201~`;
        last = pasteRe.lastIndex;
      }
      out += data.slice(last);
      if (changed) {
        super.handleInput(out);
        return;
      }
    }
    super.handleInput(data);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const th: any = this.globalTheme ?? (this as any).theme ?? (this as any)._theme ?? null;
    return lines.map((line) => {
      let newLine = line;
      // 1) Fallback: any remaining full absolute image paths (e.g., from handlePaste bypass) -> pill
      if ((line.includes(".png") || line.includes(".jpg") || line.includes(".webp") || line.includes(".gif")) &&
          (line.includes("otty-paste") || line.includes("pi-clipboard") || line.includes("/var/folders") || ANY_IMAGE_PATH_IN_TEXT.test(line))) {
        ANY_IMAGE_PATH_IN_TEXT.lastIndex = 0;
        const re = /(?:\/[^\s:;,"'\x1b]+\.(?:png|jpg|jpeg|webp|gif|bmp))/gi;
        const matches = [...line.matchAll(re)];
        for (const m of matches) {
          const fullPath = m[0];
          if (!isImagePastePath(fullPath) && fullPath.length < 40) continue;
          const base = imageBasename(fullPath);
          const styled = styleImageToken(base, th);
          // Also keep mapping for expansion if this path was not yet stored (bypass case)
          const pill = `[ ${base} ]`;
          if (!this.imageMap.has(pill)) this.imageMap.set(pill, fullPath);
          newLine = newLine.split(fullPath).join(styled);
        }
      }
      // 2) Style already-stored pills [ image-... ] that are plain text -> accent pill
      // This is the normal path now that we store pills, so it fixes width calculation.
      const pillRe = /\[\s*image-[^\]]+\.(png|jpg|jpeg|webp|gif|bmp)\s*\]/gi;
      if (pillRe.test(newLine)) {
        pillRe.lastIndex = 0;
        // Avoid double-styling if already contains ANSI (styled pill contains \x1b)
        if (!newLine.includes("\x1b") || newLine.includes("[ image-")) {
          newLine = newLine.replace(pillRe, (pill: string) => {
            // Extract basename inside pill for styling
            const inner = pill.replace(/^\[\s*|\s*\]$/g, "").trim();
            return styleImageToken(inner, th);
          });
        }
      }
      return newLine;
    });
  }

  // Ensure expanded text still contains full paths for submission
  // (render replacement is display-only, so getText() already has full path; no extra handling needed)
}
