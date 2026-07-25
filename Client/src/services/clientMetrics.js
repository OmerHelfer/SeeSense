/**
 * clientMetrics — lightweight client-side stage-timing collector.
 *
 * Mirrors the server's per-stage latency breakdown, but for the CLIENT half of the
 * pipeline. Producers (CameraView, Dashboard) call `recordClientStage(stage, ms)`
 * around the real work; VisionStream reads `getClientStageReport()` and ships the
 * aggregate to the server every few seconds (piggy-backing the existing RTT/FPS
 * report), which surfaces it on the admin dashboard.
 *
 * Zero perf impact by design: each record is one array push (+ occasional shift on
 * a bounded buffer); no timers, no allocation on the hot path beyond that. The only
 * network cost is one small extra JSON message every ~5s, alongside the RTT report.
 *
 * The client "flow" (what actually happens per frame on-device):
 *   capture   — draw the current video frame onto the offscreen canvas (drawImage)
 *   encode    — compress that canvas to a JPEG blob (canvas.toBlob)
 *   ── network round-trip (send → result) is RTT, measured separately ──
 *   render    — apply a returned result: update the overlay boxes + HUD state
 *   feedback  — dispatch voice (TTS) + haptic for a new alert (only when it fires)
 */

const STAGES = ['capture', 'encode', 'render', 'feedback'];
const WINDOW = 100; // rolling samples per stage

const _buf = {};
for (const s of STAGES) _buf[s] = [];

/** Record one stage timing (ms). Unknown stages are ignored. */
export function recordClientStage(stage, ms) {
  const b = _buf[stage];
  if (!b || !(ms >= 0) || ms > 60000) return; // guard NaN / absurd values
  b.push(ms);
  if (b.length > WINDOW) b.shift();
}

/**
 * Aggregate the current rolling windows into { stage: {avg,min,max,n} }.
 * Stages with no samples are omitted. Cheap — called at most every few seconds.
 */
export function getClientStageReport() {
  const out = {};
  for (const s of STAGES) {
    const b = _buf[s];
    if (b.length === 0) continue;
    let sum = 0, min = Infinity, max = -Infinity;
    for (const v of b) {
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[s] = {
      avg: Math.round((sum / b.length) * 100) / 100,
      min: Math.round(min * 100) / 100,
      max: Math.round(max * 100) / 100,
      n: b.length,
    };
  }
  return out;
}

/** Clear all buffers (e.g. on stream teardown). */
export function resetClientStages() {
  for (const s of STAGES) _buf[s].length = 0;
}
