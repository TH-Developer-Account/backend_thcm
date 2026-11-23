export type GRItemRaw = {
  MaterialDocument: string;
  MaterialDocumentYear: string;
  MaterialDocumentItem: string;
  MaterialDocumentDate: string; // "MM-DD-YYYY"
  MSNNo: string;
  MSNDescription: string;
  ProductionOrderNo: string;
  OrderDate: string; // "MM-DD-YYYY"
  Quantity: string;
  UoM: string;
  GRValue: string;
  Currency: string;
  Plant: string;
  PlantName: string;
};

export type InvoiceItemRaw = {
  InvoiceNo: string;
  InvoiceItemNo: string;
  InvoiceDate: string; // "MM-DD-YYYY"
  MSNNo: string;
  MSNDescription: string;
  Quantity: string;
  UoM: string;
  Plant: string;
  BilledValue: string;
  Currency: string;
  ShipTo: string;
  BillTo: string;
};

// From SAP ByD's analytics OData service. Only the three fields the sync
// actually uses are declared -- the feed returns many more (dealer/account/
// division/qty/currency/model) that were deliberately excluded from $select.
export type ByDBillingItemRaw = {
  C1IBR_OD_ITEM_IDsSERIAL_ID: string; // machine serial number (= MSNNo elsewhere)
  CDOC_INV_DATE: string; // "/Date(<epochMillis>)/", UTC
  CDOC_UUID: string; // purchase order / document number
};

// Partial Machine update, keyed by machineSerialNumber (= MSNNo).
export type MachineBillingUpdate = {
  purchaseOrderNo?: string | null;
  purchaseOrderDate?: Date | null;
  goodsReceiptDate?: Date | null;
  goodsReceiptValue?: number | null;
  plant?: string | null;
  invoiceNo?: string | null;
  invoiceDate?: Date | null;
  invoiceValue?: number | null;
};

export type MachineBillingSyncSummary = {
  dateFrom: string;
  dateTo: string;
  grRowsFetched: number;
  bydRowsFetched: number;
  invoiceRowsFetched: number;
  machinesUpdated: number;
  machinesCreated: number;
};
