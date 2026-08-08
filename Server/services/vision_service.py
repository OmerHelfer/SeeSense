import cv2
import numpy as np
import logging

from core.config import TARGET_SIZE, DARK_IMAGE_THRESHOLD

logger = logging.getLogger(__name__)

BLUR_THRESHOLD = 50.0
OVEREXPOSED_THRESHOLD = 240
UNIFORM_STD_THRESHOLD = 10


def decode_image(image_bytes: bytes, target_size: int = TARGET_SIZE) -> np.ndarray:
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        raise ValueError("Failed to decode image. The file might be corrupted or not a valid image format.")

    validate_image_quality(img)

    return img


def validate_image_quality(img: np.ndarray):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _mean, _std = cv2.meanStdDev(gray)
    mean_intensity = float(_mean[0][0])
    std_intensity = float(_std[0][0])
    h, w = img.shape[:2]

    if std_intensity < UNIFORM_STD_THRESHOLD:
        raise ValueError(
        )

    if mean_intensity < DARK_IMAGE_THRESHOLD:
        raise ValueError(
        )

    if mean_intensity > OVEREXPOSED_THRESHOLD:
        raise ValueError(
        )

    _, _lap_sd = cv2.meanStdDev(cv2.Laplacian(gray, cv2.CV_16S))
    laplacian_var = float(_lap_sd[0][0]) ** 2
    if laplacian_var < BLUR_THRESHOLD:
        raise ValueError(
        )

    logger.debug(
        f"Image quality OK — mean={mean_intensity:.1f}, std={std_intensity:.1f}, "
        f"blur={laplacian_var:.1f}, resolution={w}x{h}"
    )