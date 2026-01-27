import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";

export const getUsers = async (req: Request, res: Response) => {
  const users = await prisma.users.findMany();
  res.status(200).json(users);
};
