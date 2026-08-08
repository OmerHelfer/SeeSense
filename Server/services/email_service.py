
import smtplib
import logging
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from core.config import EMAIL_ADDRESS, EMAIL_PASSWORD

logger = logging.getLogger(__name__)

SMTP_SERVER = "smtp.gmail.com"
SMTP_PORT = 587


def send_email(to_email: str, subject: str, html_body: str) -> bool:
    if not EMAIL_ADDRESS or not EMAIL_PASSWORD:
        logger.warning("Email credentials not configured — skipping email")
        return False

    try:
        msg = MIMEMultipart("alternative")
        msg["From"] = f"SeeSense <{EMAIL_ADDRESS}>"
        msg["To"] = to_email
        msg["Subject"] = subject
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=10) as server:
            server.starttls()
            server.login(EMAIL_ADDRESS, EMAIL_PASSWORD)
            server.send_message(msg)

        logger.info(f"Email sent to {to_email}: {subject}")
        return True

    except Exception as e:
        logger.error(f"Failed to send email to {to_email}: {e}")
        return False


def send_welcome_email(to_email: str, name: str):
    subject = "Welcome to SeeSense"
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Welcome to SeeSense, {name}!</h2>
        <p>Your account has been created successfully.</p>
        <p>SeeSense is your smart navigation assistant, designed to help you 
        move safely and independently in urban environments.</p>
        <br>
        <p>Stay safe,</p>
        <p><strong>The SeeSense Team</strong></p>
    </div>
    """
    send_email(to_email, subject, html)


def send_password_changed_email(to_email: str, name: str):
    subject = "SeeSense — Password Changed"
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Password Changed</h2>
        <p>Hi {name},</p>
        <p>Your SeeSense password has been changed successfully.</p>
        <p>If you did not make this change, please contact us immediately.</p>
        <br>
        <p><strong>The SeeSense Team</strong></p>
    </div>
    """
    send_email(to_email, subject, html)


def send_password_reset_email(to_email: str, name: str, reset_code: str):
    subject = "SeeSense — Password Reset Code"
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Password Reset</h2>
        <p>Hi {name},</p>
        <p>You requested a password reset. Use this code to reset your password:</p>
        <div style="background: #f0f0f0; padding: 20px; text-align: center; 
                    font-size: 32px; letter-spacing: 8px; font-weight: bold; 
                    border-radius: 8px; margin: 20px 0;">
            {reset_code}
        </div>
        <p>This code expires in 15 minutes.</p>
        <p>If you did not request this, ignore this email.</p>
        <br>
        <p><strong>The SeeSense Team</strong></p>
    </div>
    """
    send_email(to_email, subject, html)


def send_profile_updated_email(to_email: str, name: str):
    subject = "SeeSense — Profile Updated"
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Profile Updated</h2>
        <p>Hi {name},</p>
        <p>Your SeeSense profile has been updated.</p>
        <p>If you did not make this change, please change your password immediately.</p>
        <br>
        <p><strong>The SeeSense Team</strong></p>
    </div>
    """
    send_email(to_email, subject, html)


def send_feedback_response_email(to_email: str, name: str):
    subject = "SeeSense — Your feedback was handled"
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">The team responded to your feedback</h2>
        <p>Hi {name},</p>
        <p>A member of the SeeSense team has reviewed and handled a feedback you submitted.</p>
        <p>Open the app → Settings → "משובים שנשלחו" (Sent feedback) to read the response.</p>
        <br>
        <p>Thank you for helping us improve,</p>
        <p><strong>The SeeSense Team</strong></p>
    </div>
    """
    send_email(to_email, subject, html)


def send_emergency_contact_verification_email(to_email: str, contact_name: str, user_name: str, code: str):
    subject = "SeeSense — Emergency Contact Verification"
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Emergency Contact Verification</h2>
        <p>Hello {contact_name},</p>
        <p><strong>{user_name}</strong> wants to add you as their emergency contact on SeeSense.</p>
        <p>SeeSense is a smart navigation assistant for visually impaired individuals.
        As an emergency contact, you may receive alerts with their GPS location in case of distress.</p>
        <p>To confirm, share this code with {user_name}:</p>
        <div style="background: #f0f0f0; padding: 20px; text-align: center;
                    font-size: 32px; letter-spacing: 8px; font-weight: bold;
                    border-radius: 8px; margin: 20px 0;">
            {code}
        </div>
        <p>This code expires in 30 minutes.</p>
        <p>If you do not know this person, you can safely ignore this email.</p>
        <br>
        <p><strong>The SeeSense Team</strong></p>
    </div>
    """
    send_email(to_email, subject, html)


def send_emergency_contact_confirmed_email(to_email: str, contact_name: str, user_name: str):
    subject = "SeeSense — You Are Now an Emergency Contact"
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Confirmed as Emergency Contact</h2>
        <p>Hello {contact_name},</p>
        <p>You have been confirmed as an emergency contact for <strong>{user_name}</strong> on SeeSense.</p>
        <p>In case of emergency, you will receive an alert with their GPS location.</p>
        <br>
        <p><strong>The SeeSense Team</strong></p>
    </div>
    """
    send_email(to_email, subject, html)


def send_emergency_contact_removed_email(to_email: str, contact_name: str, user_name: str):
    subject = "SeeSense — Emergency Contact Removed"
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Emergency Contact Removed</h2>
        <p>Hello {contact_name},</p>
        <p>You have been removed as an emergency contact for <strong>{user_name}</strong> on SeeSense.</p>
        <p>You will no longer receive emergency alerts for this user.</p>
        <br>
        <p><strong>The SeeSense Team</strong></p>
    </div>
    """
    send_email(to_email, subject, html)


def send_contact_verified_notification(to_email: str, user_name: str, contact_name: str):
    subject = "SeeSense — Emergency Contact Verified"
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Contact Verified</h2>
        <p>Hi {user_name},</p>
        <p><strong>{contact_name}</strong> has been verified as your emergency contact.</p>
        <p>They will now receive alerts in case of emergency.</p>
        <br>
        <p><strong>The SeeSense Team</strong></p>
    </div>
    """
    send_email(to_email, subject, html)


def send_contact_expired_notification(to_email: str, user_name: str, contact_name: str):
    subject = "SeeSense — Emergency Contact Expired"
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Contact Not Verified</h2>
        <p>Hi {user_name},</p>
        <p><strong>{contact_name}</strong> did not verify in time and has been removed from your emergency contacts.</p>
        <p>You can add them again if you'd like to retry.</p>
        <br>
        <p><strong>The SeeSense Team</strong></p>
    </div>
    """
    send_email(to_email, subject, html)

def send_emergency_alert_email(to_email: str, contact_name: str, user_name: str,
                               maps_link: str | None):
    subject = "URGENT — SeeSense Emergency Alert"

    if maps_link:
        location_block = f"""
        <p>Their current location:</p>
        <a href="{maps_link}" style="display: inline-block; background: #e74c3c; color: white;
           padding: 15px 30px; text-decoration: none; border-radius: 8px; font-size: 18px;">
            View Location on Google Maps
        </a>"""
    else:
        location_block = """
        <p style="background: #fff3cd; border: 1px solid #ffc107; padding: 12px; border-radius: 8px;">
            <strong>Location unavailable.</strong> Their device could not determine a GPS
            position for this alert. Please contact them directly.
        </p>"""

    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 3px solid #e74c3c; padding: 20px;">
        <h2 style="color: #e74c3c;">EMERGENCY ALERT</h2>
        <p>Hi {contact_name},</p>
        <p><strong>{user_name}</strong> has triggered an emergency alert on SeeSense.</p>
        {location_block}
        <br><br>
        <p>Please try to contact them or send help immediately.</p>
        <br>
        <p><strong>The SeeSense Team</strong></p>
    </div>
    """
    send_email(to_email, subject, html)

def send_account_deleted_email(to_email: str, name: str):
    subject = "SeeSense — Account Deleted"
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Account Deleted</h2>
        <p>Hi {name},</p>
        <p>Your SeeSense account and all associated data have been permanently deleted.</p>
        <p>If you did not request this, please contact us immediately.</p>
        <br>
        <p><strong>The SeeSense Team</strong></p>
    </div>
    """
    send_email(to_email, subject, html)


def send_account_deleted_to_contact(to_email: str, contact_name: str, user_name: str):
    subject = "SeeSense — Account Closed"
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Account Closed</h2>
        <p>Hello {contact_name},</p>
        <p><strong>{user_name}</strong> has closed their SeeSense account.</p>
        <p>You will no longer receive emergency alerts for this user.</p>
        <br>
        <p><strong>The SeeSense Team</strong></p>
    </div>
    """
    send_email(to_email, subject, html)