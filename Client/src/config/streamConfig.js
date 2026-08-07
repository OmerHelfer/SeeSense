
export const COMPRESSION_PERCENT = 75;

export const JPEG_QUALITY = Math.max(0, Math.min(1, 1 - COMPRESSION_PERCENT / 100));

export const INPUT_SIZE = 640;

export const MAX_INFLIGHT = 6;