import { constants } from "node:fs";
import { access as fsAccess, open, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { getVisionModelString, parseVisionModelId } from "../config.ts";
import { imageSize } from "image-size";

/**
 * View tool: dedicated image viewer.
 *  - main 支持 image  -> 直接返回图文，主 Agent 自己看
 *  - main 不支持 + 已配 visionModel -> 起临时 vision 子调用描述后返回文字（同时附图供 transcript）
 *  - main 不支持 + 未配 -> 报错引导 /pi-view:config
 */

const viewSchema = Type.Object({
  path: Type.String({ description: "Path to the image file to view (relative or absolute)" }),
});

export type ViewToolInput = Static<typeof viewSchema>;

export interface ViewToolDetails {
  mimeType?: string;
  visionRouted?: boolean;
  sizeKb?: string;
  pixels?: string;
  ratio?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}mb`;
}
function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }
function formatRatio(w: number, h: number): string {
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}
async function getImageMeta(absolutePath: string, buffer: Buffer): Promise<{ sizeKb: string; pixels: string; ratio: string }> {
  let sizeKb = "?";
  try {
    const st = await fsStat(absolutePath);
    sizeKb = formatBytes(st.size);
  } catch {}
  let pixels = "?";
  let ratio = "?";
  try {
    const dims = imageSize(buffer);
    if (dims.width && dims.height) {
      pixels = `${dims.width}x${dims.height}`;
      ratio = formatRatio(dims.width, dims.height);
    }
  } catch {}
  return { sizeKb, pixels, ratio };
}

// ---- minimal path utils (avoid importing pi src) ----
function resolveToCwd(filePath: string, cwd: string): string {
  let p = filePath.trim();
  if (p.startsWith("~/")) p = p.replace(/^~\//, process.env.HOME ? process.env.HOME + "/" : p);
  if (p.startsWith("~")) p = p.replace(/^~/, process.env.HOME ?? p);
  if (p.startsWith("@")) p = p.slice(1);
  if (isAbsolute(p)) return resolve(p);
  return resolve(cwd, p);
}

async function resolvePillBasename(basename: string, cwd: string): Promise<string | null> {
  const candidates: string[] = [
    resolveToCwd(basename, cwd),
    join(tmpdir(), "otty-paste", basename),
    join("/tmp", "otty-paste", basename),
    join(tmpdir(), basename),
    join("/tmp", basename),
  ];
  if (process.env.TMPDIR) candidates.push(join(process.env.TMPDIR, "otty-paste", basename));
  for (const c of candidates) {
    try { await fsAccess(c, constants.R_OK); return c; } catch {}
  }
  // Last resort: shell find in /var/folders and /tmp (bounded, best-effort)
  try {
    const { execSync } = await import("node:child_process");
    const dirs = [tmpdir(), "/tmp", process.env.TMPDIR || ""].filter(Boolean);
    // Also add /var/folders root for macOS otty-paste
    if (process.platform === "darwin" && !dirs.includes("/var/folders")) dirs.push("/var/folders");
    for (const d of dirs) {
      try {
        // Use find with maxdepth to avoid crawling too deep; otty-paste is typically 2-3 levels deep
        const cmd = `find "${d}" -maxdepth 4 -name "${basename.replace(/"/g, "")}" -type f 2>/dev/null | head -n 1`;
        const out = execSync(cmd, { encoding: "utf-8", timeout: 2000 }).trim();
        if (out) {
          try { await fsAccess(out, constants.R_OK); return out; } catch {}
        }
      } catch {}
    }
  } catch {}
  return null;
}

function formatRelative(p: string, cwd: string): string {
  try {
    const abs = resolveToCwd(p, cwd);
    const rel = relative(cwd, abs);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    return abs;
  } catch {
    return p;
  }
}

// ---- mime sniff (copied from pi's mime.ts, trimmed) ----
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function startsWith(buf: Uint8Array, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}
function startsWithAscii(buf: Uint8Array, off: number, s: string): boolean {
  if (buf.length < off + s.length) return false;
  for (let i = 0; i < s.length; i++) if (buf[off + i] !== s.charCodeAt(i)) return false;
  return true;
}
function detectMime(buf: Uint8Array): string | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return buf[3] === 0xf7 ? null : "image/jpeg";
  if (startsWith(buf, PNG_SIG)) return "image/png";
  if (startsWithAscii(buf, 0, "GIF")) return "image/gif";
  if (startsWithAscii(buf, 0, "RIFF") && startsWithAscii(buf, 8, "WEBP")) return "image/webp";
  if (startsWithAscii(buf, 0, "BM")) return "image/bmp";
  return null;
}
async function detectMimeFromFile(path: string): Promise<string | null> {
  let h: any = null;
  try {
    h = await open(path, "r");
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await h.read(buf, 0, 4096, 0);
    return detectMime(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    try { await h?.close(); } catch {}
  }
}
function guessMimeByExt(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "bmp") return "image/bmp";
  return "image/png";
}

async function detectMimeAndProcess(
  absolutePath: string,
): Promise<{ ok: true; data: string; mimeType: string; hints: string[] } | { ok: false; message: string }> {
  const mime = (await detectMimeFromFile(absolutePath)) ?? guessMimeByExt(absolutePath);
  // Validate it's actually an image file
  const sniff = await detectMimeFromFile(absolutePath);
  if (!sniff && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(absolutePath)) {
    return { ok: false, message: `[Not an image: ${absolutePath}]` };
  }
  try {
    const buf = await fsReadFile(absolutePath);
    // Simple resize not implemented; just base64. Pi's processImage would resize, but we avoid heavy deps.
    // For BMP we still need conversion, but we just pass through; provider may reject but we try.
    return { ok: true, data: buf.toString("base64"), mimeType: mime, hints: [] };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) };
  }
}

function getVisionNote(model: any | undefined): string | undefined {
  if (!model || (Array.isArray(model.input) && model.input.includes("image"))) return undefined;
  const visionStr = getVisionModelString();
  if (!visionStr) {
    return `[Current model ${model.provider}/${model.id} does not support images. No pi-view.visionModel configured. Run /pi-view:config to set a vision-capable model, or switch main model to one with image input.]`;
  }
  return `[Current model ${model.provider}/${model.id} does not support images. This view will be routed to visionModel ${visionStr} via temporary agent.]`;
}

export function createViewToolDefinition(cwd: string) {
  return {
    name: "view",
    label: "view",
    description:
      "View an image file. Use this for jpg/png/gif/webp/bmp images. Returns the image as an attachment for vision-capable models. For text/code files use read. For images, view is PREFERRED over read.",
    promptSnippet: "View image files",
    promptGuidelines: ["Use view for image files (png/jpg/webp/gif/bmp). Use read for text/code."],
    parameters: viewSchema,
    async execute(
      _toolCallId: string,
      { path }: ViewToolInput,
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: any,
    ): Promise<{ content: (TextContent | ImageContent)[]; details?: ViewToolDetails }> {
      // Resolve path relative to cwd, handling @ prefix, ~, and pi-view pills like "[ image-xxx.png ]"
      let raw = String(path ?? "").trim();
      if (raw.startsWith("@")) raw = raw.slice(1);
      // Handle pill fallback: "[ image-123.png ]" -> try to locate actual file by basename
      let absolutePath = resolveToCwd(raw, cwd);
      // Detect pill syntax
      const pillMatch = raw.match(/^\[\s*(image-[^\]]+\.(?:png|jpe?g|webp|gif|bmp))\s*\]$/i) || raw.match(/\[\s*(image-[^\]]+\.(?:png|jpe?g|webp|gif|bmp))\s*\]/i);
      let pillBasename: string | null = null;
      if (pillMatch) pillBasename = pillMatch[1]!.trim();
      // Also handle bare basename like "image-123.png"
      if (!pillBasename && /^image-[^\/]+\.(?:png|jpe?g|webp|gif|bmp)$/i.test(raw)) pillBasename = raw;
      if (pillBasename) {
        const guessed = await resolvePillBasename(pillBasename, cwd);
        if (guessed) {
          absolutePath = guessed;
        }
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      try {
        await fsAccess(absolutePath, constants.R_OK);
      } catch {
        // Second chance: if raw looked like a pill, explain where we searched
        if (pillBasename) {
          const searched = [
            join(tmpdir(), "otty-paste", pillBasename),
            join("/tmp", "otty-paste", pillBasename),
            join(tmpdir(), pillBasename),
            process.env.TMPDIR ? join(process.env.TMPDIR, "otty-paste", pillBasename) : "",
          ].filter(Boolean).join(", ");
          throw new Error(`File not found for pill "${raw}" (basename ${pillBasename}, resolved: ${absolutePath}). Searched: ${searched}. Try pasting the image again to refresh the temp file.`);
        }
        throw new Error(`File not found or not readable: ${path} (resolved: ${absolutePath})`);
      }

      const processed = await detectMimeAndProcess(absolutePath);
      if (!processed.ok) {
        return { content: [{ type: "text", text: processed.message }], details: {} };
      }

      const model = ctx?.model;
      const supportsImage = !model || (Array.isArray(model.input) && model.input.includes("image"));
      // Gather meta for gray hint (always, even when vision routed)
      let meta: { sizeKb: string; pixels: string; ratio: string } | null = null;
      try {
        const bufForMeta = Buffer.from(processed.data, "base64");
        meta = await getImageMeta(absolutePath, bufForMeta);
      } catch {}

      if (supportsImage) {
        let note = `Viewed image [${processed.mimeType}] ${formatRelative(path, cwd)}`;
        if (processed.hints.length > 0) note += `\n${processed.hints.join("\n")}`;
        return {
          content: [
            { type: "text", text: note },
            { type: "image", data: processed.data, mimeType: processed.mimeType },
          ],
          details: { mimeType: processed.mimeType, visionRouted: false, ...meta },
        };
      }

      // Main does NOT support image
      const visionStr = getVisionModelString();
      if (!visionStr) {
        const note =
          getVisionNote(model) ??
          `[Current model does not support images and no visionModel configured. Run /pi-view:config]`;
        return {
          content: [{ type: "text", text: `${note}\nTried to view image: ${formatRelative(path, cwd)} [${processed.mimeType}]` }],
          details: { mimeType: processed.mimeType, visionRouted: false, ...meta },
        };
      }

      const parsed = parseVisionModelId(visionStr);
      if (parsed) {
        try {
          const compat: any = await import("@earendil-works/pi-ai/compat");
          const streamSimple = compat.streamSimple;
          const getModel = compat.getModel;
          let visionModel: any = null;
          // 1) Try registry getModel
          try { visionModel = ctx?.modelRegistry?.getModel?.(parsed.provider, parsed.id); } catch {}
          // 2) Try compat global getModel
          if (!visionModel && getModel) {
            try { visionModel = getModel(parsed.provider, parsed.id); } catch {}
          }
          // 3) Fallback: search available snapshot (covers custom providers like volcengine-agent-plan)
          if (!visionModel) {
            try {
              const avail: any[] = ctx?.modelRegistry?.getAvailableSnapshot?.() ?? ctx?.modelRegistry?.getAvailable?.() ?? [];
              visionModel = avail.find((m: any) => m.provider === parsed.provider && m.id === parsed.id);
            } catch {}
          }
          if (!visionModel && getModel) {
            // Last resort: try finding via compat's available (if any)
            try {
              const all = (compat as any).getAvailableModels?.() ?? [];
              visionModel = all.find((m: any) => m.provider === parsed.provider && m.id === parsed.id);
            } catch {}
          }
          if (!visionModel) {
            return {
              content: [
                {
                  type: "text",
                  text: `Viewed image [${processed.mimeType}] ${formatRelative(path, cwd)} via ${visionStr} — vision model not found in registry. Run /pi-view:config to pick an available image model. Image attached.`,
                },
                { type: "image", data: processed.data, mimeType: processed.mimeType },
              ],
              details: { mimeType: processed.mimeType, visionRouted: true, ...meta },
            };
          }
          // Prefer ModelRegistry.complete which handles auth correctly (via pi's runtime).
          // Fallback to raw streamSimple only if complete is unavailable.
          const canComplete = typeof ctx?.modelRegistry?.complete === "function";
          if (canComplete) {
            try {
              const { uuidv7 } = await import("@earendil-works/pi-ai");
              const messages: any[] = [
                {
                  role: "user",
                  content: [
                    { type: "text", text: `Describe this image from ${formatRelative(path, cwd)} in detail.` },
                    { type: "image", data: processed.data, mimeType: processed.mimeType },
                  ],
                  timestamp: Date.now(),
                },
              ];
              const result: any = await ctx.modelRegistry.complete(
                visionModel,
                { messages },
                { sessionId: uuidv7(), signal } as any,
              );
              const fullText: string = (result?.content ?? [])
                .filter((c: any) => c?.type === "text" && typeof c.text === "string")
                .map((c: any) => c.text)
                .join("\n")
                .trim();
              if (fullText) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Viewed image [${processed.mimeType}] ${formatRelative(path, cwd)} via ${visionStr}:\n${fullText}${
                        processed.hints.length ? `\n${processed.hints.join("\n")}` : ""
                      }`,
                    },
                    { type: "image", data: processed.data, mimeType: processed.mimeType },
                  ],
                  details: { mimeType: processed.mimeType, visionRouted: true, ...meta },
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Viewed image [${processed.mimeType}] ${formatRelative(path, cwd)} via ${visionStr} — vision model returned no text. Result: ${JSON.stringify(result)?.slice(0, 500)}.`,
                  },
                  { type: "image", data: processed.data, mimeType: processed.mimeType },
                ],
                details: { mimeType: processed.mimeType, visionRouted: true, ...meta },
              };
            } catch (e: any) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Viewed image [${processed.mimeType}] ${formatRelative(path, cwd)} via ${visionStr} — vision call failed: ${e?.message ?? String(e)}. Image attached.`,
                  },
                  { type: "image", data: processed.data, mimeType: processed.mimeType },
                ],
                details: { mimeType: processed.mimeType, visionRouted: true, ...meta },
              };
            }
          }
          if (visionModel && streamSimple) {
            const controller = new AbortController();
            if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
            const context: any = {
              systemPrompt: "You are an image describer. Describe the image concisely and accurately. Focus on content, text, layout, and notable details.",
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: `Describe this image from ${formatRelative(path, cwd)} in detail.` },
                    { type: "image", data: processed.data, mimeType: processed.mimeType },
                  ],
                  timestamp: Date.now(),
                },
              ],
              tools: [],
            };
            const stream: any = streamSimple(visionModel, context, { signal: controller.signal } as any);
            let fullText = "";
            let lastEvent: any = null;
            for await (const ev of stream) {
              lastEvent = ev;
              if (typeof ev === "string") fullText += ev;
              else if (ev?.delta && typeof ev.delta === "string") fullText += ev.delta;
              else if (ev?.text && typeof ev.text === "string") fullText += ev.text;
              else if (ev?.content && typeof ev.content === "string") fullText += ev.content;
              else if (ev?.message?.content) {
                const c = ev.message.content;
                if (typeof c === "string") fullText += c;
                else if (Array.isArray(c)) {
                  for (const blk of c) if (blk?.text) fullText += blk.text;
                }
              }
              else if (Array.isArray(ev?.content)) {
                for (const blk of ev.content) if (blk?.text) fullText += blk.text;
              }
              if (ev?.type === "assistant" && ev?.message) {
                const m = ev.message;
                if (Array.isArray(m.content)) for (const blk of m.content) if (blk?.text) fullText += blk.text;
              }
            }
            if (!fullText.trim() && lastEvent) {
              try {
                const le: any = lastEvent;
                if (le?.message?.content && Array.isArray(le.message.content)) {
                  for (const blk of le.message.content) if (blk?.text) fullText += blk.text;
                }
              } catch {}
            }
            if (fullText.trim()) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Viewed image [${processed.mimeType}] ${formatRelative(path, cwd)} via ${visionStr}:\n${fullText.trim()}${
                      processed.hints.length ? `\n${processed.hints.join("\n")}` : ""
                    }`,
                  },
                  { type: "image", data: processed.data, mimeType: processed.mimeType },
                ],
                details: { mimeType: processed.mimeType, visionRouted: true, ...meta },
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: `Viewed image [${processed.mimeType}] ${formatRelative(path, cwd)} via ${visionStr} — vision model returned no text (lastEvent: ${JSON.stringify(lastEvent)?.slice(0, 500)}). Original image attached below.`,
                },
                { type: "image", data: processed.data, mimeType: processed.mimeType },
              ],
              details: { mimeType: processed.mimeType, visionRouted: true, ...meta },
            };
          }
        } catch (e: any) {
          // Return error diagnostic so user knows why routing failed
          return {
            content: [
              {
                type: "text",
                text: `Viewed image [${processed.mimeType}] ${formatRelative(path, cwd)} via ${visionStr} — vision call failed: ${e?.message ?? String(e)}. Image attached.`,
              },
              { type: "image", data: processed.data, mimeType: processed.mimeType },
            ],
            details: { mimeType: processed.mimeType, visionRouted: true, ...meta },
          };
        }
      }

      let note = `Viewed image [${processed.mimeType}] ${formatRelative(path, cwd)} (routed via ${visionStr})`;
      if (processed.hints.length > 0) note += `\n${processed.hints.join("\n")}`;
      const extra = getVisionNote(model);
      if (extra) note += `\n${extra}`;
      return {
        content: [
          { type: "text", text: note },
          { type: "image", data: processed.data, mimeType: processed.mimeType },
        ],
        details: { mimeType: processed.mimeType, visionRouted: true, ...meta },
      };
    },
    renderCall(args: any, theme: any, context: any) {
      const cwdForRender = context.cwd ?? cwd;
      let displayPath: string = String(args?.path ?? "");
      try {
        const abs = resolveToCwd(displayPath, cwdForRender);
        displayPath = abs;
      } catch {}
      const text = new Text("", 0, 0);
      const label = theme.fg("toolTitle", theme.bold(theme.italic("view")));
      const pathStyled = theme.fg("accent", displayPath);
      text.setText(`${label}  ${pathStyled}`);
      return text;
    },
    renderResult(result: any, options: any, theme: any, _context: any) {
      const text = new Text("", 0, 0);
      if (!options.expanded && !result?.details) return text;
      // When collapsed, still show the gray meta line if we have it
      const d = (result as any)?.details as ViewToolDetails | undefined;
      const metaLine = d?.pixels ? ` ( Size: ${d.sizeKb ?? "?"}, Pixels: ${d.pixels}, Ratio: ${d.ratio ?? "?"} )` : "";
      if (!options.expanded) {
        if (metaLine) {
          text.setText(`\n${theme.fg("muted", metaLine)}`);
        }
        return text;
      }
      let output = "";
      const first = result?.content?.[0];
      output = first?.text ?? "";
      if (!output && !metaLine) return text;
      let rendered = output ? `\n${theme.fg("toolOutput", output)}` : "";
      if (metaLine) rendered += `\n${theme.fg("muted", metaLine)}`;
      text.setText(rendered);
      return text;
    },
  };
}
