// src/controllers/eventProposal.controller.ts
import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";
import { searchEventProposals } from "../helpers/searchEventProposal.helper";
import { createEventProposalWithWorkflow } from "../services/workflow.service";

export const createEPCController = async (req: Request, res: Response) => {
  try {
    const result = await createEventProposalWithWorkflow(req.body);

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

export const createEventProposal = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const {
      proposal_number,
      event_name,
      event_from_date,
      event_to_date,
      event_description,
      location,
      event_objective,
      department,
      vertical,
      region,
      branch,
      event_scale,
      budget_master_id,
    } = req.body;

    const userId = req?.user?.id;

    if (!userId) throw new ApiError(401, "Unauthorized");

    if (
      !proposal_number ||
      !event_name ||
      !event_from_date ||
      !event_to_date ||
      !department ||
      !region ||
      !branch ||
      !event_scale ||
      !budget_master_id
    ) {
      throw new ApiError(400, "Missing required fields");
    }

    if (new Date(event_from_date) > new Date(event_to_date)) {
      throw new ApiError(400, "event_from_date cannot be after event_to_date");
    }

    // Check if the user has the permission to create EPC

    const proposal = await prisma.eventProposal.create({
      data: {
        proposal_number,
        event_name_id: event_name,
        event_from_date: new Date(event_from_date),
        event_to_date: new Date(event_to_date),
        event_description,
        location,
        event_objective,
        department_id: department,
        vertical_id: vertical,
        region_id: region,
        branch_id: branch,
        event_scale: Number(event_scale),
        budget_master_id,
        created_by_id: userId,
        updated_by_id: userId,
      },
    });

    res.status(201).json(proposal);
  } catch (error: any) {
    if (error.code === "P2002") {
      throw new ApiError(409, "Proposal number already exists");
    }
    next(error);
  }
};

export const getAllEventProposals = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const {
      page = "1",
      pageSize = "10",
      search,
      sortBy = "created_at",
      sortOrder = "desc",
      status,
      departmentId,
      startDate,
      endDate,
    } = req.query;

    const pageNumber = Number(page);
    const take = Number(pageSize);

    const { data, total } = await searchEventProposals({
      search: search as string,
      status: status as string,
      departmentId: departmentId ? Number(departmentId) : undefined,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      page: pageNumber,
      pageSize: take,
      sortBy: sortBy as any,
      sortOrder: sortOrder === "asc" ? "asc" : "desc",
    });

    res.status(200).json({
      data,
      pagination: {
        total,
        page: pageNumber,
        pageSize: take,
        totalPages: Math.ceil(total / take),
      },
    });
  } catch (error) {
    console.log("error===========>", JSON.stringify(error, null, 2));
    next(error);
  }
};

export const getEventProposalById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = String(req.params.id);
    if (!id) {
      throw new ApiError(404, "Invalid ID");
    }

    const proposal = await prisma.eventProposal.findUnique({
      where: { id },
      include: {
        epf: true,
        crf: true,
        workflow: {
          include: {
            stages: true,
          },
        },
        event_name: true,
        department: true,
        created_by: true,
      },
    });

    if (!proposal) {
      throw new ApiError(404, "Event Proposal not found");
    }

    res.status(200).json(proposal);
  } catch (error: any) {
    next(error);
  }
};

export const updateEventProposal = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = String(req.params.id);
    const { ...data } = req.body;
    const userId = req?.user?.id;

    if (!userId) throw new ApiError(401, "Unauthorized");

    if (id) {
      throw new ApiError(404, "Invalid ID");
    }

    const updated = await prisma.eventProposal.update({
      where: { id },
      data: {
        ...data,
        updated_by: userId,
      },
    });

    res.status(200).json(updated);
  } catch (error: any) {
    if (error.code === "P2025") {
      throw new ApiError(404, "Event Proposal not found");
    }
    next(error);
  }
};

export const deleteEventProposal = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = String(req.params.id);

    const userId = req?.user?.id;

    if (!userId) throw new ApiError(401, "Unauthorized");

    if (id) {
      throw new ApiError(400, "Invalid ID");
    }

    const updated = await prisma.eventProposal.update({
      where: { id },
      data: {
        status: "DELETED",
        updated_by_id: userId,
      },
    });

    res
      .status(200)
      .json({ message: "Event Proposal deleted successfully", data: updated });
  } catch (error: any) {
    next(error);
  }
};
