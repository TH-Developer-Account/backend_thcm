// // utils/email.ts
// import { Resend } from "resend";

// const resend = new Resend(process.env.RESEND_API_KEY);

// export const sendPasswordResetEmail = async (
//   email: string,
//   resetToken: string,
// ) => {
//   const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

//   try {
//     await resend.emails.send({
//       from: "noreply@yourdomain.com", // Change to your verified domain
//       to: email,
//       subject: "Reset Your Password",
//       html: `
//         <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
//           <h2>Password Reset Request</h2>
//           <p>You requested to reset your password. Click the button below to proceed:</p>
//           <a href="${resetUrl}"
//              style="display: inline-block; padding: 12px 24px; background-color: #007bff;
//                     color: white; text-decoration: none; border-radius: 5px; margin: 20px 0;">
//             Reset Password
//           </a>
//           <p>Or copy and paste this link:</p>
//           <p style="color: #666; word-break: break-all;">${resetUrl}</p>
//           <p><strong>This link will expire in 1 hour.</strong></p>
//           <p>If you didn't request this, please ignore this email.</p>
//         </div>
//       `,
//     });
//   } catch (error) {
//     console.error("Email send error:", error);
//     throw new Error("Failed to send reset email");
//   }
// };
