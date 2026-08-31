import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createViewToolDefinition } from "./tools/view.ts";
import { ImageAwareEditor } from "./editor/image-editor.ts";
import { getConfigPath, getVisionModelString, loadConfig, parseVisionModelId, saveConfig } from "./config.ts";
import { ANY_IMAGE_PATH_IN_TEXT, imageBasename, isImagePastePath } from "./constants.ts";
import { VisionModelSelector } from "./components/vision-selector.ts";

export default function (pi: ExtensionAPI) {
  // ---------- Config command: /pi-view:config (single entry, searchable) ----------
  pi.registerCommand("pi-view:config", {
    description: "Configure pi-view vision model (which model to use for image view)",
    getArgumentCompletions: (prefix) => {
      const pa = prefix.trim().toLowerCase();
      const base = [
        { value: "clear", label: "clear", description: "Clear visionModel" },
        { value: "status", label: "status", description: "Show current config" },
      ];
      // Provide model keyword hints
      const hints = ["gpt", "sonnet", "kimi", "grok", "qwen", "claude", "opencode"]
        .filter(k => k.includes(pa) || pa === "")
        .map(k => ({ value: k, label: k, description: `Filter by "${k}"` }));
      const all = [...base, ...hints].filter(c => c.value.toLowerCase().startsWith(pa) || c.value.toLowerCase().includes(pa));
      return all.length ? all as any : null;
    },
    handler: async (args, ctx) => {
      const current = getVisionModelString() ?? "(not set)";
      const main = ctx.model ? `${ctx.model.provider}/${ctx.model.id} [${ctx.model.input.join(",")}]` : "(no model)";
      const trimmed = args.trim();

      // Subcommands that don't require model list
      if (trimmed === "clear" || trimmed === "reset" || trimmed === "unset") {
        saveConfig({ ...loadConfig(), visionModel: undefined });
        ctx.ui.notify(`pi-view visionModel cleared (was ${current})`, "info");
        return;
      }
      if (trimmed === "status" || trimmed === "show") {
        ctx.ui.notify(`pi-view: visionModel=${current} | main=${main} | config=${getConfigPath()}`, "info");
        return;
      }

      // Exact provider/modelId -> set directly (no selector)
      if (trimmed.includes("/")) {
        const parsed = parseVisionModelId(trimmed);
        if (parsed) {
          saveConfig({ ...loadConfig(), visionModel: trimmed });
          ctx.ui.notify(`pi-view visionModel set to ${trimmed} (saved to ${getConfigPath()})`, "info");
          return;
        }
        // If contains slash but not parsable, fall through to search
      }

      // Build searchable model list
      const available = ctx.modelRegistry.getAvailableSnapshot?.() ?? [];
      let models = available;
      if (models.length === 0) {
        try { models = (ctx.modelRegistry as any).getAvailable?.() ?? []; } catch {}
      }
      const imageModels = models.filter((m: any) => Array.isArray(m.input) && m.input.includes("image"));

      if (imageModels.length === 0) {
        const raw = await ctx.ui.input("Set visionModel", "provider/modelId e.g. anthropic/claude-sonnet-4-20250514");
        if (raw) {
          const p = parseVisionModelId(raw.trim());
          if (!p) { ctx.ui.notify(`Invalid format: "${raw}"`, "error"); return; }
          saveConfig({ ...loadConfig(), visionModel: raw.trim() });
          ctx.ui.notify(`pi-view visionModel set to ${raw.trim()}`, "info");
        } else {
          ctx.ui.notify(`pi-view visionModel: ${current} | main: ${main}. No image models found.`, "info");
        }
        return;
      }

      // Use single searchable UI like native /model — type to filter live, no two-step input
      const initialSearch = trimmed && !trimmed.includes("/") ? trimmed : "";
      const picked: any = await (ctx.ui as any).custom((tui: any, theme: any, kb: any, done: any) => {
        return new VisionModelSelector(tui, imageModels as any, current === "(not set)" ? undefined : current, done, theme, initialSearch);
      });
      if (!picked) return;
      const selected = `${picked.provider}/${picked.id}`;
      saveConfig({ ...loadConfig(), visionModel: selected });
      ctx.ui.notify(`pi-view visionModel set to ${selected}`, "info");
    },
  });

  // ---------- Install custom editor ----------
  pi.on("session_start", (_event, ctx) => {
    const globalTheme: any = (ctx.ui as any).theme ?? null;
    ctx.ui.setEditorComponent((tui, theme, kb) => new ImageAwareEditor(tui as any, theme as any, kb as any, undefined, globalTheme));
  });

  // ---------- User message transcript: show [ image-xxx.png ] pill instead of full path ----------
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== "user") return markdown;
    // Replace absolute image paths with pill [ image-basename ]
    // Use bold markdown so it stands out inside userMessageBg box
    return markdown.replace(ANY_IMAGE_PATH_IN_TEXT, (fullPath: string) => {
      // Only shorten otty-paste / pi-clipboard / long generic paths
      if (!isImagePastePath(fullPath) && fullPath.length < 40) return fullPath;
      const base = imageBasename(fullPath);
      return `**[ ${base} ]**`;
    });
  });

  // ---------- System prompt injection ----------
  pi.on("before_agent_start", async (event, _ctx) => {
    const addition = `
## pi-view Image Rule
- For image files (png/jpg/jpeg/webp/gif/bmp) ALWAYS use the \`view\` tool. Do NOT use \`read\` for images.
- For text/code files use \`read\`.
- \`view\` is the ONLY tool that correctly handles images; it will route to a vision-capable model if the current model does not support image input.
`;
    // Chain with existing prompt
    const base = event.systemPrompt ?? "";
    if (base.includes("pi-view Image Rule")) return {};
    return { systemPrompt: base + addition };
  });

  // ---------- Block read for images, force view ----------
  pi.on("tool_call", async (event, _ctx) => {
    // Only intercept read
    if (event.toolName !== "read") return;

    const input: any = (event as any).input;
    const p: string | undefined = input?.path ?? input?.file_path;
    if (!p) return;
    if (!/\.(png|jpe?g|webp|gif|bmp)(\s|$|")/i.test(p)) return;

    // This looks like an image path -> block and suggest view
    return {
      block: true,
      reason: `Image files must be viewed with the \`view\` tool, not \`read\`. Retry with view { "path": "${p}" }`,
    };
  });

  // ---------- Vision routing for direct image attachments (rare; view is preferred) ----------
  // D3: no auto fallback -> if no visionModel, warn. If visionModel exists, temp-switch main for this turn.
  pi.on("before_agent_start", async (event, ctx) => {
    const images: any[] | undefined = (event as any).images;
    if (!images || images.length === 0) return;

    const model: any = (ctx as any).model;
    const supportsImage = !model || (Array.isArray(model.input) && model.input.includes("image"));
    if (supportsImage) return;

    const visionStr = getVisionModelString();
    if (!visionStr) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Current model ${model.provider}/${model.id} does not support images and no pi-view.visionModel is set. Run /pi-view:config to set one.`,
          "warning",
        );
      }
      return;
    }

    const parsed = parseVisionModelId(visionStr);
    if (!parsed) return;
    // Find vision model in registry
    let available: any[] = [];
    try {
      available = (ctx as any).modelRegistry?.getAvailableSnapshot?.() ?? [];
      if (available.length === 0) available = (ctx as any).modelRegistry?.getAvailable?.() ?? [];
    } catch {}
    const visionModel = available.find((m: any) => m.provider === parsed.provider && m.id === parsed.id);
    if (!visionModel) {
      if (ctx.hasUI) ctx.ui.notify(`pi-view: visionModel ${visionStr} not found in registry`, "warning");
      return;
    }
    // Remember original and switch
    try {
      originalModelBeforeImageTurn = model;
      const ok = await pi.setModel(visionModel);
      if (ok && ctx.hasUI) {
        ctx.ui.notify(`pi-view: temporarily switched to ${visionStr} for this image turn (will restore after)`, "info");
      } else {
        originalModelBeforeImageTurn = null;
      }
    } catch {}
  });

  // ---------- Vision routing state: remember original model for temp switch ----------
  let originalModelBeforeImageTurn: any | null = null;
  pi.on("agent_end", async (_event, _ctx) => {
    if (originalModelBeforeImageTurn) {
      try {
        await pi.setModel(originalModelBeforeImageTurn);
      } catch {}
      originalModelBeforeImageTurn = null;
    }
  });
  pi.on("agent_start", async (_event, _ctx) => {
    // no-op, restoration is on agent_end
  });

  // ---------- Register View tool ----------
  // We need cwd-aware definition; we register a factory that captures current cwd at execution time via ctx.cwd
  pi.registerTool({
    name: "view",
    label: "view",
    description:
      "View an image file. Use this for jpg/png/gif/webp/bmp images. Returns the image as an attachment for vision-capable models. For text/code files use read. For images, view is PREFERRED over read.",
    promptSnippet: "View image files",
    promptGuidelines: ["Use view for image files (png/jpg/webp/gif/bmp). Use read for text/code."],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the image file to view (relative or absolute)" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Use ctx.cwd for path resolution
      const cwd = (ctx as any).cwd ?? process.cwd();
      const def = createViewToolDefinition(cwd);
      // Delegate to the shared implementation
      return (def as any).execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const cwd = (context as any).cwd ?? process.cwd();
      const def = createViewToolDefinition(cwd);
      return (def as any).renderCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      const cwd = (context as any).cwd ?? process.cwd();
      const def = createViewToolDefinition(cwd);
      return (def as any).renderResult(result, options, theme, context);
    },
  });

  // ---------- Input handling: detect long image paths pasted and hint ----------
  // Not strictly needed since editor handles display, but we can log for debugging
  pi.on("input", async (event, _ctx) => {
    const text: string = (event as any).text ?? "";
    if (ANY_IMAGE_PATH_IN_TEXT.test(text)) {
      ANY_IMAGE_PATH_IN_TEXT.lastIndex = 0;
      // No transform; just let it pass. Editor already shortens display.
    }
    return { action: "continue" };
  });
}
