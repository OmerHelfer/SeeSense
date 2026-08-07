import cv2
import numpy as np
import logging

from core.config import TARGET_SIZE, DARK_IMAGE_THRESHOLD, MIN_IMAGE_BYTES

logger = logging.getLogger(__name__)

BLUR_THRESHOLD = 50.0
OVEREXPOSED_THRESHOLD = 240
UNIFORM_STD_THRESHOLD = 10
MIN_RESOLUTION = 120


def decode_image(image_bytes: bytes, target_size: int = TARGET_SIZE) -> np.ndarray:
    """
    Decode, validate, and resize image.

    Pipeline:
    1. Decode bytes → numpy array
    2. Check resolution on original (reject if too small)
    3. Letterbox resize to target_size (square, for performance + model input)
    4. Quality checks on resized image (blur, dark, overexposed, covered)

    target_size is the per-connection input size (client-driven); defaults to
    TARGET_SIZE. Smaller = faster inference but less detail.
    """
    if len(image_bytes) < MIN_IMAGE_BYTES:
        raise ValueError(f"Image too small ({len(image_bytes)} bytes). File may be empty or corrupted.")

    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        raise ValueError("Failed to decode image. The file might be corrupted or not a valid image format.")

    h, w = img.shape[:2]
    if max(w, h) < MIN_RESOLUTION:
        raise ValueError(
            f"Image resolution too low ({w}x{h}). Longest side must be at least {MIN_RESOLUTION}px."
        )

    img_resized = letterbox_resize(img, target_size)

    validate_image_quality(img_resized)

    return img_resized


def validate_image_quality(img: np.ndarray):
    """
    Run image quality checks on the resized image.
    Raises ValueError with descriptive message for the client.
    Resolution check is NOT here — it runs on the original before resize.

    Same four checks, same thresholds, same numbers as before — just computed
    with fewer passes over the image. See the two notes below.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _mean, _std = cv2.meanStdDev(gray)
    mean_intensity = float(_mean[0][0])
    std_intensity = float(_std[0][0])
    h, w = img.shape[:2]

    if std_intensity < UNIFORM_STD_THRESHOLD:
        raise ValueError(
            "Camera appears to be covered or blocked. Image is a uniform color."
        )

    if mean_intensity < DARK_IMAGE_THRESHOLD:
        raise ValueError(
            "Image is too dark. Lighting is insufficient or camera is obstructed."
        )

    if mean_intensity > OVEREXPOSED_THRESHOLD:
        raise ValueError(
            "Image is overexposed. Too much light or camera is facing a bright surface."
        )

    _, _lap_sd = cv2.meanStdDev(cv2.Laplacian(gray, cv2.CV_16S))
    laplacian_var = float(_lap_sd[0][0]) ** 2
    if laplacian_var < BLUR_THRESHOLD:
        raise ValueError(
            "Image is too blurry. Camera may be out of focus or moving too fast."
        )

    logger.debug(
        f"Image quality OK — mean={mean_intensity:.1f}, std={std_intensity:.1f}, "
        f"blur={laplacian_var:.1f}, resolution={w}x{h}"
    )


def process_image(image_bytes: bytes) -> np.ndarray:
    """
    Full preprocessing pipeline for custom PyTorch models:
    1. Decode + resize + quality check (via decode_image)
    2. BGR → RGB → CHW → Normalize → Batch

    Returns tensor of shape (1, 3, 640, 640)
    """
    img_resized = decode_image(image_bytes)

    img_rgb = cv2.cvtColor(img_resized, cv2.COLOR_BGR2RGB)

    img_transposed = img_rgb.transpose((2, 0, 1))

    img_normalized = img_transposed.astype(np.float32) / 255.0

    img_tensor = np.expand_dims(img_normalized, axis=0)

    return img_tensor


def letterbox_resize(img: np.ndarray, target_size: int) -> np.ndarray:
    """
    Resize image while preserving aspect ratio, padding with gray (114).
    This is the standard YOLO preprocessing — avoids distortion.
    """
    h, w = img.shape[:2]

    if h == target_size and w == target_size:
        return img

    scale = min(target_size / h, target_size / w)

    new_w = int(w * scale)
    new_h = int(h * scale)
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

    canvas = np.full((target_size, target_size, 3), 114, dtype=np.uint8)

    top = (target_size - new_h) // 2
    left = (target_size - new_w) // 2
    canvas[top:top + new_h, left:left + new_w] = resized

    return canvas