import cv2
import numpy as np
import logging

from core.config import TARGET_SIZE, DARK_IMAGE_THRESHOLD, MIN_IMAGE_BYTES

logger = logging.getLogger(__name__)

# ==================== Edge Case Thresholds ====================
BLUR_THRESHOLD = 50.0          # Laplacian variance below this = blurry
OVEREXPOSED_THRESHOLD = 240    # Mean intensity above this = overexposed
UNIFORM_STD_THRESHOLD = 10     # Std deviation below this = camera covered (solid color)
MIN_RESOLUTION = 640            # Minimum width or height in pixels


def decode_image(image_bytes: bytes) -> np.ndarray:
    """
    Decode and validate image with full edge case handling.
    No resizing — ultralytics handles its own preprocessing.
    For custom PyTorch mode, process_image() handles preprocessing separately.
    """
    # Edge case: empty or too small file
    if len(image_bytes) < MIN_IMAGE_BYTES:
        raise ValueError(f"Image too small ({len(image_bytes)} bytes). File may be empty or corrupted.")

    # Decode
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        raise ValueError("Failed to decode image. The file might be corrupted or not a valid image format.")

    # Run all quality checks
    validate_image_quality(img)

    return img


def validate_image_quality(img: np.ndarray):
    """
    Run all image quality checks. Raises ValueError with descriptive message.
    Each check returns early with a specific error for the client to handle.
    """
    h, w = img.shape[:2]

    # Check 1: Resolution too low
    if w < MIN_RESOLUTION or h < MIN_RESOLUTION:
        raise ValueError(
            f"Image resolution too low ({w}x{h}). Minimum is {MIN_RESOLUTION}x{MIN_RESOLUTION}."
        )

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mean_intensity = float(np.mean(gray))
    std_intensity = float(np.std(gray))

    # Check 2: Camera covered (uniform solid color — black, white, or any color)
    if std_intensity < UNIFORM_STD_THRESHOLD:
        raise ValueError(
            "Camera appears to be covered or blocked. Image is a uniform color."
        )

    # Check 3: Too dark (night without light, pocket, etc.)
    if mean_intensity < DARK_IMAGE_THRESHOLD:
        raise ValueError(
            "Image is too dark. Lighting is insufficient or camera is obstructed."
        )

    # Check 4: Overexposed (direct sunlight into lens, white wall too close)
    if mean_intensity > OVEREXPOSED_THRESHOLD:
        raise ValueError(
            "Image is overexposed. Too much light or camera is facing a bright surface."
        )

    # Check 5: Blurry (out of focus, motion blur, shaking)
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
    1. Validate image bytes
    2. Decode
    3. Edge case checks
    4. Letterbox resize
    5. BGR → RGB → CHW → Normalize → Batch
    """
    if len(image_bytes) < MIN_IMAGE_BYTES:
        raise ValueError(f"Image too small ({len(image_bytes)} bytes). File may be empty or corrupted.")

    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        raise ValueError("Failed to decode image. The file might be corrupted or not a valid image format.")

    validate_image_quality(img)

    # 1. Letterbox resize (aspect ratio preserved)
    img_resized = letterbox_resize(img, TARGET_SIZE)

    # 2. BGR → RGB
    img_rgb = cv2.cvtColor(img_resized, cv2.COLOR_BGR2RGB)

    # 3. HWC → CHW (channels first for PyTorch)
    img_transposed = img_rgb.transpose((2, 0, 1))

    # 4. Normalize to [0, 1]
    img_normalized = img_transposed.astype(np.float32) / 255.0

    # 5. Add batch dimension → (1, 3, 640, 640)
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