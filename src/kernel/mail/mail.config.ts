import nodemailer from "nodemailer";
// import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

// ─────────────────────────────────────────────────────────────────────────────
// Single shared transporter instance for the lifetime of the process.
//
// WHY singleton: the SES client reuses its underlying HTTP connections, so
// creating a new transporter per mail call would throw that reuse away.
//
// Required env vars:
//   AWS_SES_REGION             — region where the sender identity is verified,
//                                e.g. ap-south-1 (identities are per-region)
//   AWS_SES_ACCESS_KEY_ID      — IAM user key allowed to call ses:SendEmail
//   AWS_SES_SECRET_ACCESS_KEY  — secret for the key above
//   MAIL_FROM                  — verified SES sender,
//                                e.g. noreply@tatahitachi.co.in
// ─────────────────────────────────────────────────────────────────────────────

// WHY MAIL_FROM lives here: the sender must belong to the identity verified
// for whichever provider is active, so it is defined next to the transporter.
// Consumers import it instead of reading provider-specific env vars.
// export const MAIL_FROM = process.env.MAIL_FROM;

export const MAIL_FROM = "marketing.tatahitachi@gmail.com";

// const sesClient = new SESv2Client({
//   region: process.env.AWS_REGION,
//   credentials: {
//     accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
//     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
//   },
// });

// const transporter = nodemailer.createTransport({
//   SES: { sesClient, SendEmailCommand },
// });

// Gmail (app password)

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_MAIL_ID,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

export default transporter;

// ─────────────────────────────────────────────────────────────────────────────
// Previous providers, kept commented out in case we need to switch back.
// If reviving one, also restore its env vars and point MAIL_FROM at an
// address that provider allows.
// ─────────────────────────────────────────────────────────────────────────────

// Office 365 (Basic Auth over STARTTLS)
//
// const transporter = nodemailer.createTransport({
//   host: process.env.MAIL_HOST,
//   port: Number(process.env.MAIL_PORT ?? 587),
//   secure: false, // STARTTLS — O365 requires false on port 587
//   auth: {
//     user: process.env.MAIL_USER,
//     pass: process.env.MAIL_PASSWORD,
//   },
//   tls: {
//     // O365 requires TLS 1.2+; do not downgrade
//     minVersion: "TLSv1.2",
//     rejectUnauthorized: true,
//   },
// });
