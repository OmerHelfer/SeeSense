import cv2
import numpy as np
import logging

from core.config import TARGET_SIZE, DARK_IMAGE_THRESHOLD

logger = logging.getLogger(__name__)

BLUR_THRESHOLD = 50.0
OVEREXPOSED_THRESHOLD = 240
UNIFORM_STD_THRESHOLD = 10


def decode_image(image_bytes: bytes, target_size: int = TARGET_SIZE) -> np.ndarray:
    """
    Decode the incoming JPEG and run the quality gates on it.

    Pipeline:
    1. Decode bytes → numpy array
    2. Quality checks (covered, dark, overexposed, blurry)

    No resizing happens here. The client sends 640x640 already, and Ultralytics
    letterboxes internally from the imgsz passed to run_inference(), so a resize
    on this side was a no-op on every real frame.

    target_size is kept in the signature because callers pass the per-connection
    size positionally; it is not used for scaling here.
    """
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        raise ValueError("Failed to decode image. The file might be corrupted or not a valid image format.")

    validate_image_quality(img)

    return img


def validate_image_quality(img: np.ndarray):
    """
    Run the four quality gates on the decoded frame.
    Raises ValueError with a descriptive message for the client.

    All four read a throwaway greyscale copy, computed in as few passes over the
    image as possible: mean and standard deviation come from one meanStdDev call,
    and the blur figure from a second over the Laplacian.
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