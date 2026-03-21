import numpy as np
import logging

from core.config import CONFIDENCE_THRESHOLD, NMS_IOU_THRESHOLD, CLASS_NAMES

logger = logging.getLogger(__name__)

# ==================== מצב בדיקות — מודל מדומה ====================

class MockModel:
    """מודל מדומה לבדיקות בלי קובץ משקולות"""
    def __init__(self):
        logger.info("מודל מדומה פעיל — מצב בדיקות")

    def __call__(self, source, conf=0.5, iou=0.45, verbose=False):
        return []


# ==================== טעינת מודל ====================

def load_model(model_path: str, mode: str = "mock"):
    """
    טוען מודל לפי המצב הנבחר.
    
    mode:
        "mock"       — מודל מדומה, לבדיקות בלי קובץ משקולות
        "pretrained" — YOLO מוכן מ-ultralytics (למשל yolov8n.pt) לבדיקות עם מודל אמיתי
        "custom"     — המודל המאומן שלכם (אותו פורמט ultralytics)
    """
    if mode == "mock":
        logger.warning("מצב בדיקות — מודל מדומה פעיל")
        return MockModel()

    # גם pretrained וגם custom משתמשים ב-ultralytics
    from ultralytics import YOLO

    if mode == "pretrained":
        logger.info("טוען מודל YOLO מוכן לבדיקות...")
        model = YOLO("yolov8n.pt")  # יוריד אוטומטית אם לא קיים
    else:
        logger.info(f"טוען מודל מאומן מ-{model_path}...")
        model = YOLO(model_path)

    logger.info("המודל נטען בהצלחה")
    return model


# ==================== הרצת מודל ====================

def run_inference(model, img_tensor: np.ndarray) -> list[dict]:
    """
    מריץ את המודל על תמונה מעובדת ומחזיר רשימת זיהויים.
    עובד עם מודל מדומה, YOLO מוכן, ומודל מאומן.
    """
    # מודל מדומה — מחזיר רשימה ריקה
    if isinstance(model, MockModel):
        model(img_tensor)
        return []

    # ultralytics — צריך תמונה בפורמט אחר
    # ultralytics עושה preprocessing בעצמו, אז נשלח את הטנזור כמו שהוא
    results = model(
        source=img_tensor,
        conf=CONFIDENCE_THRESHOLD,
        iou=NMS_IOU_THRESHOLD,
        verbose=False
    )

    detections = parse_ultralytics_results(results)
    logger.info(f"זיהוי הושלם: {len(detections)} אובייקטים")
    return detections


# ==================== פרסור תוצאות ====================

def parse_ultralytics_results(results) -> list[dict]:
    """
    ממיר את הפלט של ultralytics לפורמט אחיד.
    עובד גם עם YOLO מוכן וגם עם מודל מאומן — אותו פורמט.
    
    כל זיהוי מוחזר כ:
    {
        "class_name": str,
        "confidence": float,
        "bbox": [x1, y1, x2, y2]
    }
    """
    detections = []

    if not results or len(results) == 0:
        return detections

    result = results[0]  # תמונה בודדת — תוצאה אחת

    if result.boxes is None or len(result.boxes) == 0:
        return detections

    boxes = result.boxes
    model_names = result.names  # המילון של המודל עצמו (מספר → שם)

    for i in range(len(boxes)):
        bbox = boxes.xyxy[i].tolist()       # [x1, y1, x2, y2]
        confidence = float(boxes.conf[i])
        class_id = int(boxes.cls[i])

        # שימוש במילון של המודל עצמו — עובד גם ל-COCO וגם למודל מאומן
        class_name = model_names.get(class_id, "unknown")

        # סינון — רק מחלקות שהמערכת שלנו מכירה
        if class_name not in CLASS_NAMES.values():
            continue

        detections.append({
            "class_name": class_name,
            "confidence": confidence,
            "bbox": [float(c) for c in bbox]
        })

    return detections


# ==================== פרסור גולמי (לשימוש עתידי אם לא ultralytics) ====================

def parse_raw_detections(raw_output) -> list[dict]:
    """
    פרסור פלט גולמי — מטריצה בפורמט [N, 6].
    לשימוש רק אם בונים מודל בלי ultralytics.
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