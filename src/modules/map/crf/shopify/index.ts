/**
 * modules/map/shopify/index.ts
 *
 * Barrel — everything outside this folder imports the THCM Shopify
 * integration from here, never from thcmShop.client/thcmShop.types
 * directly (project convention: import another module's index.ts only).
 */

export { thcmShopClient } from "./thcmShop.client";

export {
  ThcmShopApiError,
  type ThcmAddressErrorCode,
  type ThcmCursorPageInfo,
  type ThcmCreateOrderItem,
  type ThcmCreateOrderRequest,
  type ThcmEmployeeOrder,
  type ThcmEmployeeOrderStage,
  type ThcmOrder,
  type ThcmOrderLineItem,
  type ThcmOrderStatus,
  type ThcmOrderStatusValue,
  type ThcmProduct,
  type ThcmProductVariant,
  type ThcmShippingAddress,
  type ThcmStockRow,
  type ThcmGetEmployeeOrdersOptions,
  type ThcmGetEmployeeOrdersResult,
  type ThcmGetStockOptions,
  type ThcmListStockOptions,
  type ThcmListStockOrder,
  type ThcmListStockResult,
  type ThcmListStockSort,
} from "./thcmShop";
