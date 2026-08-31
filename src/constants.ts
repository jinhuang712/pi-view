/**
 * Shared constants for pi-view.
 */

// Long image path pattern: matches otty paste and pi clipboard temp files, plus generic absolute image paths
export const IMAGE_PATH_REGEX = /(\/var\/folders\/[^\s]+\.png|\/tmp\/pi-clipboard-[^\s]+\.png|\/tmp\/otty-paste\/[^\s]+\.png|\/private\/var\/folders\/[^\s]+\.png)/g;

// Generic absolute image path detection (for any image file)
export const GENERIC_IMAGE_PATH_REGEX =
  /(\/(?:var\/folders|tmp|private\/var\/folders)[^\s]*\.(?:png|jpg|jpeg|webp|gif|bmp))/gi;

// Basename extractor for display
export function imageBasename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

// Detect if a path looks like an image paste path (the ones we want to shorten)
export function isImagePastePath(p: string): boolean {
  return (
    p.includes("otty-paste/image-") ||
    p.includes("pi-clipboard-") ||
    /\/var\/folders\/.*\.png$/.test(p) ||
    /\/tmp\/.*\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(p)
  );
}

// Regex to find all image-like absolute paths in arbitrary text
export const ANY_IMAGE_PATH_IN_TEXT = /(?:\/[^\s:;,"']+\.(?:png|jpg|jpeg|webp|gif|bmp))/gi;
