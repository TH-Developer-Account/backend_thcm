import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import ApiError from "../utils/apiError";

export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new ApiError(401, "No token provided");
    }

    const token = authHeader.split(" ")[1];

    // Verify token
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!) as {
      sub: string;
    };

    // Attach user ID to request
    req.user = { id: decoded.sub };

    next();
  } catch {
    res.sendStatus(401);
  }
};

export const requireRole = (role) => (req, res, next) => {
  if (req.user.role !== role) return res.sendStatus(403);
  next();
};
