from pydantic import BaseModel, EmailStr
from typing import Optional
from datetime import datetime


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


class UserFeedback(BaseModel):
    session_id: str
    feedback_type: str  # "false_alert" | "missed_obstacle" | "good_detection"
    notes: Optional[str] = None


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