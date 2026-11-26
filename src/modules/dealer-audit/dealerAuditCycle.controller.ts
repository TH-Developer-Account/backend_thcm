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

// GET /dealer-audit/audits (internal users)
export const listAudits = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const result = await cycleService.listAudits(req.query);
		res.status(200).json({ success: true, ...result });
	} catch (error) {
		next(error);
	}
};

// GET /dealer-audit/mine, and GET /dealer-audit/audits for dealer logins
export const listMyAudits = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const userId = req.user?.id;
		if (!userId) throw new ApiError(401, "Unauthorized");
		const result = await cycleService.listMyAudits(userId, req.query);
		res.status(200).json({ success: true, ...result });
	} catch (error) {
		next(error);
	}
};

// GET /dealer-audit/tracker/summary
export const getTrackerSummary = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const data = await cycleService.getTrackerSummary(req.query);
		res.status(200).json({ success: true, data });
	} catch (error) {
		next(error);
	}
};

// GET /dealer-audit/audits/:id
export const getAudit = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const userId = req.user?.id;
		if (!userId) throw new ApiError(401, "Unauthorized");
		const data = await cycleService.getAudit(userId, String(req.params.id));
		res.status(200).json({ success: true, data });
	} catch (error) {
		next(error);
	}
};

// GET /dealer-audit/audits/:id/checklist
export const getAuditChecklist = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const userId = req.user?.id;
		if (!userId) throw new ApiError(401, "Unauthorized");
		const data = await cycleService.getAuditChecklist(
			userId,
			String(req.params.id),
		);
		res.status(200).json({ success: true, data });
	} catch (error) {
		next(error);
	}
};
