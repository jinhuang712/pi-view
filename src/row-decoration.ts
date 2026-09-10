/**
 * Row decoration handshake with pi-briefly.
 *
 * Pi has no renderer-only tool override: `registerTool()` is the only entry
 * point and it takes over execution, so a tool can only be restyled by its own
 * extension handing the presentation over. pi-briefly publishes a hub under a
 * well-known global symbol for exactly that; nothing here imports pi-briefly,
 * and with the hub absent this extension registers its own tool unchanged.
 *
 * See pi-briefly's README ("Row decorator hub") for the other half.
 */

/** Presentation slots the decorator takes over when it decorates this row. */
export type RowCallRenderer = (...args: any[]) => any;

export interface ToolRowDecorationRequest {
  /** The tool name as Pi sees it, for example `view`. */
  tool: string;
  /** This extension's own renderers, used when the row is expanded or terse is off. */
  native?: {
    renderCall?: RowCallRenderer;
    renderResult?: RowCallRenderer;
    renderShell?: "default" | "self";
  };
  /** Handed over today so a later schema-level decoration needs no change here. */
  schema?: {
    parameters?: any;
    prepareArguments?: (args: any) => any;
  };
}

export interface ToolRowDecoration {
  renderCall?: RowCallRenderer;
  renderResult?: RowCallRenderer;
  renderShell?: "default" | "self";
  // Loosely typed so the spread stays assignable to this extension's definition.
  parameters?: any;
  prepareArguments?: (args: any) => any;
}

export interface ToolRowDecoratorHub {
  decorate(request: ToolRowDecorationRequest): ToolRowDecoration | undefined;
  subscribe(listener: () => void): () => void;
}

/** Minimal shape of the host extension API, so this module needs no Pi imports. */
export interface RowDecorationHost {
  on(event: "session_start" | "session_shutdown", handler: () => void): void;
}

const TOOL_ROW_DECORATOR_KEY = Symbol.for("pi.toolRowDecorator.v1");

export function readToolRowDecoratorHub(): ToolRowDecoratorHub | undefined {
  const hub = (globalThis as Record<PropertyKey, unknown>)[TOOL_ROW_DECORATOR_KEY];
  return typeof (hub as ToolRowDecoratorHub | undefined)?.decorate === "function" ? (hub as ToolRowDecoratorHub) : undefined;
}

/**
 * Re-apply `apply` once per session and whenever pi-briefly says the decoration
 * may have changed.
 *
 * The re-apply happens in `session_start` rather than at load time: every
 * extension module is loaded first, and only then does Pi emit `session_start`,
 * so this is the earliest moment the hub is guaranteed to be published no matter
 * which of the two extensions the user installed first. `apply` has to
 * re-register the tool, because that is the only way a presentation change
 * reaches Pi.
 */
export function bindRowDecoration(host: RowDecorationHost, apply: () => void): void {
  let unsubscribe: (() => void) | undefined;
  host.on("session_start", () => {
    apply();
    unsubscribe?.();
    unsubscribe = readToolRowDecoratorHub()?.subscribe(apply);
  });
  host.on("session_shutdown", () => {
    unsubscribe?.();
    unsubscribe = undefined;
  });
}
