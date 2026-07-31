import numpy as np
import logging
import torch

from core.config import (
    CONFIDENCE_THRESHOLD, NMS_IOU_THRESHOLD, CLASS_NAMES, TARGET_SIZE, MODEL_PATH,
    ONNX_NUM_THREADS,
)

logger = logging.getLogger(__name__)


# ==================== ONNX Runtime thread cap ====================

_onnx_threads_configured = False


def _configure_onnx_threads():
    """
    Cap ONNX Runtime's thread pool before any session is created.

    Ultralytics builds its session as `InferenceSession(weight, providers=...)`
    with no SessionOptions, so ONNX Runtime falls back to its default: one intra-op
    thread per CPU core it can see. Inside a container it sees the HOST's cores
    (e.g. 32) while being scheduled only a fraction of one vCPU — so the threads
    fight over a sliver of CPU, context-switch constantly, and starve the whole
    process. That is what took YOLO to 2323ms on Railway and dragged even OpenCV
    decode from 2.4ms to 139ms.

    There is no environment variable for this (modern ONNX Runtime builds don't use
    OpenMP, so OMP_NUM_THREADS won't do it), and Ultralytics exposes no hook — so we
    wrap the constructor to inject our SessionOptions. Idempotent.
    """
    global _onnx_threads_configured
    if _onnx_threads_configured:
        return

    # 0 = leave ONNX Runtime's defaults alone (the original, uncapped behaviour).
    if ONNX_NUM_THREADS <= 0:
        logger.warning(
            "ONNX thread cap DISABLED (ONNX_NUM_THREADS=0) — ONNX Runtime will size its "
            "pool from the host core count. On a CPU-limited container this is what caused "
            "the 2323ms/frame regression. Set ONNX_NUM_THREADS=2 to re-enable the cap."
        )
        _onnx_threads_configured = True
        return

    try:
        import onnxruntime
    except ImportError:
        return

    original = onnxruntime.InferenceSession

    def _session_with_thread_cap(*args, **kwargs):
        if kwargs.get("sess_options") is None:
            opts = onnxruntime.SessionOptions()
            opts.intra_op_num_threads = ONNX_NUM_THREADS   # threads inside one op
            opts.inter_op_num_threads = 1                  # ops run one at a time
            opts.execution_mode = onnxruntime.ExecutionMode.ORT_SEQUENTIAL
            kwargs["sess_options"] = opts
        return original(*args, **kwargs)

    onnxruntime.InferenceSession = _session_with_thread_cap
    _onnx_threads_configured = True
    logger.info(f"ONNX Runtime thread cap applied: intra_op={ONNX_NUM_THREADS}, inter_op=1")


# ==================== Device Detection ====================

def _select_device() -> str:
    """
    Pick the inference device for the configured model.

    A CUDA-capable GPU is not enough on its own for an ONNX model: the plain
    'onnxruntime' package is a CPU-only build with no CUDA execution provider,
    and asking it for CUDA fails at inference time with
        "no data transfer registered for copying tensors from Device:[...]"
    — i.e. it loads fine and only blows up on the first frame. So for .onnx we
    additionally require the CUDA provider to actually be present, and fall back
    to CPU when it isn't. (To use a GPU with ONNX, install onnxruntime-gpu
    instead of onnxruntime.) PyTorch .pt models keep the plain torch check.
    """
    if not torch.cuda.is_available():
        return "cpu"

    if str(MODEL_PATH).lower().endswith(".onnx"):
        try:
            import onnxruntime
            if "CUDAExecutionProvider" not in onnxruntime.get_available_providers():
                logger.warning(
                    "GPU present but onnxruntime has no CUDA provider — running ONNX on CPU. "
                    "Install onnxruntime-gpu to use the GPU."
                )
                return "cpu"
        except ImportError:
            return "cpu"

    return "cuda"


DEVICE = _select_device()
logger.info(f"Inference device: {DEVICE} (model: {MODEL_PATH})")


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

    # if mode == "custom":
    #     logger.info(f"Loading custom PyTorch model from {model_path}...")
    #     model = torch.load(model_path, map_location=DEVICE)
    #     model.eval()
    #     logger.info(f"Custom model loaded successfully on {DEVICE}")
    #     return model
    if mode == "custom":
        from ultralytics import YOLO
        # Must run BEFORE YOLO() builds the session — see _configure_onnx_threads.
        if str(model_path).lower().endswith(".onnx"):
            _configure_onnx_threads()
        logger.info(f"Loading custom YOLO model from {model_path}...")
        model = YOLO(model_path)
        logger.info(f"Custom model loaded successfully on {DEVICE}")
        return model


    logger.error(f"Unknown mode: {mode}")
    raise ValueError(f"Unknown mode: {mode}")


# ==================== Inference ====================

def run_inference(model, img_input, imgsz: int = TARGET_SIZE) -> list[dict]:
    """
    Run model and return list of detections.
    Automatically detects model type and uses correct pipeline.

    For mock: returns empty list
    For ultralytics: passes raw image, ultralytics handles preprocessing
    For custom PyTorch: expects preprocessed tensor from process_image()

    imgsz is the square inference size — the main inference-speed lever.
    Detections are always returned in the input image's coordinate space, so the
    caller's overlay stays correct regardless of imgsz.
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
                imgsz=imgsz,
                device=DEVICE,
                verbose=False
            )
            detections = parse_ultralytics_results(results)
            logger.info(f"Inference complete: {len(detections)} detections")
            return detections
    except ImportError:
        pass

    # Custom PyTorch model
    with torch.no_grad():
        tensor = torch.from_numpy(img_input).float().to(DEVICE)
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