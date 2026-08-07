// Runtime streaming config, owned by the server and applied via the WS "connected"
// message (see applyStreamConfig). Values below are only the pre-connect fallback —
// read them through the getters, never by destructuring a snapshot at module load.

const DEFAULTS = {
  inputSize:          640,
  compressionPercent: 60,
  maxInflight:        6,
};

// Mirrors Server/services/stream_config_service.py — the server clamps on write
// and is the authority; this only keeps the fallback sane before first connect.
const LIMITS = {
  inputSize:          { min: 160, max: 640 },
  compressionPercent: { min: 0,   max: 95  },
  maxInflight:        { min: 1,   max: 16  },
};

let _current = { ...DEFAULTS };

const clamp = (field, n) =>
  Math.max(LIMITS[field].min, Math.min(LIMITS[field].max, Math.round(n)));

export const getInputSize = () => _current.inputSize;
export const getMaxInflight = () => _current.maxInflight;
export const getCompressionPercent = () => _current.compressionPercent;
export const getJpegQuality = () =>
  Math.max(0, Math.min(1, 1 - _current.compressionPercent / 100));
export const getStreamConfig = () => ({ ..._current });

export function applyStreamConfig({ input_size, compression_percent, max_inflight } = {}) {
  if (Number.isFinite(input_size))          _current.inputSize          = clamp('inputSize', input_size);
  if (Number.isFinite(compression_percent)) _current.compressionPercent = clamp('compressionPercent', compression_percent);
  if (Number.isFinite(max_inflight))        _current.maxInflight        = clamp('maxInflight', max_inflight);
  return getStreamConfig();
}
