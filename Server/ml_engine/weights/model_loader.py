import numpy as np
import logging

from core.config import CONFIDENCE_THRESHOLD, NMS_IOU_THRESHOLD, CLASS_NAMES

logger = logging.getLogger(__name__)

# ==================== Mock Model (Testing Mode) ====================

class MockModel:
    """Dummy model for testing without weight files"""
    def __init__(self):
        logger.info("Mock Model initialized — testing mode active")

    def __call__(self, source, conf=0.5, iou=0.45, verbose=False):
        return []


# ==================== Model Loading ====================

def load_model(model_path: str, mode: str = "mock"):
    """
    Load model based on selected mode.
    
    mode:
        "mock"       — Dummy model, for testing without weight files
        "pretrained" — Pretrained YOLO from ultralytics (e.g. yolov8n.pt)
        "custom"     — Your trained model (same ultralytics format)
    """
    if mode == "mock":
        logger.warning("Testing mode — Mock Model active")
        return MockModel()

    # Both pretrained and custom use ultralytics
    from ultralytics import YOLO

    if mode == "pretrained":
        logger.info("Loading pretrained YOLO model for testing...")
        model = YOLO("yolov8n.pt")  # Auto-downloads if not present
    else:
        logger.info(f"Loading custom trained model from {model_path}...")
        model = YOLO(model_path)

    logger.info("Model loaded successfully")
    return model


# ==================== Inference ====================

def run_inference(model, img_tensor: np.ndarray) -> list[dict]:
    """
    Run model on preprocessed image and return list of detections.
    Works with mock model, pretrained YOLO, and custom trained model.
    """
    # Mock model — returns empty list
    if isinstance(model, MockModel):
        model(img_tensor)
        return []

    # Ultralytics inference
    results = model(
        source=img_tensor,
        conf=CONFIDENCE_THRESHOLD,
        iou=NMS_IOU_THRESHOLD,
        verbose=False
    )

    detections = parse_ultralytics_results(results)
    logger.info(f"Inference complete: {len(detections)} detections")
    return detections


# ==================== Result Parsing ====================

def parse_ultralytics_results(results) -> list[dict]:
    """
    Convert ultralytics Results object to standardized detection dicts.
    Works with both pretrained YOLO and custom trained models — same format.
    
    Each detection returned as:
    {
        "class_name": str,
        "confidence": float,
        "bbox": [x1, y1, x2, y2]
    }
    """
    detections = []

    if not results or len(results) == 0:
        return detections

    result = results[0]  # Single image — single result

    if result.boxes is None or len(result.boxes) == 0:
        return detections

    boxes = result.boxes
    model_names = result.names  # Model's own class mapping (id → name)

    for i in range(len(boxes)):
        bbox = boxes.xyxy[i].tolist()       # [x1, y1, x2, y2]
        confidence = float(boxes.conf[i])
        class_id = int(boxes.cls[i])

        # Use the model's own class mapping — works for both COCO and custom
        class_name = model_names.get(class_id, "unknown")
        class_name = class_name.replace(" ", "_")

        # Filter — only keep classes our system recognizes
        if class_name not in CLASS_NAMES.values():
            continue

        detections.append({
            "class_name": class_name,
            "confidence": confidence,
            "bbox": [float(c) for c in bbox]
        })

    return detections


# ==================== Raw Parsing (for future non-ultralytics use) ====================

def parse_raw_detections(raw_output) -> list[dict]:
    """
    Parse raw model output — matrix of shape [N, 6].
    Only used if building a model without ultralytics.
    """
    import torch

    detections = []

    if isinstance(raw_output, torch.Tensor):
        output = raw_output.cpu().numpy()
    else:
        output = np.array(raw_output)

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