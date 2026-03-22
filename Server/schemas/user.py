from pydantic import BaseModel, EmailStr, field_validator
from typing import Optional
from datetime import datetime

VALID_FEEDBACK_TYPES = {"wrong_detection", "missed_obstacle", "general"}


class EmergencyContact(BaseModel):
    name: str
    phone: str
    email: Optional[str] = None


class UserCreate(BaseModel):
    name: str
    email: EmailStr
    phone: str
    password: str
    date_of_birth: Optional[str] = None
    height_cm: Optional[float] = None
    weight_kg: Optional[float] = None
    emergency_contact: Optional[EmergencyContact] = None


class UserProfile(BaseModel):
    user_id: str
    name: str
    email: EmailStr
    phone: str
    date_of_birth: Optional[str] = None
    height_cm: Optional[float] = None
    weight_kg: Optional[float] = None
    emergency_contact: Optional[EmergencyContact] = None
    created_at: str


class QuickFeedback(BaseModel):
    feedback_type: str
    record_id: Optional[str] = None

    @field_validator("feedback_type")
    @classmethod
    def validate_type(cls, v):
        if v not in VALID_FEEDBACK_TYPES:
            raise ValueError(f"Invalid feedback type. Choose from: {VALID_FEEDBACK_TYPES}")
        return v




class FeedbackUpdate(BaseModel):
    notes: Optional[str] = None
    feedback_type: Optional[str] = None

    @field_validator("feedback_type")
    @classmethod
    def validate_type(cls, v):
        if v is None:
            return v
        if v not in VALID_FEEDBACK_TYPES:
            raise ValueError(f"Invalid feedback type. Choose from: {VALID_FEEDBACK_TYPES}")
        return v
        
class FeedbackFromHistory(BaseModel):
    record_id: str
    feedback_type: str
    notes: Optional[str] = None

    @field_validator("feedback_type")
    @classmethod
    def validate_type(cls, v):
        if v not in VALID_FEEDBACK_TYPES:
            raise ValueError(f"Invalid feedback type. Choose from: {VALID_FEEDBACK_TYPES}")
        return v

class StandaloneFeedback(BaseModel):
    feedback_type: str
    notes: Optional[str] = None

    @field_validator("feedback_type")
    @classmethod
    def validate_type(cls, v):
        if v not in VALID_FEEDBACK_TYPES:
            raise ValueError(f"Invalid feedback type. Choose from: {VALID_FEEDBACK_TYPES}")
        return v

class DetectionRecord(BaseModel):
    timestamp: str
    danger: bool
    alert_level: str
    distance: str
    objects_detected: int


class EmergencyAlertRequest(BaseModel):
    user_id: str
    gps_lat: float
    gps_lon: float
    message: Optional[str] = "Emergency alert triggered"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


class ResetPasswordRequest(BaseModel):
    email: EmailStr
    code: str
    new_password: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr