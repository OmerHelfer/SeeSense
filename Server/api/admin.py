"""
Admin user-management API.

Two admin levels:
  1 = admin       — can view everything + manage REGULAR (level 0) users
                    (change their password, edit their details). Cannot delete
                    anyone, cannot grant/revoke admin, cannot touch admin accounts.
  2 = super admin — can do everything: delete users, grant/revoke admin levels,
                    reset system performance, and manage any account.

Guards below enforce that a level-1 admin can never act on another admin
(level >= 1) and can never change admin levels or delete users.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, EmailStr
from typing import Optional
import logging

from core.auth import verify_admin, verify_super_admin
from services.user_service import (
    get_users_overview,
    get_user_admin_view,
    admin_set_password,
    admin_update_user,
    admin_set_admin_level,
    admin_delete_user_by_email,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["Admin"])


# ==================== Schemas ====================

class SetPasswordRequest(BaseModel):
    email: EmailStr
    new_password: str


class UpdateUserRequest(BaseModel):
    email: EmailStr
    name: Optional[str] = None
    phone: Optional[str] = None
    country: Optional[str] = None
    date_of_birth: Optional[str] = None
    height_cm: Optional[float] = None
    weight_kg: Optional[float] = None


class SetLevelRequest(BaseModel):
    email: EmailStr
    admin_level: int


class DeleteUserRequest(BaseModel):
    email: EmailStr


# ==================== Helpers ====================

def _load_target(email: str) -> dict:
    target = get_user_admin_view(email)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    return target


def _require_can_manage(actor: dict, target: dict):
    """Level-1 admins may only manage regular (level 0) users. Level-2 may manage anyone."""
    if actor["admin_level"] < 2 and target["admin_level"] >= 1:
        raise HTTPException(
            status_code=403,
            detail="Level 1 admins can only manage regular users (not admins).",
        )


# ==================== Endpoints ====================

@router.get("/overview")
async def overview(current_user: dict = Depends(verify_admin)):
    """User counts: total / online / offline / admins, plus the caller's own admin
    level so the UI can gate actions. (admin level 1+)"""
    return {"status": "success", "actor_level": current_user["admin_level"], **get_users_overview()}


@router.get("/user")
async def get_user_info(email: EmailStr = Query(...), current_user: dict = Depends(verify_admin)):
    """Full info about one user by email, incl. online status + last_seen. (level 1+)"""
    target = _load_target(email)
    return {"status": "success", "user": target, "actor_level": current_user["admin_level"]}


@router.post("/user/set_password")
async def set_password(req: SetPasswordRequest, current_user: dict = Depends(verify_admin)):
    """Change a user's password by email. L1 → regular users only; L2 → anyone."""
    if len(req.new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    target = _load_target(req.email)
    _require_can_manage(current_user, target)
    admin_set_password(req.email, req.new_password)
    return {"status": "success", "message": "Password updated"}


@router.post("/user/update")
async def update_user_endpoint(req: UpdateUserRequest, current_user: dict = Depends(verify_admin)):
    """Edit a user's profile fields. L1 → regular users only; L2 → anyone."""
    target = _load_target(req.email)
    _require_can_manage(current_user, target)
    updates = req.model_dump(exclude_none=True, exclude={"email"})
    try:
        admin_update_user(req.email, updates)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "success", "user": get_user_admin_view(req.email)}


@router.post("/user/set_level")
async def set_level(req: SetLevelRequest, current_user: dict = Depends(verify_super_admin)):
    """Grant/revoke admin level (0/1/2). Super admin (level 2) only."""
    target = _load_target(req.email)
    if target["user_id"] == current_user["user_id"] and req.admin_level < 2:
        raise HTTPException(status_code=400, detail="You cannot demote your own super-admin account.")
    try:
        level = admin_set_admin_level(req.email, req.admin_level)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "success", "email": req.email, "admin_level": level}


@router.delete("/user")
async def delete_user_endpoint(req: DeleteUserRequest, current_user: dict = Depends(verify_super_admin)):
    """Delete a user by email. Super admin (level 2) only. Cannot delete yourself here."""
    target = _load_target(req.email)
    if target["user_id"] == current_user["user_id"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account from the admin panel.")
    try:
        ok = admin_delete_user_by_email(req.email)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not ok:
        raise HTTPException(status_code=404, detail="User not found")
    return {"status": "success", "message": f"User {req.email} deleted"}
