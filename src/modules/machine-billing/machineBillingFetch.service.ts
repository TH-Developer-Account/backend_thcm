import { fetchAllODataPages } from "../../shared/utils/odata";
import {
  ByDBillingItemRaw,
  GRItemRaw,
  InvoiceItemRaw,
} from "./machineBilling.types";

const GR_ENTITY_SET = "GRItemSet";
const INVOICE_ENTITY_SET = "InvoiceItemSet";
const PAGE_SIZE = 1000;

// GR/Invoice run on a custom Z-service whose filter parser rejects the
// OData "datetime" type-literal keyword outright -- a live SAP error
// pointed at the exact character position of that word. The field itself
// comes back as a plain "MM-DD-YYYY" string (see GRItemRaw/InvoiceItemRaw),
// so comparing it as a quoted string literal in that same format is the
// next hypothesis: no "datetime" wrapper, just quotes around the value in
// the field's own stored shape.
//
// This is deliberately a *different* filter builder from ByD's below --
// they're unrelated SAP systems, and nothing says they share a filter
// grammar (ByD's confirmed working example uses datetime'...'; GR/Invoice
// has now told us twice that it doesn't accept that). Sharing one function
// between them was the actual bug, not the date format.
function toSapDateLiteral(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${month}-${day}-${year}`;
}

function buildDateRangeFilter(
  fieldName: string,
  dateFrom: string, // "YYYY-MM-DD"
  dateTo: string,
): string {
  const from = toSapDateLiteral(dateFrom);
  const to = toSapDateLiteral(dateTo);
  return `${fieldName} ge '${from}' and ${fieldName} le '${to}'`;
}

function buildPagedUrl(
  baseUrl: string,
  entitySet: string,
  filter: string,
  skip: number,
  top: number,
): string {
  const url =
    `${baseUrl}/${entitySet}` +
    `?$filter=${encodeURIComponent(filter)}` +
    `&$skip=${skip}&$top=${top}` +
    `&$format=json`;

  // TEMPORARY debug aid — remove once the filter syntax above is confirmed
  // working end to end. Lets you copy the exact outgoing URL and paste it
  // straight into a logged-in browser tab to check it independently of
  // axios/auth, the same way you tested the original URLs by hand.
  console.log(`[machine-billing] requesting: ${url}`);

  return url;
}

async function fetchODataDateRange<T>(
  baseUrlEnvVar: string,
  entitySet: string,
  dateFieldName: string,
  environmentPrefix: string,
  dateFrom: string,
  dateTo: string,
): Promise<T[]> {
  const baseUrl = process.env[baseUrlEnvVar];
  if (!baseUrl) throw new Error(`${baseUrlEnvVar} must be configured`);

  const filter = buildDateRangeFilter(dateFieldName, dateFrom, dateTo);

  return fetchAllODataPages<T>(
    (skip, top) => buildPagedUrl(baseUrl, entitySet, filter, skip, top),
    environmentPrefix,
    PAGE_SIZE,
  );
}

// dateFrom/dateTo: "YYYY-MM-DD"
export function fetchGRItems(
  dateFrom: string,
  dateTo: string,
): Promise<GRItemRaw[]> {
  return fetchODataDateRange<GRItemRaw>(
    "SAP_TH_GR_BASE_URL",
    GR_ENTITY_SET,
    "MaterialDocumentDate",
    "SAP_TH_GR",
    dateFrom,
    dateTo,
  );
}

export function fetchInvoiceItems(
  dateFrom: string,
  dateTo: string,
): Promise<InvoiceItemRaw[]> {
  return fetchODataDateRange<InvoiceItemRaw>(
    "SAP_TH_INV_BASE_URL",
    INVOICE_ENTITY_SET,
    "InvoiceDate",
    "SAP_TH_INV",
    dateFrom,
    dateTo,
  );
}

// ---- ByD billing feed -----------------------------------------------
//
// Structurally different from the two S4 feeds above: fixed $select list
// (the feed returns far more fields than we store), and the date filter
// is combined with a fixed "machine divisions" filter, since this
// analytics query also returns non-machine invoice lines. Credentials
// reuse the "SAP_BYD" env prefix already used for BYD_EMPLOYEES_URL
// elsewhere in this codebase, since it's the same ByD tenant.

const BYD_ENTITY_SET = "RPZ7BE6BC7B5026F04F7982D4QueryResults";
const BYD_SERIAL_FIELD = "C1IBR_OD_ITEM_IDsSERIAL_ID";
const BYD_INVOICE_DATE_FIELD = "CDOC_INV_DATE";
const BYD_INVOICE_NO_FIELD = "CDOC_UUID";
const BYD_DIVISION_FIELD = "C1GULUTW2TC5UU3ZM5CHWO5ZPKM";
// "Division (Machines)" codes, taken from the API doc's own sample URL.
// Hardcoded, same as the sample -- flag if this ever needs to be
// configurable instead.
const BYD_MACHINE_DIVISION_CODES = ["11", "12", "13"];
const BYD_SELECT_FIELDS = [
  BYD_SERIAL_FIELD,
  BYD_INVOICE_DATE_FIELD,
  BYD_INVOICE_NO_FIELD,
];

function buildByDDivisionFilter(): string {
  return BYD_MACHINE_DIVISION_CODES.map(
    (code) => `${BYD_DIVISION_FIELD} eq '${code}'`,
  ).join(" or ");
}

// ByD's engine is confirmed (from the API doc's own working sample) to use
// standard OData v2 datetime'...' literals -- kept separate from GR/
// Invoice's builder above since that service rejects this exact syntax.
function buildByDDateRangeFilter(dateFrom: string, dateTo: string): string {
  return `${BYD_INVOICE_DATE_FIELD} ge datetime'${dateFrom}T00:00:00' and ${BYD_INVOICE_DATE_FIELD} le datetime'${dateTo}T00:00:00'`;
}

function buildByDFilter(dateFrom: string, dateTo: string): string {
  const dateFilter = buildByDDateRangeFilter(dateFrom, dateTo);
  return `(${buildByDDivisionFilter()}) and (${dateFilter})`;
}

function buildByDPagedUrl(
  baseUrl: string,
  filter: string,
  skip: number,
  top: number,
): string {
  const url =
    `${baseUrl}/${BYD_ENTITY_SET}` +
    `?$select=${BYD_SELECT_FIELDS.join(",")}` +
    `&$filter=${encodeURIComponent(filter)}` +
    `&$skip=${skip}&$top=${top}` +
    `&$format=json`;

  console.log(`[machine-billing] requesting: ${url}`);

  return url;
}

export function fetchByDBillingItems(
  dateFrom: string,
  dateTo: string,
): Promise<ByDBillingItemRaw[]> {
  const baseUrl = process.env.SAP_BYD_BILLING_BASE_URL;
  if (!baseUrl) throw new Error("SAP_BYD_BILLING_BASE_URL must be configured");

  const filter = buildByDFilter(dateFrom, dateTo);

  return fetchAllODataPages<ByDBillingItemRaw>(
    (skip, top) => buildByDPagedUrl(baseUrl, filter, skip, top),
    "SAP_BYD",
    PAGE_SIZE,
  );
}
