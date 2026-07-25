/* ═══════════════════════════════════════════════════
   streamConfig.js
   Client-side streaming tunables. Change these numbers to
   trade off image quality vs. upload size / speed.
   ═══════════════════════════════════════════════════ */

/**
 * How hard to compress each captured frame before uploading it, as a percentage.
 *
 *     0   = no compression   → sharpest image, largest file, best detection, slowest upload
 *   100   = full compression → blockiest image, smallest file, worst detection, fastest upload
 *
 * This is the ONE knob to tune frame compression. It maps to the canvas JPEG
 * quality argument:  quality = 1 - COMPRESSION_PERCENT / 100.
 */
export const COMPRESSION_PERCENT = 100;

/** Canvas JPEG quality (0..1) derived from COMPRESSION_PERCENT. */
export const JPEG_QUALITY = Math.max(0, Math.min(1, 1 - COMPRESSION_PERCENT / 100));
