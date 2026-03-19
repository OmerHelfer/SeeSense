"""
Basic tests for SeeSense Server.
Run with: pytest tests/test_server.py -v
"""
import pytest
import numpy as np


# ==================== Vision Service Tests ====================

class TestVisionService:
    """Tests for image preprocessing and edge cases."""

    def test_dark_image_detection(self):
        from services.vision_service import is_dark_image
        # Black image → should be detected as dark
        black_img = np.zeros((480, 640, 3), dtype=np.uint8)
        assert is_dark_image(black_img) is True

    def test_normal_image_not_dark(self):
        from services.vision_service import is_dark_image
        # Normal brightness image
        normal_img = np.full((480, 640, 3), 128, dtype=np.uint8)
        assert is_dark_image(normal_img) is False

    def test_letterbox_preserves_shape(self):
        from services.vision_service import letterbox_resize
        # Wide image
        wide_img = np.full((300, 800, 3), 100, dtype=np.uint8)
        result = letterbox_resize(wide_img, 640)
        assert result.shape == (640, 640, 3)

    def test_letterbox_preserves_shape_tall(self):
        from services.vision_service import letterbox_resize
        # Tall image
        tall_img = np.full((800, 300, 3), 100, dtype=np.uint8)
        result = letterbox_resize(tall_img, 640)
        assert result.shape == (640, 640, 3)

    def test_process_image_small_file_rejected(self):
        from services.vision_service import process_image
        with pytest.raises(ValueError, match="too small"):
            process_image(b"tiny")

    def test_process_image_invalid_bytes_rejected(self):
        from services.vision_service import process_image
        with pytest.raises(ValueError):
            process_image(b"x" * 2000)  # Not a valid image


# ==================== Logic Service Tests ====================

class TestLogicService:
    """Tests for danger assessment logic."""

    def test_no_detections_returns_safe(self):
        from services.logic_service import assess_danger
        result = assess_danger([])
        assert result["danger"] is False
        assert result["alert_level"] == "none"
        assert result["distance"] == "Far"

    def test_close_high_risk_object_triggers_danger(self):
        from services.logic_service import assess_danger
        # Car taking 35% of frame → Close + high risk
        detections = [{
            "class_name": "car",
            "confidence": 0.9,
            "bbox": [0, 0, 380, 380]  # area = 144400, ratio ≈ 0.35
        }]
        result = assess_danger(detections)
        assert result["danger"] is True
        assert result["alert_level"] == "high"
        assert result["distance"] == "Close"

    def test_far_object_no_danger(self):
        from services.logic_service import assess_danger
        # Small object, far away
        detections = [{
            "class_name": "person",
            "confidence": 0.8,
            "bbox": [300, 300, 340, 340]  # area = 1600, ratio ≈ 0.004
        }]
        result = assess_danger(detections)
        assert result["danger"] is False
        assert result["distance"] == "Far"

    def test_low_confidence_ignored(self):
        from services.logic_service import assess_danger
        # High risk object but low confidence → ignored
        detections = [{
            "class_name": "car",
            "confidence": 0.3,
            "bbox": [0, 0, 400, 400]
        }]
        result = assess_danger(detections)
        assert result["danger"] is False
        assert len(result["objects"]) == 0

    def test_medium_distance_low_alert(self):
        from services.logic_service import assess_danger
        # Car at medium distance (15-30% of frame)
        detections = [{
            "class_name": "car",
            "confidence": 0.85,
            "bbox": [0, 0, 260, 260]  # area = 67600, ratio ≈ 0.165
        }]
        result = assess_danger(detections)
        assert result["danger"] is False
        assert result["alert_level"] == "low"
        assert result["distance"] == "Medium"

    def test_multiple_objects_picks_worst(self):
        from services.logic_service import assess_danger
        detections = [
            {
                "class_name": "person",
                "confidence": 0.8,
                "bbox": [300, 300, 340, 340]  # Far
            },
            {
                "class_name": "car",
                "confidence": 0.9,
                "bbox": [0, 0, 380, 380]  # Close
            }
        ]
        result = assess_danger(detections)
        assert result["danger"] is True
        assert result["distance"] == "Close"


# ==================== Metrics Tests ====================

class TestMetrics:
    """Tests for performance tracking."""

    def test_tracker_records_latency(self):
        from utils.metrics import PerformanceTracker
        t = PerformanceTracker()
        start = t.start_timer()
        t.end_timer(start, success=True)
        assert t.total_frames == 1
        assert t.success_count == 1
        assert t.get_avg_latency() > 0

    def test_tracker_failure_count(self):
        from utils.metrics import PerformanceTracker
        t = PerformanceTracker()
        start = t.start_timer()
        t.end_timer(start, success=False)
        assert t.failure_count == 1
        assert t.success_count == 0

    def test_tracker_status_structure(self):
        from utils.metrics import PerformanceTracker
        t = PerformanceTracker()
        status = t.get_status()
        assert "uptime_seconds" in status
        assert "total_frames" in status
        assert "latency" in status
        assert "fps" in status


# ==================== Auth Tests ====================

class TestAuth:
    """Tests for JWT authentication."""

    def test_create_and_verify_token(self):
        from core.auth import create_token
        import jwt
        from core.config import JWT_SECRET_KEY, JWT_ALGORITHM

        token = create_token("user123", "test@test.com")
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        assert payload["user_id"] == "user123"
        assert payload["email"] == "test@test.com"

    def test_expired_token_rejected(self):
        import jwt as pyjwt
        from core.config import JWT_SECRET_KEY, JWT_ALGORITHM
        from datetime import datetime, timedelta

        expired_payload = {
            "user_id": "user123",
            "email": "test@test.com",
            "exp": datetime.utcnow() - timedelta(hours=1)
        }
        token = pyjwt.encode(expired_payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)
        with pytest.raises(pyjwt.ExpiredSignatureError):
            pyjwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])