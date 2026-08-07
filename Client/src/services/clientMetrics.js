
const STAGES = ['capture', 'encode', 'render', 'feedback'];
const WINDOW = 100;

const _buf = {};
for (const s of STAGES) _buf[s] = [];

export function recordClientStage(stage, ms) {
  const b = _buf[stage];
  if (!b || !(ms >= 0) || ms > 60000) return;
  b.push(ms);
  if (b.length > WINDOW) b.shift();
}

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

export function resetClientStages() {
  for (const s of STAGES) _buf[s].length = 0;
}
