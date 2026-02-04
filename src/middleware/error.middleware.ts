import { Request, Response, NextFunction } from "express";
import logger from "../config/logger";

const errorHandler = (
  err: { statusCode: number; message: any },
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  let error = err;

  const statusCode = error.statusCode || 500;
  const message = error.message || "Internal Server Error";

  logger.error({
    message,
    statusCode,
    path: req.originalUrl,
  });

  res.status(statusCode).json({
    success: false,
    statusCode,
    message,
  });
};

export default errorHandler;
