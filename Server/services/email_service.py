"""
Email service for SeeSense.
Sends notifications for registration, password changes, and password reset.
Uses Gmail SMTP with app password.
"""

import smtplib
import logging
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from core.config import EMAIL_ADDRESS, EMAIL_PASSWORD

logger = logging.getLogger(__name__)

SMTP_SERVER = "smtp.gmail.com"
SMTP_PORT = 587


def send_email(to_email: str, subject: str, html_body: str) -> bool:
    """
    Send an email via Gmail SMTP.
    Returns True if sent successfully, False otherwise.
    """
    if not EMAIL_ADDRESS or not EMAIL_PASSWORD:
        logger.warning("Email credentials not configured — skipping email")
        return False

    try:
        msg = MIMEMultipart("alternative")
        msg["From"] = f"SeeSense <{EMAIL_ADDRESS}>"
        msg["To"] = to_email
        msg["Subject"] = subject
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.starttls()
            server.login(EMAIL_ADDRESS, EMAIL_PASSWORD)
            server.send_message(msg)

        logger.info(f"Email sent to {to_email}: {subject}")
        return True

    except Exception as e:
        logger.error(f"Failed to send email to {to_email}: {e}")
        return False


def send_welcome_email(to_email: str, name: str):
    """Send welcome email after registration."""
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

def send_emergency_contact_email(to_email: str, contact_name: str, user_name: str):
    """Notify emergency contact that they were added."""
    subject = "SeeSense — You Were Added as Emergency Contact"
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Hello {contact_name},</h2>
        <p><strong>{user_name}</strong> has added you as their emergency contact on SeeSense.</p>
        <p>SeeSense is a smart navigation assistant for visually impaired individuals. 
        In case of emergency, you may receive alerts with their GPS location.</p>
        <p>No action is needed from you at this time.</p>
        <br>
        <p><strong>The SeeSense Team</strong></p>
    </div>
    """
    send_email(to_email, subject, html)

def send_password_changed_email(to_email: str, name: str):
    """Send notification after password change."""
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
    """Send password reset code via email."""
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
    """Send notification after profile update."""
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