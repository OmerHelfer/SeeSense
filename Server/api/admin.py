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
    list_admins,
    admin_set_password,
    admin_update_user,
    admin_set_admin_level,
    admin_delete_user_by_email,
    get_all_feedback_admin,
    get_feedback_admin_stats,
    admin_take_feedback,
    admin_resolve_feedback,
    admin_assign_feedback,
)
from services.email_service import send_feedback_response_email
from services.stream_config_service import (
    LIMITS as STREAM_LIMITS,
    DEFAULTS as STREAM_DEFAULTS,
    get_stream_config,
    set_stream_config,
    reset_stream_config,
)

logger = logging.getLogger(__name__)

# /admin/api, not /admin: the SPA owns /admin/* as browser routes, and an API path
# that shadows one makes a refresh on that page return 401 JSON instead of the app.
router = APIRouter(prefix="/admin/api", tags=["Admin"])


def _send_email_background(func, *args):
    """Send email in a background thread — doesn't block the response."""
    import threading
    threading.Thread(target=func, args=args, daemon=True).start()



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


class ResolveFeedbackRequest(BaseModel):
    response: str


class AssignFeedbackRequest(BaseModel):
    assignee_id: str


class StreamConfigRequest(BaseModel):
    """Partial update — omitted fields keep their stored value. Ranges are clamped, not rejected."""
    input_size: Optional[int] = None
    compression_percent: Optional[int] = None
    max_inflight: Optional[int] = None



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



@router.get("/stream-config")
async def stream_config_get(current_user: dict = Depends(verify_admin)):
    """Current global streaming parameters + UI ranges + defaults. (level 1+, read-only)"""
    return {
        "status":   "success",
        "config":   get_stream_config(),
        "limits":   STREAM_LIMITS,
        "defaults": STREAM_DEFAULTS,
    }


@router.put("/stream-config")
async def stream_config_update(
    req: StreamConfigRequest,
    current_user: dict = Depends(verify_super_admin),
):
    """Update the global streaming parameters. Takes effect on each client's next scan. (level 2)"""
    try:
        config = set_stream_config(req.model_dump(exclude_none=True))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    logger.info(f"Stream config changed by {current_user['user_id']}: {config}")
    return {"status": "success", "config": config}


@router.delete("/stream-config")
async def stream_config_reset(current_user: dict = Depends(verify_super_admin)):
    """Discard overrides and return to the code defaults. (level 2 only)"""
    config = reset_stream_config()
    logger.info(f"Stream config reset by {current_user['user_id']}")
    return {"status": "success", "config": config}


@router.get("/overview")
async def overview(current_user: dict = Depends(verify_admin)):
    """User counts: total / online / offline / admins, plus the caller's own admin
    level so the UI can gate actions. (admin level 1+)"""
    return {"status": "success", "actor_level": current_user["admin_level"], **get_users_overview()}


@router.get("/admins")
async def admins_list(current_user: dict = Depends(verify_admin)):
    """All admin accounts (level 1+) with presence + last_seen, for the admin-status
    modal. Any admin (level 1 or 2) may view. (level 1+)"""
    return {"status": "success", "admins": list_admins(), "actor_level": current_user["admin_level"]}


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



@router.get("/feedback")
async def feedback_list(
    handling_status: Optional[str] = Query(None),
    current_user: dict = Depends(verify_admin),
):
    """All submitted feedbacks from all users + status counts, for the feedback
    management page. Optional ?handling_status=pending|in_progress|resolved. (level 1+)"""
    return {
        "status": "success",
        "actor_level": current_user["admin_level"],
        "stats": get_feedback_admin_stats(),
        "feedback": get_all_feedback_admin(handling_status),
    }


@router.post("/feedback/{feedback_id}/take")
async def feedback_take(feedback_id: str, current_user: dict = Depends(verify_admin)):
    """Take a pending feedback for yourself → moves it to 'in progress'. (level 1+)"""
    try:
        result = admin_take_feedback(feedback_id, current_user["user_id"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not result:
        raise HTTPException(status_code=404, detail="Feedback not found")
    return {"status": "success", "feedback": result}


@router.post("/feedback/{feedback_id}/resolve")
async def feedback_resolve(feedback_id: str, req: ResolveFeedbackRequest,
                           current_user: dict = Depends(verify_admin)):
    """Mark a feedback resolved with a required note on what was done. Only the handling
    admin or a super admin may resolve. (level 1+, ownership-gated)"""
    try:
        result = admin_resolve_feedback(
            feedback_id, current_user["user_id"], current_user["admin_level"], req.response,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not result:
        raise HTTPException(status_code=404, detail="Feedback not found")
    if result.get("user_email"):
        _send_email_background(send_feedback_response_email, result["user_email"], result.get("user_name") or "")
    return {"status": "success", "feedback": result}


@router.post("/feedback/{feedback_id}/assign")
async def feedback_assign(feedback_id: str, req: AssignFeedbackRequest,
                          current_user: dict = Depends(verify_super_admin)):
    """Assign a feedback to a specific admin who will handle it → in progress under
    them. Super admin (level 2) only."""
    try:
        result = admin_assign_feedback(feedback_id, req.assignee_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not result:
        raise HTTPException(status_code=404, detail="Feedback not found")
    return {"status": "success", "feedback": result}
