/**
 * The desktop half of this extension.
 *
 * The terminal half is `src/index.ts`. Its `view` tool carries a `renderCall` and a `renderResult`
 * that paint two pi-tui lines — the call, and a muted `( Size: … , Pixels: … , Ratio: … )` under it.
 * Only a terminal can mount those. This runs in a window and draws the same row there, out of the
 * host's own row frame.
 *
 * The window has one thing the terminal does not: it shows the picture. So the row says what the
 * image is and gets out of the way — the frame renders the image blocks the tool already returned.
 *
 * Declared as `"pid": { "ui": "./src/ui.tsx" }`. A host that has never heard of this file loads the
 * tool alone and loses nothing but the row.
 */

import { Badge, Say } from "@pid/ui";
import type { ViewToolDetails } from "./details.ts";

/** What the host hands a tool renderer. Mirrors PID's `ToolDraw`; the host is the source of truth. */
interface Draw {
  call: { name: string; arguments?: unknown };
  run?: { status?: string; isError?: boolean; result?: { details?: unknown } };
  Frame: (props: {
    verb?: string;
    detail?: string;
    meta?: unknown;
    body?: "args" | "command" | "none";
    children?: unknown;
  }) => unknown;
}

interface Ctx {
  cwd?: string;
}

interface Api {
  readonly id: string;
  tool: (spec: { names: string[]; render: (draw: Draw, ctx: Ctx) => unknown }) => void;
}

/** The path as the model wrote it, shortened against the session folder when it sits inside one. */
function shown(path: string, cwd: string | undefined): string {
  if (!cwd || !path.startsWith(`${cwd}/`)) return path;
  return path.slice(cwd.length + 1);
}

/**
 * The same three facts the terminal's meta line carries, plus the one it only hints at.
 *
 * `visionRouted` is what neither the path nor the picture says: the main model could not see the
 * image, so a configured vision model looked at it and the text below is that model's description.
 * A reader who does not know is reading someone else's words as the model's own — which is why it
 * is a tinted pill and the measurements are not. `read` and `bash` have nothing like it because
 * nothing about those calls is routed anywhere, and the row saying so is the point.
 */
function meta(d: ViewToolDetails | undefined): unknown {
  if (!d) return undefined;
  const said = [d.sizeKb, d.pixels, d.ratio].filter((p): p is string => Boolean(p)).join(" · ");
  if (!said && !d.visionRouted) return undefined;
  return (
    <>
      {said && <Say tone="faint">{said}</Say>}
      {d.visionRouted && <Badge tone="accent" title="described by the configured vision model">vision</Badge>}
    </>
  );
}

export default function register(pid: Api) {
  pid.tool({
    names: ["view"],
    render: (draw, ctx) => {
      const { Frame } = draw;
      const done = draw.run?.status !== undefined && draw.run.status !== "running";
      const path = (draw.call.arguments as { path?: unknown } | undefined)?.path;
      return (
        <Frame
          verb={done ? "Viewed" : "Viewing"}
          detail={shown(typeof path === "string" ? path : "", ctx.cwd)}
          meta={meta(draw.run?.result?.details as ViewToolDetails | undefined)}
          // The path is the whole story, as it is for `read`, and the picture is below it. The
          // arguments as JSON would only repeat the path in braces.
          body="none"
        />
      );
    },
  });
}
