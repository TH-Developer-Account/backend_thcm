import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

// Extend Request interface
declare module "express-serve-static-core" {
  interface Request {
    user?: {
      id: string;
    };
  }
}

export const getUsers = async (req: Request, res: Response) => {
  const users = await prisma.users.findMany();
  res.status(200).json(users);
};

export const getCurrentUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      throw new ApiError(401, "Unauthorized");
    }

    // Fetch user from database
    const user = await prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        phone_number: true,
        is_active: true,
        created_at: true,
        updated_at: true,
        // Don't return password!
      },
    });

    if (!user) {
      throw new ApiError(404, "User not found");
    }

    if (!user.is_active) {
      throw new ApiError(403, "Account is inactive");
    }

    res.status(200).json({ user });
  } catch (error) {
    next(error);
  }
};
