from pydantic import BaseModel, EmailStr, field_validator
from typing import Optional
from datetime import datetime

VALID_FEEDBACK_TYPES = {"wrong_detection", "missed_obstacle", "general"}


class UserCreate(BaseModel):
    model_config = {"extra": "forbid"}

    name: str
    email: EmailStr
    phone: str
    password: str
    country: Optional[str] = None
    date_of_birth: Optional[str] = None
    height_cm: Optional[float] = None
    weight_kg: Optional[float] = None

    @field_validator("country")
    @classmethod
    def validate_country(cls, v):
        if v is None:
            return v
        import pycountry
        country = pycountry.countries.get(name=v) or pycountry.countries.get(alpha_2=v)
        if not country:
            raise ValueError(f"Invalid country: {v}. Use full name (e.g. 'Israel') or code (e.g. 'IL')")
        return country.name


class UserProfile(BaseModel):

    user_id: str
    name: str
    email: EmailStr
    phone: str
    country: Optional[str] = None
    date_of_birth: Optional[str] = None
    height_cm: Optional[float] = None
    weight_kg: Optional[float] = None
    created_at: str

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


class UpdateProfileRequest(BaseModel):
    model_config = {"extra": "forbid"}

    name: Optional[str] = None
    phone: Optional[str] = None
    country: Optional[str] = None
    date_of_birth: Optional[str] = None
    height_cm: Optional[float] = None
    weight_kg: Optional[float] = None

    @field_validator("country")
    @classmethod
    def validate_country(cls, v):
        if v is None:
            return v
        import pycountry
        country = pycountry.countries.get(name=v) or pycountry.countries.get(alpha_2=v)
        if not country:
            raise ValueError(f"Invalid country: {v}. Use full name (e.g. 'Israel') or code (e.g. 'IL')")
        return country.name


class EmergencyAlertRequest(BaseModel):
    gps_lat: float
    gps_lon: float


class AddEmergencyContactRequest(BaseModel):
    name: str
    phone: str
    email: EmailStr


class VerifyEmergencyContactRequest(BaseModel):
    email: EmailStr
    code: str


class ResendContactCodeRequest(BaseModel):
    email: EmailStr


class RemoveEmergencyContactRequest(BaseModel):
    email: EmailStr