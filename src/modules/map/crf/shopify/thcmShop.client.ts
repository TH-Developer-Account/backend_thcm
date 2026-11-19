/**
 * modules/map/shopify/thcmShop.client.ts
 *
 * Pure HTTP adapter for the THCM MAP Integration API (the Shopify proxy).
 * This file only knows how to translate THCM's wire shapes to/from typed JS —
 * it has no CRF/Prisma knowledge and no business rules (no "is this a
 * shortfall", no debit-note math). crf.service.ts / crfOrder.service.ts own
 * that; they call this client and interpret the results.
 *
 * One axios instance, reused for every call (same reasoning as the SES
 * transporter / S3 client singletons elsewhere in shared/ — connection
 * reuse, one place for base URL + auth header).
 *
 * Required env vars:
 *   THCM_SHOP_BASE_URL — e.g. https://<host>/  (no trailing path)
 *   THCM_SHOP_API_KEY  — sent as the x-api-key header on every request
 */

import axios, { AxiosInstance, AxiosRequestConfig } from "axios";

import {
  ThcmCreateOrderRequest,
  ThcmCursorPageInfo,
  ThcmGetEmployeeOrdersOptions,
  ThcmGetEmployeeOrdersResult,
  ThcmGetStockOptions,
  ThcmListStockOptions,
  ThcmListStockResult,
  ThcmOrder,
  ThcmOrderStatus,
  ThcmProduct,
  ThcmShopApiError,
  ThcmStockRow,
} from "./thcmShop";

const BASE_URL = process.env.THCM_SHOP_BASE_URL;
const API_KEY = process.env.THCM_SHOP_API_KEY;

if (!BASE_URL) {
  throw new Error("THCM_SHOP_BASE_URL is not set");
}
if (!API_KEY) {
  throw new Error("THCM_SHOP_API_KEY is not set");
}

const REQUEST_TIMEOUT_MS = 15_000;

// The success envelope THCM wraps every 200/201 response in. `pageInfo` is
// only present on the two list endpoints (Get Stock, Get Employee Orders).
type ThcmSuccessEnvelope<T> = {
  success: true;
  data: T;
  pageInfo?: ThcmCursorPageInfo;
};

type ThcmErrorEnvelope = {
  success: false;
  message: string;
  code?: string;
  requestId?: string;
  locked?: boolean;
};

class ThcmShopClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { "x-api-key": API_KEY },
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // 3.1 Get Stock — narrowed to "live availability for these exact SKUs",
  // since nothing in MAP browses the catalog. Always fetches in one page:
  // THCM caps a page at 100 rows, and CRF line counts are expected to stay
  // well under that. We fail loudly instead of silently truncating the
  // list if that assumption is ever wrong — a truncated call would return
  // stock for only some of the requested SKUs with no signal that others
  // were dropped, which is worse than an explicit error here.
  // ───────────────────────────────────────────────────────────────────────
  async getStock(
    skus: string[],
    opts: ThcmGetStockOptions = {},
  ): Promise<ThcmStockRow[]> {
    if (skus.length === 0) return [];
    if (skus.length > 100) {
      throw new Error(
        `thcmShopClient.getStock: ${skus.length} SKUs requested, but THCM Get Stock returns at most 100 rows per call — caller must batch`,
      );
    }

    const envelope = await this.send<ThcmStockRow[]>({
      method: "GET",
      url: "/api/map/stock",
      params: {
        sku: skus.join(","),
        limit: skus.length,
        fresh: opts.fresh,
      },
    });
    return envelope.data;
  }

  // ───────────────────────────────────────────────────────────────────────
  // 3.1 Get Stock — catalog-browse variant of the same endpoint as
  // getStock() above: search/filter + cursor pagination, for the souvenir
  // catalog listing UI. This is never the source of truth for "can we
  // actually ship this" — evaluateSouvenirStock() in crfOrder.service.ts
  // always re-checks with getStock(skus, {fresh:true}) at swap/order time,
  // so a stale row here can't let an order go through.
  //
  // `after`/`before` are passed straight through, exactly as THCM returned
  // them — per the doc, cursors are opaque positions, never built or
  // edited by the caller. There is deliberately no offset-style "page N"
  // param here because THCM's Get Stock doesn't have one.
  // ───────────────────────────────────────────────────────────────────────
  async listStock(
    opts: ThcmListStockOptions = {},
  ): Promise<ThcmListStockResult> {
    const limit = opts.limit ?? 20;
    if (limit > 100) {
      throw new Error(
        `thcmShopClient.listStock: limit ${limit} exceeds THCM Get Stock's 100-row page cap`,
      );
    }
    if (opts.after && opts.before) {
      throw new Error(
        "thcmShopClient.listStock: after and before cannot both be given",
      );
    }

    const envelope = await this.send<ThcmStockRow[]>({
      method: "GET",
      url: "/api/map/stock",
      params: {
        limit,
        after: opts.after,
        before: opts.before,
        q: opts.q,
        sku: opts.sku,
        category: opts.category,
        vendor: opts.vendor,
        tag: opts.tag,
        color: opts.color,
        size: opts.size,
        minPrice: opts.minPrice,
        maxPrice: opts.maxPrice,
        inStock: opts.inStock,
        sort: opts.sort,
        order: opts.order,
        fresh: opts.fresh,
      },
    });

    // pageInfo carries the cursors the frontend needs for next/previous —
    // if THCM ever omits it on this call, that's a contract break worth
    // surfacing loudly rather than silently showing an un-paginated list.
    if (!envelope.pageInfo) {
      throw new ThcmShopApiError(
        502,
        "THCM Shopify API: Get Stock response was missing pageInfo for a paged (sku-less) call",
      );
    }

    return { rows: envelope.data, pageInfo: envelope.pageInfo };
  }

  // ───────────────────────────────────────────────────────────────────────
  // 3.2 Get Product — by product id, variant id, SKU or handle.
  // ───────────────────────────────────────────────────────────────────────
  async getProduct(key: string): Promise<ThcmProduct> {
    const envelope = await this.send<ThcmProduct>({
      method: "GET",
      url: `/api/map/product/${encodeURIComponent(key)}`,
    });
    return envelope.data;
  }

  // ───────────────────────────────────────────────────────────────────────
  // 3.3 Create Order — all-or-nothing; a 409 means nothing was created.
  // ───────────────────────────────────────────────────────────────────────
  async createOrder(payload: ThcmCreateOrderRequest): Promise<ThcmOrder> {
    const envelope = await this.send<ThcmOrder>({
      method: "POST",
      url: "/api/map/create-order",
      data: payload,
    });
    return envelope.data;
  }

  // ───────────────────────────────────────────────────────────────────────
  // 3.4 Get Order Status — looked up by Shopify order id only.
  // ───────────────────────────────────────────────────────────────────────
  async getOrderStatus(shopifyOrderId: string): Promise<ThcmOrderStatus> {
    const envelope = await this.send<ThcmOrderStatus>({
      method: "GET",
      url: `/api/map/order-status/${encodeURIComponent(shopifyOrderId)}`,
    });
    return envelope.data;
  }

  // ───────────────────────────────────────────────────────────────────────
  // 3.5 Get Employee Orders — cursor-paginated; caller passes cursors
  // through unchanged (never constructed or edited here, per the doc).
  // ───────────────────────────────────────────────────────────────────────
  async getEmployeeOrders(
    email: string,
    opts: ThcmGetEmployeeOrdersOptions = {},
  ): Promise<ThcmGetEmployeeOrdersResult> {
    const envelope = await this.send<ThcmGetEmployeeOrdersResult["orders"]>({
      method: "GET",
      url: "/api/dashboard/orders",
      params: {
        email,
        status: opts.status,
        fromDate: opts.fromDate,
        toDate: opts.toDate,
        limit: opts.limit,
        after: opts.after,
        before: opts.before,
      },
    });

    // pageInfo is always present on this endpoint's success response —
    // absence would mean THCM changed the contract, which is a bug to
    // surface, not silently paper over with an empty pageInfo.
    if (!envelope.pageInfo) {
      throw new ThcmShopApiError(
        502,
        "THCM Shopify API: Get Employee Orders response was missing pageInfo",
      );
    }

    return { orders: envelope.data, pageInfo: envelope.pageInfo };
  }

  // ───────────────────────────────────────────────────────────────────────
  // 3.6 Cancel Order — hands stock back exactly once; a repeated cancel
  // is a 409, not idempotent.
  // ───────────────────────────────────────────────────────────────────────
  async cancelOrder(shopifyOrderId: string): Promise<ThcmOrder> {
    const envelope = await this.send<ThcmOrder>({
      method: "POST",
      url: `/api/map/orders/${encodeURIComponent(shopifyOrderId)}/cancel`,
    });
    return envelope.data;
  }

  // ───────────────────────────────────────────────────────────────────────
  // send — the one place that calls axios and translates a non-2xx
  // response into a ThcmShopApiError. Every public method above goes
  // through this so error handling (and the request timeout) lives in
  // exactly one place. (DRY)
  // ───────────────────────────────────────────────────────────────────────
  private async send<T>(
    config: AxiosRequestConfig,
  ): Promise<ThcmSuccessEnvelope<T>> {
    try {
      const response = await this.http.request<ThcmSuccessEnvelope<T>>(config);
      return response.data;
    } catch (error) {
      throw this.toApiError(error);
    }
  }

  private toApiError(error: unknown): ThcmShopApiError {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        const body = error.response.data as Partial<ThcmErrorEnvelope>;
        return new ThcmShopApiError(
          error.response.status,
          body.message ?? "THCM Shopify API request failed",
          {
            code: body.code,
            requestId: body.requestId,
            locked: body.locked,
          },
        );
      }
      // No response at all — network error, DNS failure, or our own
      // REQUEST_TIMEOUT_MS firing. Status 0 signals "never got an HTTP
      // response", distinct from any real status THCM could return.
      return new ThcmShopApiError(0, error.message);
    }
    return new ThcmShopApiError(
      0,
      error instanceof Error ? error.message : "Unknown THCM Shopify API error",
    );
  }
}

export const thcmShopClient = new ThcmShopClient();
