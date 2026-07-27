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

/**
 * Pipeline depth — how many frames may be "in flight" (sent, awaiting a result)
 * at once. Balances per-frame latency (how long before an alert reaches the user)
 * against throughput (FPS). Each in-flight frame queues behind others at the server.
 *
 *     per-frame latency ≈ network_RTT + depth × server_processing_time
 *     throughput        ≈ min(1/server_time, depth / network_RTT)
 *
 * With INPUT_SIZE=512 (now optimized to ~41ms per frame on the server) and
 * measured network ≈ 131ms:
 *   1 → ~7 FPS,  latency ~131ms   (server sits idle)
 *   2 → ~13 FPS, latency ~172ms
 *   4 → ~22 FPS, latency ~216ms   ← current: 96% efficie   ncy, good FPS + safety
 *
 * At depth 4 we're hitting the ceiling (~23.5 FPS). For a blind pedestrian safety
 * app, 22 FPS is plenty smooth, and 216ms total lag = 3m at 50km/h reaction
 * distance — acceptable for urban use. Bounded queue (no fire-and-forget backlog);
 * also capped by server TARGET_FPS.
 */
export const MAX_INFLIGHT = 4;