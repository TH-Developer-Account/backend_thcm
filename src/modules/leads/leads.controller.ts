import { Request, Response, NextFunction } from "express";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import {
  ParticipantType,
  ParticipantStatus,
} from "../../prisma/generated/prisma/client";
import { resolveLeadFormConfig } from "./utils/leadFormVariants";

// ─────────────────────────────────────────────────────────────────────────────
const LEAD_SOURCE_PERIOD_MONTHS = 4;

const isWithinAttributionPeriod = (eventToDate: Date): boolean => {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - LEAD_SOURCE_PERIOD_MONTHS);
  return eventToDate >= cutoff;
};

const formatOriginSource = (
  eventToDate: Date,
  eventName: string,
  location: string,
): string => {
  const datePart = eventToDate.toISOString().slice(0, 10);
  return `${datePart}_${eventName}_${location}`;
};

const assertValidEnumValue = <T extends Record<string, string>>(
  enumObject: T,
  value: unknown,
  fieldLabel: string,
  index?: number,
): void => {
  if (value === undefined || value === null) return;
  if (!Object.values(enumObject).includes(value as string)) {
    const prefix = index !== undefined ? `leads[${index}]: ` : "";
    throw new ApiError(
      400,
      `${prefix}invalid ${fieldLabel} "${value}". Must be one of: ${Object.values(enumObject).join(", ")}`,
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /leads/create-leads
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
        companyName?: string;
        dealership?: string;
        location?: string;
        district?: string;
        state?: string;
        eventDate?: string;
        participantType?: ParticipantType;
        participantStatus?: ParticipantStatus;
        machineModel?: string;
        machineSerial?: string;
        valueOfServiceOffers?: number;
        valueOfPartsOffers?: number;
        valueOfPartsBilled?: number;
        notes?: string;
      }[];
    };

    if (!epcId) throw new ApiError(400, "epcId is required");
    if (!Array.isArray(leads) || leads.length === 0) {
      throw new ApiError(400, "leads must be a non-empty array");
    }

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
      if (lead.eventDate && isNaN(Date.parse(lead.eventDate))) {
        throw new ApiError(400, `leads[${index}]: invalid eventDate`);
      }
      assertValidEnumValue(
        ParticipantType,
        lead.participantType,
        "participantType",
        index,
      );
      assertValidEnumValue(
        ParticipantStatus,
        lead.participantStatus,
        "participantStatus",
        index,
      );
    });

    const epc = await prisma.eventProposal.findUnique({
      where: { id: epcId },
      select: { id: true },
    });
    if (!epc) throw new ApiError(404, "Event Proposal not found");

    const created = await prisma.$transaction(async (tx) => {
      return tx.lead.createMany({
        data: leads.map((lead) => ({
          epcId,
          name: String(lead.name).trim(),
          email: lead.email?.trim() ?? null,
          phone: lead.phone?.trim() ?? null,
          companyName: lead.companyName?.trim() ?? null,
          dealership: lead.dealership?.trim() ?? null,
          location: lead.location?.trim() ?? null,
          district: lead.district?.trim() ?? null,
          state: lead.state?.trim() ?? null,
          eventDate: lead.eventDate ? new Date(lead.eventDate) : null,
          participantType: lead.participantType ?? null,
          participantStatus: lead.participantStatus ?? null,
          machineModel: lead.machineModel?.trim() ?? null,
          machineSerial: lead.machineSerial?.trim() ?? null,
          valueOfServiceOffers: lead.valueOfServiceOffers ?? null,
          valueOfPartsOffers: lead.valueOfPartsOffers ?? null,
          valueOfPartsBilled: lead.valueOfPartsBilled ?? null,
          notes: lead.notes?.trim() ?? null,
        })),
      });
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
// GET /leads/get-all-leads — paginated, filterable
// ─────────────────────────────────────────────────────────────────────────────

export const getLeads = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const {
      page = "1",
      pageSize = "20",
      participantStatus,
      participantType,
      search,
    } = req.query;

    const skip = (Number(page) - 1) * Number(pageSize);
    const take = Number(pageSize);

    const where: Record<string, any> = {};

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
        { companyName: { contains: term, mode: "insensitive" } },
      ];
    }

    if (participantStatus) {
      assertValidEnumValue(
        ParticipantStatus,
        participantStatus,
        "participantStatus",
      );
      where.participantStatus = participantStatus;
    }

    if (participantType) {
      assertValidEnumValue(ParticipantType, participantType, "participantType");
      where.participantType = participantType;
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
// GET /leads/epc/:epcId — all leads for one EPC, no pagination
// ─────────────────────────────────────────────────────────────────────────────

export const getLeadsByEpc = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { epcId } = req.params;

    const leads = await prisma.lead.findMany({
      where: { epcId: epcId as string },
      orderBy: { created_at: "desc" },
      include: {
        epc: {
          select: {
            id: true,
            proposal_number: true,
            location: true,
            event_name: { select: { id: true, title: true } },
          },
        },
      },
    });

    res.status(200).json({ success: true, data: leads });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /leads/form-config/:epcId
// ─────────────────────────────────────────────────────────────────────────────

export const getLeadFormConfig = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { epcId } = req.params;
    const epc = await prisma.eventProposal.findUnique({
      where: { id: epcId as string },
      select: { event_name_id: true },
    });
    if (!epc) throw new ApiError(404, "EPC not found");

    const config = await resolveLeadFormConfig(epc.event_name_id);
    res.status(200).json({ success: true, data: config });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /leads/:leadId
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
          select: { id: true, event_from_date: true, event_to_date: true },
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
// PUT /leads/:leadId
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

    const {
      name,
      email,
      phone,
      companyName,
      dealership,
      location,
      district,
      state,
      eventDate,
      participantType,
      participantStatus,
      machineModel,
      machineSerial,
      valueOfServiceOffers,
      valueOfPartsOffers,
      valueOfPartsBilled,
      notes,
    } = req.body;

    if (name !== undefined && String(name).trim().length < 2) {
      throw new ApiError(400, "name must be at least 2 characters");
    }
    if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError(400, "Invalid email format");
    }
    if (phone !== undefined && !/^\+?[0-9]{7,15}$/.test(phone)) {
      throw new ApiError(400, "Invalid phone format");
    }
    if (
      eventDate !== undefined &&
      eventDate !== null &&
      isNaN(Date.parse(eventDate))
    ) {
      throw new ApiError(400, "Invalid eventDate");
    }
    assertValidEnumValue(ParticipantType, participantType, "participantType");
    assertValidEnumValue(
      ParticipantStatus,
      participantStatus,
      "participantStatus",
    );

    const data: Record<string, any> = {};
    if (name !== undefined) data.name = String(name).trim();
    if (email !== undefined) data.email = email?.trim() ?? null;
    if (phone !== undefined) data.phone = phone?.trim() ?? null;
    if (companyName !== undefined)
      data.companyName = companyName?.trim() ?? null;
    if (dealership !== undefined) data.dealership = dealership?.trim() ?? null;
    if (location !== undefined) data.location = location?.trim() ?? null;
    if (district !== undefined) data.district = district?.trim() ?? null;
    if (state !== undefined) data.state = state?.trim() ?? null;
    if (eventDate !== undefined)
      data.eventDate = eventDate ? new Date(eventDate) : null;
    if (participantType !== undefined) data.participantType = participantType;
    if (participantStatus !== undefined)
      data.participantStatus = participantStatus;
    if (machineModel !== undefined)
      data.machineModel = machineModel?.trim() ?? null;
    if (machineSerial !== undefined)
      data.machineSerial = machineSerial?.trim() ?? null;
    if (valueOfServiceOffers !== undefined)
      data.valueOfServiceOffers = valueOfServiceOffers;
    if (valueOfPartsOffers !== undefined)
      data.valueOfPartsOffers = valueOfPartsOffers;
    if (valueOfPartsBilled !== undefined)
      data.valueOfPartsBilled = valueOfPartsBilled;
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

    res
      .status(200)
      .json({ success: true, message: "Lead deleted successfully" });
  } catch (error: any) {
    if (error.code === "P2025") {
      return next(new ApiError(404, "Lead not found"));
    }
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /leads/get-lead-by-phone?phone=...
// ─────────────────────────────────────────────────────────────────────────────

export const getLeadsByPhone = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const phone = String(req.query.phone ?? "").trim();
    if (!phone) throw new ApiError(400, "phone query parameter is required");

    const leads = await prisma.lead.findMany({
      where: { phone },
      include: {
        epc: { include: { event_name: { select: { title: true } } } },
      },
    });

    const attributableLeads = leads.filter((lead) =>
      isWithinAttributionPeriod(lead.epc.event_to_date),
    );

    if (attributableLeads.length === 0) {
      res.status(200).json({ originSource: "DIRECT" });
      return;
    }

    const latestLead = attributableLeads.reduce((newest, current) =>
      current.epc.event_to_date > newest.epc.event_to_date ? current : newest,
    );

    const originSource = formatOriginSource(
      latestLead.epc.event_to_date,
      latestLead.epc.event_name.title,
      latestLead.epc.location,
    );

    res.status(200).json({ originSource });
  } catch (error) {
    next(error);
  }
};
