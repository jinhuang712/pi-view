/**
 * Types for the desktop host a second half can be drawn in.
 *
 * The real implementations live in the host (`src/renderer/` in PID) and reach this module through
 * a shim at load time — nothing is installed from npm, and the terminal half never touches any of
 * it. This file exists so this repository's own `tsc` can check the half it ships; it is a mirror,
 * and the host is the source of truth.
 *
 * Kept loose on purpose: enough to catch a typo in a primitive's name or a missing prop, not enough
 * to pretend this repository owns the component library.
 */

declare namespace JSX {
  type Element = unknown;
  interface ElementChildrenAttribute {
    children: Record<string, never>;
  }
  /** `key` is the renderer's, not a component's, so it is accepted on every element. */
  interface IntrinsicAttributes {
    key?: string | number;
  }
  interface IntrinsicElements {
    [tag: string]: Record<string, unknown>;
  }
}

declare module "@pid/jsx-runtime" {
  export const jsx: (...args: unknown[]) => unknown;
  export const jsxs: (...args: unknown[]) => unknown;
  export const Fragment: unknown;
}

declare module "@pid/ui" {
  type Node = unknown;
  interface Base {
    className?: string;
    title?: string;
    children?: Node;
  }

  export function Say(
    p: Base & {
      tone?: "normal" | "soft" | "faint" | "warn" | "danger" | "ok" | "accent";
      mono?: boolean;
      truncate?: boolean;
    },
  ): Node;
  export function Inline(p: Base & { gap?: "tight" | "normal" }): Node;
  export function Line(p: Base & { gap?: "tight" | "normal" | "wide"; pad?: boolean }): Node;
  export function Stack(p: Base & { gap?: "tight" | "normal" | "wide"; pad?: boolean }): Node;
  export function Spread(): Node;
  export function Badge(p: Base & { tone?: "ok" | "warn" | "danger" | "muted" | "accent" }): Node;
  export function Eyebrow(p: Base): Node;
  export function Panel(p: Base): Node;
  export function Divider(p: { inset?: boolean; className?: string }): Node;
}
