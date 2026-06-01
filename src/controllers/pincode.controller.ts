import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/pincodes/search?q=560034&limit=10
//
// Full-text search across pincode, officeName, district, stateName.
// Intended for the async-select dropdown on the EPC form.
//
// Response shape (each item is ready to display in the dropdown AND
// contains everything needed to build the location + locationMeta on save):
//
// {
//   "success": true,
//   "data": [
//     {
//       "id": "uuid",
//       "label": "Koramangala SO, Bengaluru Urban, Karnataka - 560034",
//       "pincode": "560034",
//       "officeName": "Koramangala SO",
//       "district": "Bengaluru Urban",
//       "stateName": "Karnataka",
//       "latitude": 12.9352,
//       "longitude": 77.6245
//     }
//   ]
// }
//
// The frontend stores the full item on selection, then on form submit sends:
//   location:     item.label
//   locationMeta: { pincode, officeName, district, stateName, latitude, longitude }
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RESULTS = 20;
const MIN_QUERY_LENGTH = 2;

// Builds the human-readable label — single source of truth.
// Both the search response and the EPC save use this same function.
export const buildLocationLabel = (row: {
  officeName: string;
  district: string;
  stateName: string;
  pincode: string;
}): string =>
  `${row.officeName}, ${row.district}, ${row.stateName} - ${row.pincode}`;

export const searchPincodes = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const query = String(req.query.q ?? "").trim();
    const limit = Math.min(Number(req.query.limit ?? 10), MAX_RESULTS);

    if (query.length < MIN_QUERY_LENGTH) {
      return res.status(200).json({ success: true, data: [] });
    }

    // ── Strategy: try full-text search first, fall back to ILIKE ─────────────
    //
    // Full-text search handles multi-word queries well ("Bengaluru Urban")
    // but struggles with pure numeric prefix searches ("5600").
    // ILIKE on the pincode column handles the numeric case perfectly.
    //
    // We run both and UNION them, deduplicating by id.
    // ts_rank drives ordering for text matches; pincode prefix matches
    // are appended after.

    const isNumeric = /^\d+$/.test(query);

    let results: any[];

    if (isNumeric) {
      // Pure numeric input — user is typing a pincode.
      // Skip tsvector, do a fast prefix match on the indexed pincode column.
      results = await prisma.$queryRaw`
        SELECT
          id,
          pincode,
          "officeName",
          district,
          "stateName",
          latitude,
          longitude
        FROM "Pincode"
        WHERE pincode LIKE ${query + "%"}
        ORDER BY pincode
        LIMIT ${limit}
      `;
    } else {
      // Text input — full-text search with ts_rank ordering.
      // websearch_to_tsquery is more forgiving than plainto_tsquery —
      // it handles partial words and ignores punctuation.
      results = await prisma.$queryRaw`
        SELECT
          id,
          pincode,
          "officeName",
          district,
          "stateName",
          latitude,
          longitude,
          ts_rank("searchVector", websearch_to_tsquery('english', ${query})) AS rank
        FROM "Pincode"
        WHERE "searchVector" @@ websearch_to_tsquery('english', ${query})
        ORDER BY rank DESC
        LIMIT ${limit}
      `;
    }

    const data = results.map((row: any) => ({
      id: row.id,
      label: buildLocationLabel(row),
      pincode: row.pincode,
      officeName: row.officeName,
      district: row.district,
      stateName: row.stateName,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
