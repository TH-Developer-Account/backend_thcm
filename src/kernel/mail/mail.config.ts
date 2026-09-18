import nodemailer from "nodemailer";

// ─────────────────────────────────────────────────────────────────────────────
// Single shared transporter instance for the lifetime of the process.
//
// WHY singleton: nodemailer transports maintain a connection pool internally.
// Creating a new transporter per mail call throws away that pool and adds
// unnecessary TCP handshake overhead on every send.
//
// Required env vars:
//   MAIL_HOST     — e.g. smtp.office365.com
//   MAIL_PORT     — 587 (STARTTLS) for O365 Basic Auth
//   MAIL_USER     — shared sender address, e.g. noreply@yourcompany.com
//   MAIL_PASSWORD — account password (Basic Auth)
// ─────────────────────────────────────────────────────────────────────────────

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
//     // Only set rejectUnauthorized: false in local dev if truly needed.
//     // Never disable in production — O365 certs are valid.
//     rejectUnauthorized: true,
//   },
// });

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_MAIL_ID,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

export default transporter;
