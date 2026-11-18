// ─────────────────────────────────────────────────────────────────────────────
// Resolves a lat/long into a 6-digit Indian pincode via point-in-polygon
// matching against real pincode boundaries — not nearest-centroid guessing
// against the Pincode table (confirmed too inaccurate for this use case).
//
// Data source: data.gov.in's India Post pincode boundary polygons, as
// republished at github.com/ramSeraph/indian_admin_boundaries (release tag
// "postal", asset Datagov_Pincode_Boundaries.geojsonl.7z) — AIKosh itself
// (aikosh.indiaai.gov.in) isn't reachable from every network, including
// this one, so this is a mirror of the same government dataset. 19,312
// pincode polygons, every one carrying a Pincode property — genuinely
// nationwide coverage (unlike github.com/datameet/PincodeBoundary, which
// only covers 6 metro cities and isn't enough for a fleet spread across
// construction/mining sites nationwide).
//
// File format: NDJSON ("geojsonl") — one JSON Feature object per line, not
// a single FeatureCollection document. The only property kept is
// "Pincode"; the source file's Office_Name/Division/Region/Circle fields
// aren't needed here, so they were stripped to shrink the file (90MB raw
// -> 74.5MB slim). Plain text, not gzipped — gzip transfer kept getting
// corrupted in practice, so this trades ~53MB of disk space for one less
// failure mode.
//
// SETUP: place pincode-boundaries.slim.geojsonl at <project root>/data/.
// BOUNDARY_FILE_PATH is resolved from process.cwd() (where the process was
// started), not __dirname — deliberately, so this works identically
// whether running the TS source directly (ts-node) or the tsc-compiled
// output (node dist/worker.js). __dirname would point at src/modules/.../
// in the first case but dist/modules/.../ in the second, so a
// __dirname-relative path breaks the moment you build, unless the build
// step also copies this file into dist/ — process.cwd() needs no such step,
// as long as the process is started from the project root (true for both
// `npx ts-node ... worker.ts` and `node dist/worker.js` / pm2 here).
// See README_CHANGES.md for where to get the file.
//
// Why pure Node + Turf.js instead of PostGIS: nothing in schema.prisma
// references PostGIS, and enabling it may need provider/admin support on
// a managed Postgres instance. This is entirely offline and in-memory —
// no API calls, no rate limits, no ongoing cost, unlike an external
// reverse-geocoding service.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import bbox from "@turf/bbox";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import type { BBox, Feature, MultiPolygon, Polygon } from "geojson";

const BOUNDARY_FILE_PATH = path.join(
  process.cwd(),
  "data/pincode-boundaries.slim.geojsonl",
);

type BoundaryFeature = Feature<Polygon | MultiPolygon, { Pincode: string }>;

type IndexedBoundary = {
  pincode: string;
  bbox: BBox; // [minLon, minLat, maxLon, maxLat] — cheap prefilter before the exact test
  feature: BoundaryFeature;
};

// Loaded once per process and reused across every sync run — the dataset
// is large enough (nationwide, polygon-detailed) that re-parsing it on
// every call would be wasteful for no benefit, since boundaries don't
// change between runs.
let boundariesCache: IndexedBoundary[] | null = null;

function loadBoundaries(): IndexedBoundary[] {
  if (boundariesCache) return boundariesCache;

  if (!fs.existsSync(BOUNDARY_FILE_PATH)) {
    throw new Error(
      `Pincode boundary file not found at ${BOUNDARY_FILE_PATH}. See ` +
        `README_CHANGES.md for where to get pincode-boundaries.slim.geojsonl ` +
        `and place it at that path.`,
    );
  }

  const raw = fs.readFileSync(BOUNDARY_FILE_PATH, "utf-8");

  const indexed: IndexedBoundary[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue; // skip trailing blank line

    const feature = JSON.parse(trimmed) as BoundaryFeature;
    const pincode = feature.properties?.Pincode;
    if (!pincode) continue; // can't use a boundary we can't attribute to a pincode

    indexed.push({ pincode: String(pincode), bbox: bbox(feature), feature });
  }

  boundariesCache = indexed;
  return boundariesCache;
}

function isInsideBBox(longitude: number, latitude: number, box: BBox): boolean {
  const [minLon, minLat, maxLon, maxLat] = box;
  return (
    longitude >= minLon &&
    longitude <= maxLon &&
    latitude >= minLat &&
    latitude <= maxLat
  );
}

// ── Public API ────────────────────────────────────────────────────────────────
//
// null when the point falls inside no boundary at all (gaps in the
// government dataset, a border/coastal location, or bad GPS data) — per
// the agreed design, we don't guess a pincode we're not confident about,
// same philosophy as dailyOperationHrs's null handling.
//
// Performance: a cheap bounding-box check first rules out almost every
// polygon before the exact (and more expensive) point-in-polygon test
// runs — this is what keeps a nationwide, detailed boundary dataset fast
// enough for a daily batch job over thousands of machines without needing
// a full spatial index (R-tree) on top of Turf.

export function resolvePincodeFromBoundary(
  latitude: number,
  longitude: number,
): string | null {
  const boundaries = loadBoundaries();
  const candidate = point([longitude, latitude]); // GeoJSON order is [lon, lat]

  for (const boundary of boundaries) {
    if (!isInsideBBox(longitude, latitude, boundary.bbox)) continue;
    if (booleanPointInPolygon(candidate, boundary.feature)) {
      return boundary.pincode;
    }
  }

  return null;
}
