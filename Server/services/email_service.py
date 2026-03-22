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


def send_emergency_contact_verification_email(to_email: str, contact_name: str, user_name: str, code: str):
    """Send verification code to emergency contact."""
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
    """Notify emergency contact that they have been confirmed."""
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
    """Notify emergency contact that they have been removed."""
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