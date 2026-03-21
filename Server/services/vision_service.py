import cv2
import numpy as np
import logging

from core.config import TARGET_SIZE, DARK_IMAGE_THRESHOLD, MIN_IMAGE_BYTES

logger = logging.getLogger(__name__)


def decode_image(image_bytes: bytes) -> np.ndarray:
    """
    Decode and validate image only — no preprocessing.
    Used when passing image to ultralytics (it does its own preprocessing).
    """
    if len(image_bytes) < MIN_IMAGE_BYTES:
        raise ValueError(f"Image too small ({len(image_bytes)} bytes). File may be empty or corrupted.")

    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        raise ValueError("Failed to decode image. The file might be corrupted or not a valid image format.")

    if is_dark_image(img):
        raise ValueError("Image is too dark. The camera may be covered or lighting is insufficient.")

    return img


def process_image(image_bytes: bytes) -> np.ndarray:
    """
    Full preprocessing pipeline:
    1. Validate image bytes
    2. Decode
    3. Edge case checks (dark/black image)
    4. Letterbox resize
    5. BGR → RGB → CHW → Normalize → Batch
    """
    # Edge case: empty or too small file
    if len(image_bytes) < MIN_IMAGE_BYTES:
        raise ValueError(f"Image too small ({len(image_bytes)} bytes). File may be empty or corrupted.")

    # Decode
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        raise ValueError("Failed to decode image. The file might be corrupted or not a valid image format.")

    # Edge case: dark/black image (low light conditions)
    if is_dark_image(img):
        raise ValueError("Image is too dark. The camera may be covered or lighting is insufficient.")

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