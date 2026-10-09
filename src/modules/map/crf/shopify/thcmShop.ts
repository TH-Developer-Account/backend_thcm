/**
 * modules/map/shopify/thcmShop.types.ts
 *
 * Request/response shapes for the THCM MAP Integration API (the Shopify
 * proxy), taken from the "THCM Â· MAP Integration API Guide" docx, 6 endpoints.
 *
 * These are wire types only (what THCM's API sends/accepts) — they are NOT
 * Prisma models and are never persisted as-is. CrfItem only ever stores
 * `sku` + `requestedQty`; CrfOrder stores a snapshot of the fields that
 * matter to MAP (see schema.prisma) at the moment an order is confirmed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared envelope / pagination
// ─────────────────────────────────────────────────────────────────────────────

export type ThcmCursorPageInfo = {
  limit: number;
  offset: number;
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextCursor: string | null;
  previousCursor: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// 3.1 Get Stock
// ─────────────────────────────────────────────────────────────────────────────

export type ThcmStockRow = {
  id: string;
  variantId: string;
  sku: string | null;
  title: string;
  variantTitle: string | null;
  options: Record<string, string>;
  price: string;
  compareAtPrice: string | null;
  availableQty: number;
  category: string;
  vendor: string | null;
  tags: string[];
  handle: string;
  imageUrl: string | null;
  status: "active" | "draft" | "archived";
  createdAt: string | null;
};

export type ThcmGetStockOptions = {
  fresh?: boolean;
};

// listStock is the catalog-browse variant of the same Get Stock endpoint —
// cursor-paginated (after/before, same model as Get Employee Orders below)
// plus the full set of search/filter params the endpoint supports. Used
// only for the souvenir catalog listing UI — never for the authoritative
// order-time stock check, which stays on getStock(skus) above.
//
// There is no `offset` request param — THCM's own doc is explicit that
// cursors are opaque positions ("never build or edit them"), so arbitrary
// "jump to page N" isn't something this endpoint can do. Only sequential
// next/previous navigation is possible.
export type ThcmListStockSort =
  | "relevance"
  | "title"
  | "price"
  | "stock"
  | "newest";
export type ThcmListStockOrder = "asc" | "desc";

export type ThcmListStockOptions = {
  limit?: number;
  after?: string;
  before?: string;
  q?: string;
  sku?: string;
  category?: string;
  vendor?: string;
  tag?: string;
  color?: string;
  size?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  sort?: ThcmListStockSort;
  order?: ThcmListStockOrder;
  fresh?: boolean;
};

export type ThcmListStockResult = {
  rows: ThcmStockRow[];
  pageInfo: ThcmCursorPageInfo;
};

// ─────────────────────────────────────────────────────────────────────────────
// 3.2 Get Product
// ─────────────────────────────────────────────────────────────────────────────

export type ThcmProductVariant = {
  variantId: string;
  sku: string | null;
  variantTitle: string | null;
  options: Record<string, string>;
  price: string;
  compareAtPrice: string | null;
  availableQty: number;
};

export type ThcmProduct = {
  id: string;
  title: string;
  handle: string;
  description: string;
  category: string;
  vendor: string | null;
  tags: string[];
  status: "active" | "draft" | "archived";
  images: string[];
  variants: ThcmProductVariant[];
  matchedBy: "productId" | "variantId" | "sku" | "handle";
  matchedVariantId?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// 3.3 Create Order / 3.4 Get Order Status / 3.6 Cancel Order
// — all three read/write the same "order" shape
// ─────────────────────────────────────────────────────────────────────────────

export type ThcmShippingAddress = {
  country: string;
  province: string;
  city: string;
  zip: string;
  address1?: string;
  address2?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  company?: string;
};

export type ThcmCreateOrderItem = {
  sku: string;
  quantity: number;
};

export type ThcmCreateOrderRequest = {
  items: ThcmCreateOrderItem[];
  name: string;
  email: string;
  phone?: string;
  channel?: string;
  shippingAddress: ThcmShippingAddress;
};

export type ThcmOrderLineItem = {
  id: number;
  orderId: number;
  sku: string | null;
  title: string;
  quantity: number;
  price: string;
};

export type ThcmOrderStatusValue =
  | "open"
  | "cancelled"
  | "closed"
  | "fulfilled"
  | "refunded";

export type ThcmOrder = {
  id: number;
  shopifyOrderId: string;
  name: string;
  email: string;
  phone: string | null;
  status: ThcmOrderStatusValue;
  financialStatus: string | null;
  fulfillmentStatus: "partial" | "fulfilled" | null;
  deliveryStatus: string | null;
  closedAt: string | null;
  totalPrice: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
  channel: string;
  createdAt: string;
  updatedAt: string;
  lineItems: ThcmOrderLineItem[];
};

// 3.4 Get Order Status returns a narrower subset of the order shape (no
// name/email/phone/totalPrice/lineItems/etc.) — kept as its own type rather
// than `Partial<ThcmOrder>` so callers get exact field presence from the doc.
export type ThcmOrderStatus = {
  id: number;
  shopifyOrderId: string;
  status: ThcmOrderStatusValue;
  financialStatus: string | null;
  fulfillmentStatus: "partial" | "fulfilled" | null;
  deliveryStatus: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// 3.5 Get Employee Orders
// ─────────────────────────────────────────────────────────────────────────────

export type ThcmEmployeeOrderStage =
  | "pending"
  | "paid"
  | "partially_fulfilled"
  | "fulfilled"
  | "cancelled"
  | "refunded";

export type ThcmEmployeeOrder = ThcmOrder & {
  stage: ThcmEmployeeOrderStage;
  locked: boolean;
  canCancel: boolean;
};

export type ThcmGetEmployeeOrdersOptions = {
  status?: ThcmOrderStatusValue;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  after?: string;
  before?: string;
};

export type ThcmGetEmployeeOrdersResult = {
  orders: ThcmEmployeeOrder[];
  pageInfo: ThcmCursorPageInfo;
};

// ─────────────────────────────────────────────────────────────────────────────
// Error contract
//
// Every non-2xx response has { success: false, message, requestId }.
// Create Order's address-validation failures also carry `code`
// (INVALID_COUNTRY | INVALID_PIN | PIN_STATE_MISMATCH | PIN_CITY_MISMATCH).
// Cancel Order's "fulfilled, locked" 409 also carries `locked: true`.
// ─────────────────────────────────────────────────────────────────────────────

export type ThcmAddressErrorCode =
  | "INVALID_COUNTRY"
  | "INVALID_PIN"
  | "PIN_STATE_MISMATCH"
  | "PIN_CITY_MISMATCH";

export class ThcmShopApiError extends Error {
  readonly status: number;
  readonly code?: ThcmAddressErrorCode | string;
  readonly requestId?: string;
  readonly locked?: boolean;

  constructor(
    status: number,
    message: string,
    opts?: { code?: string; requestId?: string; locked?: boolean },
  ) {
    super(message);
    this.name = "ThcmShopApiError";
    this.status = status;
    this.code = opts?.code;
    this.requestId = opts?.requestId;
    this.locked = opts?.locked;
  }
}
