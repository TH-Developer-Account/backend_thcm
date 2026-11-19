import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

// Reusable-login-session auth, distinct from requireVendorAccessToken
// (one-time emailed link, scoped to a single subject) — see that file's
// comment for the reasoning. A guest is not a User: no workspaceId,
// no permissions array, nothing for authorize() to check.

export const requireGuestAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : undefined;

    if (!token) throw new ApiError(401, "No token provided");

    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!) as {
      sub: string;
      type: string;
    };

    // Structural check, not just a lookup failure — rejects a staff token
    // outright rather than letting it fall through to "guest not found".
    if (decoded.type !== "GUEST") {
      throw new ApiError(401, "Invalid guest session");
    }

    const guest = await prisma.guest.findUnique({
      where: { id: decoded.sub },
      select: { id: true, mobile: true, email: true },
    });

    if (!guest) throw new ApiError(401, "Guest not found");

    req.guest = guest;
    next();
  } catch (error) {
    res.sendStatus(401);
  }
};
