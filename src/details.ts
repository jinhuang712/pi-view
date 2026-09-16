/**
 * What a `view` call reports about the image it looked at.
 *
 * Its own module because both halves need it and neither should drag the other's dependencies in:
 * the terminal half reaches it through `tools/view.ts`, which pulls in node's filesystem, pi-tui and
 * `image-size`; the desktop half (`src/ui.tsx`) runs in a window and can have none of those.
 */
export interface ViewToolDetails {
  mimeType?: string;
  /** True when the main model cannot see images and a configured vision model described it instead. */
  visionRouted?: boolean;
  sizeKb?: string;
  pixels?: string;
  ratio?: string;
}
