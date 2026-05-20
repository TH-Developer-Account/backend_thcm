import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

// ─────────────────────────────────────────────────────────────────────────────
// POST /leads
//
// Bulk-creates leads for a given EPC.
//
// Expected payload:
// {
//   "epcId": "uuid",
//   "leads": [
//     {
//       "name": "Rajesh Kumar",
//       "email": "rajesh@example.com",
//       "phone": "9876543210",
//     },
//     {
//       "name": "Priya Singh",
//       "phone": "9123456780",
//       "source": "REFERRAL"
//     }
//   ]
// }
//
// Rules:
//   - The EPC must exist.
//   - At least one lead must be supplied.
//   - Each lead must have at minimum a `name`.
//   - Either `email` or `phone` is strongly recommended but not enforced at
//     the DB layer — validation is done here so the error message is clear.
//   - All inserts are done in a single transaction; if any record fails the
//     whole batch is rolled back.
// ─────────────────────────────────────────────────────────────────────────────

export const createLeads = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { epcId, leads } = req.body as {
      epcId: string;
      leads: {
        name: string;
        email?: string;
        phone?: string;
        notes?: string;
      }[];
    };

    if (!epcId) throw new ApiError(400, "epcId is required");
    if (!Array.isArray(leads) || leads.length === 0) {
      throw new ApiError(400, "leads must be a non-empty array");
    }

    // ── Validate each lead entry before touching the DB ───────────────────
    leads.forEach((lead, index) => {
      if (!lead.name || String(lead.name).trim().length < 2) {
        throw new ApiError(
          400,
          `leads[${index}]: name is required and must be at least 2 characters`,
        );
      }
      if (!lead.email && !lead.phone) {
        throw new ApiError(
          400,
          `leads[${index}]: at least one of email or phone is required`,
        );
      }
      if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
        throw new ApiError(400, `leads[${index}]: invalid email format`);
      }
      if (lead.phone && !/^\+?[0-9]{7,15}$/.test(lead.phone)) {
        throw new ApiError(400, `leads[${index}]: invalid phone format`);
      }
    });

    // ── Ensure the EPC exists ─────────────────────────────────────────────
    const epc = await prisma.eventProposal.findUnique({
      where: { id: epcId },
      select: { id: true, status: true },
    });
    if (!epc) throw new ApiError(404, "Event Proposal not found");

    // ── Bulk insert inside a transaction ──────────────────────────────────
    const created = await prisma.$transaction(async (tx) => {
      const records = await tx.lead.createMany({
        data: leads.map((lead) => ({
          epcId,
          name: String(lead.name).trim(),
          email: lead.email?.trim() ?? null,
          phone: lead.phone?.trim() ?? null,
          notes: lead.notes?.trim() ?? null,
        })),
      });

      return records;
    });

    res.status(201).json({
      success: true,
      message: `${created.count} lead(s) captured successfully`,
      data: { count: created.count },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /leads/epc/:epcId
//
// Returns all leads captured for an EPC with optional filtering by status
// or source. Supports pagination.
//
// Query params:
//   page       (default 1)
//   pageSize   (default 20)
//   status     LeadStatus enum value
//   source     LeadSource enum value
//   search     partial match on name / email / phone / company
// ─────────────────────────────────────────────────────────────────────────────

export const getLeads = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { page = "1", pageSize = "20", status, source, search } = req.query;

    const skip = (Number(page) - 1) * Number(pageSize);
    const take = Number(pageSize);

    // ── Build where clause ────────────────────────────────────────────────
    const where: Record<string, any> = {};

    // ── Add this near the top of the file, after imports ──────────────────────
    const epcSummarySelect = {
      select: {
        id: true,
        proposal_number: true,
        location: true,
        event_name: { select: { id: true, title: true } },
      },
    } as const;

    if (search) {
      const term = String(search).trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        { phone: { contains: term, mode: "insensitive" } },
        { company: { contains: term, mode: "insensitive" } },
      ];
    }

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: "desc" },
        include: { epc: epcSummarySelect },
      }),
      prisma.lead.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: leads,
      pagination: {
        total,
        page: Number(page),
        pageSize: take,
        totalPages: Math.ceil(total / take),
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /leads/:leadId
//
// Returns a single lead by its ID.
// ─────────────────────────────────────────────────────────────────────────────

export const getLeadById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { leadId } = req.params;
    if (!leadId) throw new ApiError(400, "leadId is required");

    const lead = await prisma.lead.findUnique({
      where: { id: leadId as string },
      include: {
        epc: {
          select: {
            id: true,
            event_from_date: true,
            event_to_date: true,
          },
        },
      },
    });

    if (!lead) throw new ApiError(404, "Lead not found");

    res.status(200).json({ success: true, data: lead });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /leads/:leadId
//
// Updates a single lead's fields or status.
//
// Expected payload (all fields optional):
// {
//   "name": "Updated Name",
//   "status": "CONTACTED",
//   "notes": "Called and discussed requirements"
// }
// ─────────────────────────────────────────────────────────────────────────────

export const updateLead = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { leadId } = req.params;
    if (!leadId) throw new ApiError(400, "leadId is required");

    const { name, email, phone, company, designation, source, status, notes } =
      req.body;

    // ── Validate only supplied fields ─────────────────────────────────────
    if (name !== undefined && String(name).trim().length < 2) {
      throw new ApiError(400, "name must be at least 2 characters");
    }
    if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError(400, "Invalid email format");
    }
    if (phone !== undefined && !/^\+?[0-9]{7,15}$/.test(phone)) {
      throw new ApiError(400, "Invalid phone format");
    }

    // ── Build update payload (only what was sent) ─────────────────────────
    const data: Record<string, any> = {};
    if (name !== undefined) data.name = String(name).trim();
    if (email !== undefined) data.email = email?.trim() ?? null;
    if (phone !== undefined) data.phone = phone?.trim() ?? null;
    if (notes !== undefined) data.notes = notes?.trim() ?? null;

    if (Object.keys(data).length === 0) {
      throw new ApiError(400, "No fields provided to update");
    }

    const updated = await prisma.lead.update({
      where: { id: leadId as string },
      data,
    });

    res.status(200).json({
      success: true,
      message: "Lead updated successfully",
      data: updated,
    });
  } catch (error: any) {
    if (error.code === "P2025") {
      return next(new ApiError(404, "Lead not found"));
    }
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /leads/:leadId
//
// Hard-deletes a single lead. A lead can be deleted at any status.
// ─────────────────────────────────────────────────────────────────────────────

export const deleteLead = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { leadId } = req.params;
    if (!leadId) throw new ApiError(400, "leadId is required");

    await prisma.lead.delete({ where: { id: leadId as string } });

    res.status(200).json({
      success: true,
      message: "Lead deleted successfully",
    });
  } catch (error: any) {
    if (error.code === "P2025") {
      return next(new ApiError(404, "Lead not found"));
    }
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /external/leads?phone=9876543210
//
// Called by an external service. Looks up all leads matching the given phone
// number and returns each one with its full EPC context.
//
// If multiple leads share the same phone number (same person attended multiple
// events) they are all returned as an array.
//
// Response shape:
// {
//   "success": true,
//   "phone": "9876543210",
//   "totalMatches": 2,
//   "data": [
//     {
//       "lead": { id, name, email, phone, company, designation, source, status, notes, ... },
//       "epc":  { id, proposal_number, event_name, event_from_date, event_to_date,
//                 location, event_description, event_objective, status, department,
//                 region, branch, vertical }
//     },
//     ...
//   ]
// }
//
// Returns 404 if no leads are found for the given phone number.
// Returns 400 if the phone query param is missing or blank.
// ─────────────────────────────────────────────────────────────────────────────

export const getLeadsByPhone = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const phone = String(req.query.phone ?? "").trim();

    if (!phone) {
      throw new ApiError(400, "phone query parameter is required");
    }

    const leads = await prisma.lead.findMany({
      where: { phone },
      orderBy: { created_at: "desc" },
      include: {
        epc: {
          include: {
            event_name: { select: { id: true, title: true } },
          },
        },
      },
    });

    if (leads.length === 0) {
      throw new ApiError(404, `No leads found for phone number: ${phone}`);
    }

    // ── Shape the response — lead and epc side by side ────────────────────
    const data = leads.map(({ epc, ...lead }) => ({
      lead: {
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
      },
      epc: {
        id: epc.id,
        event_name: epc.event_name.title,
        event_description: epc.event_description,
        proposal_number: epc.proposal_number,
      },
    }));

    res.status(200).json({
      success: true,
      phone,
      totalMatches: data.length,
      data,
    });
  } catch (error) {
    next(error);
  }
};
