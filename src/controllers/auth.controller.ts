import { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

const SALT_ROUNDS = 10;

export const registerUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { first_name, last_name, password, email, phone_number, user_type } =
      req.body;

    if (!email || !password) {
      throw new ApiError(400, "Email and password are required");
    }

    // Check if user exists
    const existingUser = await prisma.users.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ApiError(409, "User already exists");
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Save user
    const user = await prisma.users.create({
      data: {
        first_name,
        last_name,
        phone_number,
        is_active: true,
        email,
        password: hashedPassword,
      },
      select: {
        id: true,
        email: true,
        created_at: true,
      },
    });

    // 4️⃣ Respond
    res.status(201).json({
      message: "User registered successfully",
      user,
    });
  } catch (error) {
    next(error);
  }
};

export const loginUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { password, email, phone_number } = req.body;

    if (!email || !password) {
      throw new ApiError(400, "Email and password are required");
    }

    // Check if user exists
    const existingUser = await prisma.users.findUnique({
      where: { email },
    });

    if (!existingUser) {
      throw new ApiError(409, "User does not exist, Please register");
    }

    // check password
    const isValidPassword = await bcrypt.compare(
      password,
      existingUser.password,
    );

    if (!isValidPassword) {
      throw new ApiError(401, "Invalid credentials");
    }

    // JWT logic for the user

    // Respond
    res.status(201).json({
      message: "User Logged in successfully",
      user: existingUser,
    });
  } catch (error) {
    next(error);
  }
};
