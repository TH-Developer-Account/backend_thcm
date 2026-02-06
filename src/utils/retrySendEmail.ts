import { createTransporter } from "./sendEmail";

// Retry logic for email sending
export const sendEmailWithRetry = async (
  mailOptions: any,
  maxRetries = 3,
): Promise<void> => {
  const transporter = createTransporter();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await transporter.sendMail(mailOptions);
      console.log(`✅ Email sent successfully on attempt ${attempt}`);
      return;
    } catch (error) {
      console.error(`❌ Email send attempt ${attempt} failed:`, error);

      if (attempt === maxRetries) {
        throw new Error(`Failed to send email after ${maxRetries} attempts`);
      }

      // Wait before retrying (exponential backoff)
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
};
