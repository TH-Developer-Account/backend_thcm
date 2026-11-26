// handouts/handouts.controller.ts
//
// Thin request/response adapter — same convention as crf.controller.ts /
// crf-order.controller.ts: extract the request, call the matching service
// function, shape the response as { success: true, data }. Every
// ownership/status rule lives in the service layer, never here.

import { Request, Response, NextFunction } from "express";

import ApiError from "@shared/utils/apiError";
import type { AccessActor } from "@rbac/profile/access.types";
import {
  createHandout,
  listHandouts,
  getHandoutDetail,
  resubmitHandout,
  getHandoutApprovalWorkflow,
  type CreateHandoutInput,
  type ListHandoutsInput,
} from "./handouts.services";
import {
  approveHandout,
  rejectHandout,
  clarifyHandout,
  cancelHandout,
  cannotFulfilHandout,
  deliverHandout,
  type DeliverHandoutInput,
} from "./handoutsDecision.services";

type Actor = AccessActor & { id: string };

const requireActor = (req: Request): Actor => {
  const actor = req.user as Actor | undefined;
  if (!actor?.id) throw new ApiError(401, "Unauthorized");
  return actor;
};

// POST /handouts
export const postHandout = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const result = await createHandout(actor, req.body as CreateHandoutInput);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// GET /handouts?view=mine|approve|deliver&status=&search=&page=&pageSize=
export const getHandouts = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { view, status, search, page, pageSize } = req.query as Record<
      string,
      string
    >;

    const params: ListHandoutsInput = {
      view: (view as ListHandoutsInput["view"]) ?? "mine",
      status: status || undefined,
      search: search || undefined,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    };

    const result = await listHandouts(actor, params);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// GET /handouts/approval-workflow
//
// Resolves the two fixed roles (approver, delivery person) to real users,
// for the New Handout review step's Approval Workflow display. No
// actor-specific scoping beyond the route's own HANDOUT read grant: anyone
// who can open Handouts at all can see who the approver and delivery
// person are, the same as every other read-only Handouts screen.
export const getHandoutApprovalWorkflowMeta = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await getHandoutApprovalWorkflow();
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// GET /handouts/:id
export const getHandoutById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { id } = req.params;
    if (!id) throw new ApiError(400, "id is required");

    const result = await getHandoutDetail(actor, id as string);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// POST /handouts/:id/resubmit — CLARIFICATION_REQUESTED -> PENDING_APPROVAL.
// Same body shape as POST /handouts.
export const postHandoutResubmit = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { id } = req.params;
    if (!id) throw new ApiError(400, "id is required");

    const result = await resubmitHandout(
      actor,
      id as string,
      req.body as CreateHandoutInput,
    );
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// POST /handouts/:id/approve
export const postHandoutApprove = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { id } = req.params;
    if (!id) throw new ApiError(400, "id is required");

    const result = await approveHandout(actor, id as string);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// POST /handouts/:id/reject
// Body: { reason: string }
export const postHandoutReject = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { id } = req.params;
    const { reason } = req.body as { reason?: string };
    if (!id) throw new ApiError(400, "id is required");

    const result = await rejectHandout(actor, id as string, reason as string);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// POST /handouts/:id/clarify
// Body: { reason: string }
export const postHandoutClarify = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { id } = req.params;
    const { reason } = req.body as { reason?: string };
    if (!id) throw new ApiError(400, "id is required");

    const result = await clarifyHandout(actor, id as string, reason as string);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// POST /handouts/:id/cancel
// Body: { reason: string }
export const postHandoutCancel = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { id } = req.params;
    const { reason } = req.body as { reason?: string };
    if (!id) throw new ApiError(400, "id is required");

    const result = await cancelHandout(actor, id as string, reason as string);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// POST /handouts/:id/cannot-fulfil — manual, delivery team, APPROVED only.
// Body: { reason: string }
export const postHandoutCannotFulfil = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { id } = req.params;
    const { reason } = req.body as { reason?: string };
    if (!id) throw new ApiError(400, "id is required");

    const result = await cannotFulfilHandout(
      actor,
      id as string,
      reason as string,
    );
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// POST /handouts/:id/deliver
// Body: { handedToName, deliveredOn, note?, checkedSkus }
export const postHandoutDeliver = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const actor = requireActor(req);
    const { id } = req.params;
    if (!id) throw new ApiError(400, "id is required");

    const result = await deliverHandout(
      actor,
      id as string,
      req.body as DeliverHandoutInput,
    );
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
