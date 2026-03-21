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
        "custom"     — Your own model trained with pure PyTorch
    """
    if mode == "mock":
        logger.warning("Testing mode — Mock Model active")
        return MockModel()

    if mode == "pretrained":
        from ultralytics import YOLO
        logger.info("Loading pretrained YOLO model for testing...")
        model = YOLO("yolov8n.pt")
        logger.info("Model loaded successfully")
        return model

    if mode == "custom":
        import torch
        logger.info(f"Loading custom PyTorch model from {model_path}...")
        model = torch.load(model_path, map_location="cpu")
        model.eval()
        logger.info("Custom model loaded successfully")
        return model

    logger.error(f"Unknown mode: {mode}")
    raise ValueError(f"Unknown mode: {mode}")


# ==================== Inference ====================

def run_inference(model, img_input) -> list[dict]:
    """
    Run model and return list of detections.
    Automatically detects model type and uses correct pipeline.

    For mock: returns empty list
    For ultralytics: passes raw image, ultralytics handles preprocessing
    For custom PyTorch: expects preprocessed tensor from process_image()
    """
    # Mock model
    if isinstance(model, MockModel):
        model(img_input)
        return []

    # Ultralytics model
    try:
        from ultralytics import YOLO
        if isinstance(model, YOLO):
            results = model(
                source=img_input,
                conf=CONFIDENCE_THRESHOLD,
                iou=NMS_IOU_THRESHOLD,
                verbose=False
            )
            detections = parse_ultralytics_results(results)
            logger.info(f"Inference complete: {len(detections)} detections")
            return detections
    except ImportError:
        pass

    # Custom PyTorch model
    import torch
    with torch.no_grad():
        tensor = torch.from_numpy(img_input).float()
        raw_output = model(tensor)

    detections = parse_raw_detections(raw_output)
    logger.info(f"Inference complete: {len(detections)} detections")
    return detections


# ==================== Ultralytics Result Parsing ====================

def parse_ultralytics_results(results) -> list[dict]:
    """
    Convert ultralytics Results object to standardized detection dicts.
    Used for pretrained YOLO mode.
    """
    detections = []

    if not results or len(results) == 0:
        return detections

    result = results[0]

    if result.boxes is None or len(result.boxes) == 0:
        return detections

    boxes = result.boxes
    model_names = result.names

    for i in range(len(boxes)):
        bbox = boxes.xyxy[i].tolist()
        confidence = float(boxes.conf[i])
        class_id = int(boxes.cls[i])

        class_name = model_names.get(class_id, "unknown")
        class_name = class_name.replace(" ", "_")

        if class_name not in CLASS_NAMES.values():
            continue

        detections.append({
            "class_name": class_name,
            "confidence": confidence,
            "bbox": [float(c) for c in bbox]
        })

    return detections


# ==================== Raw PyTorch Result Parsing ====================

def parse_raw_detections(raw_output) -> list[dict]:
    """
    Parse raw PyTorch model output — matrix of shape [N, 6].
    Each row: [x1, y1, x2, y2, confidence, class_id]
    Used for custom trained model mode.
    """
    import torch

    detections = []

    if isinstance(raw_output, torch.Tensor):
        output = raw_output.cpu().numpy()
    else:
        output = np.array(raw_output)

    if output.ndim == 3:
        output = output[0]

    if output.size == 0:
        return detections

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