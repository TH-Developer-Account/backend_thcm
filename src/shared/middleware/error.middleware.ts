import { Request, Response, NextFunction } from "express";
import logger from "@shared/utils/logger";

const errorHandler = (
	err: {
		statusCode: number;
		message: any;
		// Present on ValidationError only; forwarded so the UI can show
		// field-level messages. Other errors are unchanged.
		errors?: { path: string; message: string }[];
	},
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
		...(error.errors?.length ? { errors: error.errors } : {}),
	});
};

export default errorHandler;
