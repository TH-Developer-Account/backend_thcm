import { Prisma } from "../prisma/generated/prisma/client";
import { prisma } from "../config/prisma";

interface SearchEventProposalInput {
  search?: string;
  status?: string;
  departmentId?: number;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  pageSize?: number;
  sortBy?: "created_at" | "proposal_number" | "status";
  sortOrder?: "asc" | "desc";
}

export async function searchEventProposals(filters: SearchEventProposalInput) {
  const {
    search,
    status,
    departmentId,
    startDate,
    endDate,
    page = 1,
    pageSize = 10,
    sortBy = "created_at",
    sortOrder = "desc",
  } = filters;

  const skip = (page - 1) * pageSize;

  const conditions: Prisma.Sql[] = [];

  // 🔎 Full-text search
  if (search) {
    conditions.push(
      Prisma.sql`search_vector @@ plainto_tsquery('english', ${search})`,
    );
  }

  // 📌 Filters
  if (status) {
    conditions.push(Prisma.sql`status = ${status}`);
  }

  if (departmentId) {
    conditions.push(Prisma.sql`department_id = ${departmentId}`);
  }

  if (startDate) {
    conditions.push(Prisma.sql`created_at >= ${startDate}`);
  }

  if (endDate) {
    conditions.push(Prisma.sql`created_at <= ${endDate}`);
  }

  const whereClause =
    conditions.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(conditions, "AND")}`
      : Prisma.empty;

  const direction = sortOrder === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;

  let orderByClause: Prisma.Sql;

  if (search) {
    orderByClause = Prisma.sql`
    ORDER BY
      ts_rank(search_vector, plainto_tsquery('english', ${search})) DESC,
      ${Prisma.raw(`"${sortBy}"`)} ${direction}
  `;
  } else {
    orderByClause = Prisma.sql`
    ORDER BY
      ${Prisma.raw(`"${sortBy}"`)} ${direction}
  `;
  }

  const ranking = search
    ? Prisma.sql`ts_rank(search_vector, plainto_tsquery('english', ${search}))`
    : Prisma.sql`NULL`;

  /* ---------------- DATA QUERY ---------------- */
  const dataPromise = prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT 
    ep.id,
    ep.proposal_number,
    ep.event_from_date,
    ep.event_to_date,
    ep.event_description,
    ep.location,
    ep.event_objective,
    ep.status,
    ep.created_by_id,
    ep.created_at,
    ep.department_id,
    ep.event_name_id,
    en.description AS event_name,
    us.first_name AS first_name,
    us.last_name AS last_name,
      ${ranking} AS rank
    FROM "EventProposal" ep
     LEFT JOIN "EventName" en 
        ON ep.event_name_id = en.id
     LEFT JOIN "Department" d  
        ON ep.department_id = d.id
     LEFT JOIN "User" us  
        ON ep.created_by_id = us.id
    ${whereClause}
    ${orderByClause}
    LIMIT ${pageSize}
    OFFSET ${skip}
  `);

  /* ---------------- COUNT QUERY ---------------- */
  const countPromise = prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
    SELECT COUNT(*)::int as total
    FROM "EventProposal"
    ${whereClause}
  `);

  const [data, countResult] = await Promise.all([dataPromise, countPromise]);

  return {
    data,
    total: countResult[0]?.total || 0,
  };
}
