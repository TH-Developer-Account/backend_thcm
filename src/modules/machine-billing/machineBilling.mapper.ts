import {
  ByDBillingItemRaw,
  GRItemRaw,
  InvoiceItemRaw,
  MachineBillingUpdate,
} from "./machineBilling.types";

// SAP sends dates as "MM-DD-YYYY" strings on these two custom services.
export function parseSapDate(value: string): Date {
  const [month, day, year] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

const IST_OFFSET_MILLIS = (5 * 60 + 30) * 60 * 1000;

// ByD's analytics service returns dates as "/Date(<epochMillis>)/" in UTC
// and (per the API doc) cannot convert to local time server-side, so the
// +5:30 IST offset has to be applied on our side.
export function parseByDEpochDate(value: string): Date {
  const match = value.match(/\/Date\((\d+)\)\//);
  if (!match) {
    throw new Error(`Unexpected ByD date format: "${value}"`);
  }
  return new Date(Number(match[1]) + IST_OFFSET_MILLIS);
}

// Shared by all three reducers below -- picking "the latest row per
// machine" is the same operation for GR, ByD and Invoice, they just differ
// in which field is the machine key and which field is the date to compare.
function pickLatestPerMachine<T>(
  rows: T[],
  getMachineSerial: (row: T) => string,
  getDate: (row: T) => Date,
): Map<string, T> {
  const latestByMachine = new Map<string, T>();

  for (const row of rows) {
    const serial = getMachineSerial(row);
    const existing = latestByMachine.get(serial);
    if (!existing || getDate(row) > getDate(existing)) {
      latestByMachine.set(serial, row);
    }
  }

  return latestByMachine;
}

export function pickLatestGRItemPerMachine(
  rows: GRItemRaw[],
): Map<string, GRItemRaw> {
  return pickLatestPerMachine(
    rows,
    (row) => row.MSNNo,
    (row) => parseSapDate(row.MaterialDocumentDate),
  );
}

export function pickLatestByDBillingItemPerMachine(
  rows: ByDBillingItemRaw[],
): Map<string, ByDBillingItemRaw> {
  return pickLatestPerMachine(
    rows,
    (row) => row.C1IBR_OD_ITEM_IDsSERIAL_ID,
    (row) => parseByDEpochDate(row.CDOC_INV_DATE),
  );
}

export function pickLatestInvoiceItemPerMachine(
  rows: InvoiceItemRaw[],
): Map<string, InvoiceItemRaw> {
  return pickLatestPerMachine(
    rows,
    (row) => row.MSNNo,
    (row) => parseSapDate(row.InvoiceDate),
  );
}

function mapGRItemToUpdate(row: GRItemRaw): MachineBillingUpdate {
  return {
    purchaseOrderNo: row.ProductionOrderNo,
    purchaseOrderDate: parseSapDate(row.OrderDate),
    goodsReceiptDate: parseSapDate(row.MaterialDocumentDate),
    // GRValue/BilledValue arrive as decimal strings (e.g. "3843053.44")
    // but Machine.goodsReceiptValue/invoiceValue are Int columns from the
    // original Excel import -- rounding to the nearest rupee here, same
    // as that column's existing precision. If exact paise matter
    // downstream, these two columns need to become Decimal first.
    goodsReceiptValue: Math.round(parseFloat(row.GRValue)),
    plant: row.Plant,
  };
}

function mapByDBillingItemToUpdate(
  row: ByDBillingItemRaw,
): MachineBillingUpdate {
  return {
    purchaseOrderNo: row.CDOC_UUID,
    purchaseOrderDate: parseByDEpochDate(row.CDOC_INV_DATE),
  };
}

// Deliberately omits `plant` -- GR's plant always wins per the agreed
// design, simply by Invoice never writing that column.
function mapInvoiceItemToUpdate(row: InvoiceItemRaw): MachineBillingUpdate {
  return {
    invoiceNo: row.InvoiceNo,
    invoiceDate: parseSapDate(row.InvoiceDate),
    invoiceValue: Math.round(parseFloat(row.BilledValue)),
  };
}

// GR and ByD both supply purchaseOrderNo/purchaseOrderDate for the same
// machine. Per the agreed rule, whichever source's date is more recent
// wins those two fields; goodsReceiptDate/goodsReceiptValue/plant stay
// GR-only regardless, since ByD has no equivalent for them.
function buildPurchaseOrderUpdate(
  grRow: GRItemRaw | undefined,
  bydRow: ByDBillingItemRaw | undefined,
): MachineBillingUpdate {
  const grUpdate = grRow ? mapGRItemToUpdate(grRow) : {};
  if (!bydRow) return grUpdate;

  const bydIsNewer =
    !grRow ||
    parseByDEpochDate(bydRow.CDOC_INV_DATE) > parseSapDate(grRow.OrderDate);
  if (!bydIsNewer) return grUpdate;

  return { ...grUpdate, ...mapByDBillingItemToUpdate(bydRow) };
}

// Merges the latest GR, latest ByD and latest Invoice update per machine
// into one combined Machine-update payload.
export function buildMachineUpdates(
  latestGRByMachine: Map<string, GRItemRaw>,
  latestByDByMachine: Map<string, ByDBillingItemRaw>,
  latestInvoiceByMachine: Map<string, InvoiceItemRaw>,
): Map<string, MachineBillingUpdate> {
  const updates = new Map<string, MachineBillingUpdate>();

  const purchaseOrderMachineSerials = new Set([
    ...latestGRByMachine.keys(),
    ...latestByDByMachine.keys(),
  ]);

  for (const serial of purchaseOrderMachineSerials) {
    updates.set(
      serial,
      buildPurchaseOrderUpdate(
        latestGRByMachine.get(serial),
        latestByDByMachine.get(serial),
      ),
    );
  }

  for (const [serial, row] of latestInvoiceByMachine) {
    const existing = updates.get(serial) ?? {};
    updates.set(serial, { ...existing, ...mapInvoiceItemToUpdate(row) });
  }

  return updates;
}
