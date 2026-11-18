import { Request, Response, NextFunction } from "express";
import ApiError from "@shared/utils/apiError";
import * as cycleService from "./dealerAuditCycle.service";

// POST /dealer-audit/cycles
export const launchDealerAuditCycle = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const userId = req.user?.id;
		if (!userId) throw new ApiError(401, "Unauthorized");
		const result = await cycleService.launchDealerAuditCycle(userId, req.body);
		res.status(201).json({ success: true, data: result });
	} catch (error) {
		next(error);
	}
};

// GET /dealer-audit/options/reviewers
export const listReviewerOptions = async (
	_req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const reviewers = await cycleService.listReviewerOptions();
		res.status(200).json({ success: true, data: reviewers });
	} catch (error) {
		next(error);
	}
};

// GET /dealer-audit/options/dealers
export const listDealerOptions = async (
	_req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const dealers = await cycleService.listDealerOptions();
		res.status(200).json({ success: true, data: dealers });
	} catch (error) {
		next(error);
	}
};
