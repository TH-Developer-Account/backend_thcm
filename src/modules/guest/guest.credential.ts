import crypto from "crypto";
import bcrypt from "bcrypt";

import { SALT_ROUNDS } from "@shared/utils/contants";

// 12 random bytes -> base64url, trimmed to 16 chars. Not meant to be
// memorable (guest never chooses or types this to set it up) — only
// pasted/autofilled from the credentials email.
const generateGuestPassword = () =>
  crypto.randomBytes(12).toString("base64url").slice(0, 16);

export const createGuestCredentials = async () => {
  const plainPassword = generateGuestPassword();
  const hashedPassword = await bcrypt.hash(plainPassword, SALT_ROUNDS);
  return { plainPassword, hashedPassword };
};
