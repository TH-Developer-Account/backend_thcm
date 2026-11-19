import { Request, Response, NextFunction } from "express";

import ApiError from "@shared/utils/apiError";
import { thcmShopClient } from "@modules/map/crf/shopify";
import type {
  ThcmListStockOrder,
  ThcmListStockSort,
  ThcmStockRow,
} from "@modules/map/crf/shopify";

/**
 * modules/map/crf-shop.controller.ts
 *
 * Read-only proxy onto the THCM MAP Shopify integration, for the CRF
 * souvenir tab's "browse the catalog" UI only. Nothing here is
 * authoritative: the real stock check and pricing happen inside
 * crfOrder.service.ts (evaluateSouvenirStock / executeOrderPlacement) at
 * swap/place-order time, against live SKUs the CRF actually holds. These
 * three handlers exist purely so the frontend has something to list,
 * view, and show live availability from while the user is building the
 * souvenir cart — none of it is persisted or re-validated here.
 *
 * Pagination here is cursor-based (after/before), not page-number: THCM's
 * Get Stock has no "jump to page N" — only sequential next/previous via
 * the cursors it hands back. getCrfShopCatalog is a thin pass-through for
 * that reason; it does its own type coercion on query params (everything
 * arrives as a string) but leaves semantic validation (e.g. "sort must be
 * one of: relevance, title, price, stock, newest") to THCM itself rather
 * than duplicating THCM's own validation rules here.
 */

const MAX_PAGE_SIZE = 100; // mirrors THCM Get Stock's own page cap
const DEFAULT_PAGE_SIZE = 20;
const MAX_STOCK_CHECK_SKUS = 100; // mirrors thcmShopClient.getStock's own cap

const SORT_VALUES: ThcmListStockSort[] = [
  "relevance",
  "title",
  "price",
  "stock",
  "newest",
];
const ORDER_VALUES: ThcmListStockOrder[] = ["asc", "desc"];

const parseOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const parseOptionalNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseOptionalBoolean = (value: unknown): boolean | undefined => {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
};

const parseSort = (value: unknown): ThcmListStockSort | undefined =>
  SORT_VALUES.includes(value as ThcmListStockSort)
    ? (value as ThcmListStockSort)
    : undefined;

const parseOrder = (value: unknown): ThcmListStockOrder | undefined =>
  ORDER_VALUES.includes(value as ThcmListStockOrder)
    ? (value as ThcmListStockOrder)
    : undefined;

// GET /crf-shop/catalog
// Query: limit?, after?, before?, q?, category?, vendor?, tag?, color?,
//        size?, minPrice?, maxPrice?, inStock?, sort?, order?, fresh?
//
// `after`/`before` are forwarded exactly as the frontend received them from
// a previous call's pageInfo — never generated or edited here.
export const getCrfShopCatalog = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const after = parseOptionalString(req.query.after);
    const before = parseOptionalString(req.query.before);
    if (after && before) {
      throw new ApiError(400, "after and before cannot both be given");
    }

    const limit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(
        1,
        Number(req.query.limit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE,
      ),
    );

    const { rows, pageInfo } = await thcmShopClient.listStock({
      limit,
      after,
      before,
      q: parseOptionalString(req.query.q),
      category: parseOptionalString(req.query.category),
      vendor: parseOptionalString(req.query.vendor),
      tag: parseOptionalString(req.query.tag),
      color: parseOptionalString(req.query.color),
      size: parseOptionalString(req.query.size),
      minPrice: parseOptionalNumber(req.query.minPrice),
      maxPrice: parseOptionalNumber(req.query.maxPrice),
      inStock: parseOptionalBoolean(req.query.inStock),
      sort: parseSort(req.query.sort),
      order: parseOrder(req.query.order),
      fresh: req.query.fresh === "true",
    });

    // Echoed flat, the same shape THCM's own envelope uses ({ data, pageInfo }
    // as siblings) — the frontend's crf.shop.api.ts reads the proxy response
    // this way directly, without a nested wrapper.
    res.status(200).json({ success: true, data: rows, pageInfo });
  } catch (error) {
    next(error);
  }
};

// GET /crf-shop/catalog/:key — key is productId | variantId | sku | handle,
// THCM resolves which one it is (see ThcmProduct.matchedBy in the response).
export const getCrfShopProduct = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { key } = req.params;
    if (!key) throw new ApiError(400, "Product key is required");

    const product = await thcmShopClient.getProduct(key as string);
    res.status(200).json({ success: true, data: product });
  } catch (error) {
    next(error);
  }
};

type StockCheckItemInput = { sku: string; quantity: number };

type StockCheckStatus =
  | "AVAILABLE"
  | "PARTIAL"
  | "OUT_OF_STOCK"
  | "INACTIVE"
  | "UNKNOWN_SKU";

// Pure — no Prisma, no CRF knowledge. Deliberately NOT shared with
// evaluateSouvenirStock() in crfOrder.service.ts: that one decides whether
// an order can actually be placed against CrfItems already saved to a CRF,
// gating REQUESTED vs OUT_OF_STOCK. This one is display-only, comparing an
// in-progress cart's quantities against live stock before anything is
// saved, with a richer status (PARTIAL/INACTIVE/UNKNOWN_SKU) the save-time
// check doesn't need. Same shape of logic, different question being asked.
const resolveStockCheckStatus = (
  row: ThcmStockRow | undefined,
  requestedQty: number,
): StockCheckStatus => {
  if (!row) return "UNKNOWN_SKU";
  if (row.status !== "active") return "INACTIVE";
  if (row.availableQty <= 0) return "OUT_OF_STOCK";
  if (row.availableQty < requestedQty) return "PARTIAL";
  return "AVAILABLE";
};

// POST /crf-shop/stock-check
// Payload: { "items": [{ "sku": "THCM-0156", "quantity": 2 }] }
//
// Display-only, for showing live availability while the cart is being
// built — never a reservation (`reserved` is always false). Always asks
// THCM for fresh data (no cache) since the whole point is to show current
// stock, not whatever the catalog listing happened to return a few
// requests ago. The authoritative check still happens in
// crfOrder.service.ts at swap/place-order time.
export const checkCrfShopStock = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { items } = req.body as { items?: StockCheckItemInput[] };

    if (!Array.isArray(items) || items.length === 0) {
      throw new ApiError(400, "items must be a non-empty array");
    }
    if (items.length > MAX_STOCK_CHECK_SKUS) {
      throw new ApiError(
        400,
        `At most ${MAX_STOCK_CHECK_SKUS} items per stock check`,
      );
    }
    for (const item of items) {
      if (!item?.sku || !Number.isFinite(item.quantity) || item.quantity <= 0) {
        throw new ApiError(
          400,
          "Each item needs a sku and a positive quantity",
        );
      }
    }

    const rows = await thcmShopClient.getStock(
      items.map((item) => item.sku),
      { fresh: true },
    );
    const rowBySku = new Map(
      rows.filter((row) => row.sku).map((row) => [row.sku as string, row]),
    );

    const lines = items.map((item) => {
      const row = rowBySku.get(item.sku);
      return {
        sku: item.sku,
        requested: item.quantity,
        available: row?.availableQty ?? 0,
        status: resolveStockCheckStatus(row, item.quantity),
        title: row?.title ?? null,
        variantTitle: row?.variantTitle ?? null,
        imageUrl: row?.imageUrl ?? null,
        price: row?.price ?? null,
      };
    });

    res.status(200).json({
      success: true,
      data: {
        allAvailable: lines.every((line) => line.status === "AVAILABLE"),
        reserved: false,
        checkedAt: new Date().toISOString(),
        lines,
      },
    });
  } catch (error) {
    next(error);
  }
};
