// services/emailService.ts
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

// Create Outlook SMTP transporter
export const createTransporter = (): Transporter => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST, // smtp.office365.com
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: false, // true for 465, false for other ports (587 uses STARTTLS)
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      ciphers: "SSLv3", // Required for Office 365
      rejectUnauthorized: true,
    },
  });
};

// Verify SMTP connection
export const verifyEmailConnection = async (): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    await transporter.verify();
    console.log("✅ Outlook SMTP server is ready to send emails");
    return true;
  } catch (error) {
    console.error("❌ Outlook SMTP connection error:", error);
    return false;
  }
};

// Send password reset email
export const sendPasswordResetEmail = async (
  email: string,
  resetToken: string,
): Promise<void> => {
  try {
    const transporter = createTransporter();
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

    const mailOptions = {
      from: {
        name: process.env.EMAIL_FROM_NAME || "Your App",
        address: process.env.EMAIL_FROM || process.env.SMTP_USER!,
      },
      to: email,
      subject: "Reset Your Password",
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              line-height: 1.6;
              color: #333;
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
              background-color: #f4f4f4;
            }
            .container {
              background-color: #ffffff;
              border-radius: 10px;
              padding: 30px;
              box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            }
            .header {
              text-align: center;
              margin-bottom: 30px;
              border-bottom: 3px solid #0078d4;
              padding-bottom: 20px;
            }
            .header h1 {
              color: #0078d4;
              margin: 0;
              font-size: 28px;
            }
            .content {
              padding: 20px 0;
            }
            .button {
              display: inline-block;
              padding: 14px 35px;
              background-color: #0078d4;
              color: white !important;
              text-decoration: none;
              border-radius: 6px;
              margin: 25px 0;
              font-weight: bold;
              font-size: 16px;
              transition: background-color 0.3s;
            }
            .button:hover {
              background-color: #005a9e;
            }
            .button-container {
              text-align: center;
            }
            .link {
              word-break: break-all;
              color: #666;
              font-size: 13px;
              background-color: #f8f8f8;
              padding: 12px;
              border-radius: 5px;
              margin: 15px 0;
            }
            .warning {
              background-color: #fff4ce;
              border-left: 4px solid #ffaa00;
              padding: 15px;
              margin: 20px 0;
              border-radius: 4px;
            }
            .warning-title {
              font-weight: bold;
              color: #cc7a00;
              margin-bottom: 8px;
            }
            .warning ul {
              margin: 8px 0;
              padding-left: 20px;
            }
            .footer {
              text-align: center;
              margin-top: 30px;
              padding-top: 20px;
              border-top: 1px solid #e0e0e0;
              color: #666;
              font-size: 12px;
            }
            .icon {
              font-size: 48px;
              margin-bottom: 10px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div class="icon">🔐</div>
              <h1>Password Reset Request</h1>
            </div>

            <div class="content">
              <p>Hello,</p>

              <p>We received a request to reset the password for your account. If you made this request, click the button below to create a new password:</p>

              <div class="button-container">
                <a href="${resetUrl}" class="button">Reset My Password</a>
              </div>

              <p style="color: #666; font-size: 14px;">Or copy and paste this link into your browser:</p>
              <div class="link">${resetUrl}</div>

              <div class="warning">
                <div class="warning-title">⚠️ Important Security Information</div>
                <ul style="margin: 10px 0;">
                  <li>This link will <strong>expire in 1 hour</strong></li>
                  <li>This link can only be <strong>used once</strong></li>
                  <li>If you didn't request this password reset, <strong>please ignore this email</strong></li>
                  <li>Your password will remain unchanged unless you click the link above</li>
                </ul>
              </div>

              <p style="margin-top: 25px;">For your security, we never send passwords via email. If you have any concerns about your account security, please contact our support team immediately.</p>
            </div>

            <div class="footer">
              <p><strong>This is an automated message. Please do not reply to this email.</strong></p>
              <p>&copy; ${new Date().getFullYear()} ${process.env.EMAIL_FROM_NAME || "Your App"}. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
Password Reset Request

Hello,

We received a request to reset the password for your account. If you made this request, click the link below to create a new password:

${resetUrl}

Important Security Information:
- This link will expire in 1 hour
- This link can only be used once
- If you didn't request this password reset, please ignore this email
- Your password will remain unchanged unless you click the link above

For your security, we never send passwords via email.

This is an automated message. Please do not reply to this email.

© ${new Date().getFullYear()} ${process.env.EMAIL_FROM_NAME || "Your App"}. All rights reserved.
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ Password reset email sent to: ${email}`);
  } catch (error) {
    console.error("❌ Error sending email via Outlook:", error);
    throw new Error("Failed to send password reset email");
  }
};
