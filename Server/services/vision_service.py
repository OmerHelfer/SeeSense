import cv2
import numpy as np
import logging

from core.config import TARGET_SIZE, DARK_IMAGE_THRESHOLD, MIN_IMAGE_BYTES

logger = logging.getLogger(__name__)

# ==================== Edge Case Thresholds ====================
BLUR_THRESHOLD = 50.0          # Laplacian variance below this = blurry
OVEREXPOSED_THRESHOLD = 240    # Mean intensity above this = overexposed
UNIFORM_STD_THRESHOLD = 10     # Std deviation below this = camera covered (solid color)
MIN_RESOLUTION = 120            # Reject only genuinely tiny/garbage frames (px, longest side)


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
    # Edge case: empty or too small file
    if len(image_bytes) < MIN_IMAGE_BYTES:
        raise ValueError(f"Image too small ({len(image_bytes)} bytes). File may be empty or corrupted.")

    # 1. Decode
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        raise ValueError("Failed to decode image. The file might be corrupted or not a valid image format.")

    # 2. Resolution check on original (before resize)
    h, w = img.shape[:2]
    if max(w, h) < MIN_RESOLUTION:
        raise ValueError(
            f"Image resolution too low ({w}x{h}). Longest side must be at least {MIN_RESOLUTION}px."
        )

    # 3. Letterbox resize to the target square size
    img_resized = letterbox_resize(img, target_size)

    # 4. Quality checks on resized image (much faster than on 2048x1536)
    validate_image_quality(img_resized)

    return img_resized


def validate_image_quality(img: np.ndarray):
    """
    Run image quality checks on the resized image.
    Raises ValueError with descriptive message for the client.
    Resolution check is NOT here — it runs on the original before resize.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mean_intensity = float(np.mean(gray))
    std_intensity = float(np.std(gray))
    h, w = img.shape[:2]

    # Check 1: Camera covered (uniform solid color — black, white, or any color)
    if std_intensity < UNIFORM_STD_THRESHOLD:
        raise ValueError(
            "Camera appears to be covered or blocked. Image is a uniform color."
        )

    # Check 2: Too dark (night without light, pocket, etc.)
    if mean_intensity < DARK_IMAGE_THRESHOLD:
        raise ValueError(
            "Image is too dark. Lighting is insufficient or camera is obstructed."
        )

    # Check 3: Overexposed (direct sunlight into lens, white wall too close)
    if mean_intensity > OVEREXPOSED_THRESHOLD:
        raise ValueError(
            "Image is overexposed. Too much light or camera is facing a bright surface."
        )

    # Check 4: Blurry (out of focus, motion blur, shaking)
    laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()
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
    # decode_image now returns a 640x640 letterboxed, quality-checked image
    img_resized = decode_image(image_bytes)

    # 1. BGR → RGB
    img_rgb = cv2.cvtColor(img_resized, cv2.COLOR_BGR2RGB)

    # 2. HWC → CHW (channels first for PyTorch)
    img_transposed = img_rgb.transpose((2, 0, 1))

    # 3. Normalize to [0, 1]
    img_normalized = img_transposed.astype(np.float32) / 255.0

    # 4. Add batch dimension → (1, 3, 640, 640)
    img_tensor = np.expand_dims(img_normalized, axis=0)

    return img_tensor


def letterbox_resize(img: np.ndarray, target_size: int) -> np.ndarray:
    """
    Resize image while preserving aspect ratio, padding with gray (114).
    This is the standard YOLO preprocessing — avoids distortion.
    """
    h, w = img.shape[:2]
    scale = min(target_size / h, target_size / w)

    new_w = int(w * scale)
    new_h = int(h * scale)
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

    canvas = np.full((target_size, target_size, 3), 114, dtype=np.uint8)

    top = (target_size - new_h) // 2
    left = (target_size - new_w) // 2
    canvas[top:top + new_h, left:left + new_w] = resized

    return canvas


def is_dark_image(img: np.ndarray) -> bool:
    """
    Check if image is too dark (camera covered, night without light, etc.)
    Converts to grayscale and checks mean intensity.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mean_intensity = np.mean(gray)
    logger.debug(f"Image mean intensity: {mean_intensity:.1f}")
    return mean_intensity < DARK_IMAGE_THRESHOLD