import torch
import numpy as np
import logging

from core.config import CONFIDENCE_THRESHOLD, NMS_IOU_THRESHOLD

logger = logging.getLogger(__name__)


def load_model(model_path: str):
    """
    Load trained YOLO model from .pt file.
    Called once on server startup via lifespan.
    """
    logger.info(f"Loading model from {model_path}...")
    model = torch.load(model_path, map_location="cpu")
    model.eval()
    logger.info("Model loaded successfully")
    return model


def run_inference(model, img_tensor: np.ndarray) -> list[dict]:
    """
    Full inference pipeline:
    1. Convert numpy tensor to torch
    2. Run forward pass
    3. Apply NMS
    4. Parse raw output to standardized detections
    """
    with torch.no_grad():
        tensor = torch.from_numpy(img_tensor).float()
        raw_output = model(tensor)

    detections = parse_detections(raw_output)
    logger.info(f"Inference complete: {len(detections)} detections")
    return detections


def parse_detections(raw_output) -> list[dict]:
    """
    Convert raw model output to standardized detection dicts.

    Assumes YOLO-style output where each detection is:
    [x1, y1, x2, y2, confidence, class_id]

    Returns list of:
    {
        "class_name": str,
        "confidence": float,
        "bbox": [x1, y1, x2, y2]
    }
    """
    # TODO: Adjust parsing based on your exact model output format
    # This is the standard YOLO output structure

    CLASS_NAMES = {
        0: "person",
        1: "car",
        2: "bus",
        3: "truck",
        4: "motorcycle",
        5: "bicycle",
        6: "stairs",
        7: "pole",
        8: "crosswalk"
    }

    detections = []

    if isinstance(raw_output, torch.Tensor):
        output = raw_output.cpu().numpy()
    else:
        output = np.array(raw_output)

    # Handle batched output — take first batch
    if output.ndim == 3:
        output = output[0]

    for det in output:
        x1, y1, x2, y2 = det[0], det[1], det[2], det[3]
        confidence = float(det[4])
        class_id = int(det[5])

        if confidence < CONFIDENCE_THRESHOLD:
            continue

        detections.append({
            "class_name": CLASS_NAMES.get(class_id, "unknown"),
            "confidence": confidence,
            "bbox": [float(x1), float(y1), float(x2), float(y2)]
        })

    return detections