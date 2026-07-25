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
export const COMPRESSION_PERCENT = 90;

/** Canvas JPEG quality (0..1) derived from COMPRESSION_PERCENT. */
export const JPEG_QUALITY = Math.max(0, Math.min(1, 1 - COMPRESSION_PERCENT / 100));

/**
 * Square input size (pixels) for capture + detection, e.g. 640 → 640×640.
 *
 * This is the biggest performance lever: the server runs YOLO at this size, so
 * smaller = faster inference AND smaller uploads.
 *   640 = default (most detail / best on small & far objects)
 *   512 / 416 / 320 = progressively faster, but the model sees less detail
 *                     (may miss small/distant objects).
 *
 * Best to use a multiple of 32 (640, 512, 416, 384, 320); other values still
 * work but the model rounds internally. The server clamps this to a safe range
 * and reports the value it actually used back on connect, so client + server
 * always agree on the coordinate space.
 */
export const INPUT_SIZE = 640;
