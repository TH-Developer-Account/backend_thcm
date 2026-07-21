/**
 * scripts/importBankBranches.ts
 *
 * One-time bulk import of Razorpay's IFSC.csv dataset into BankBranch.
 *
 * IMPORTANT CORRECTION: the JSON asset at this URL (IFSC.json) is a
 * compressed validation index (bank code -> branch-code suffixes), NOT
 * full branch records — it has no bank name, address, or district data.
 * The actual per-branch dataset is IFSC.csv (182K+ rows, ~36MB), confirmed
 * by inspecting a live download. Use that instead.
 *
 * URL uses /releases/latest/download/ rather than a pinned version tag —
 * verified this always resolves to the newest release, so it won't go
 * stale as Razorpay cuts new releases.
 *
 * Strategy: CSV (streamed, not loaded fully into memory) → pg COPY stream
 * → Postgres. Same approach as importPincodes.ts.
 *
 * Usage:
 *   npx ts-node scripts/importBankBranches.ts
 *
 * Requires DATABASE_URL in the environment.
 *
 * Dependencies (add to devDependencies if not already present):
 *   npm install --save-dev pg pg-copy-streams @types/pg csv-parse
 */
import dotenv from "dotenv";
import { Readable } from "stream";
import { Client } from "pg";
import { randomUUID } from "crypto";
import axios from "axios";
import { parse } from "csv-parse";
dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface RawCsvRow {
  BANK: string;
  IFSC: string;
  BRANCH: string;
  DISTRICT: string;
  STATE: string;
  ADDRESS: string;
  CITY: string;
}

interface BankBranchRow {
  id: string;
  ifsc: string;
  bankName: string;
  branchName: string;
  address: string;
  city: string;
  district: string;
  state: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch + parse dataset (streamed, since it's ~36MB / 182K rows)
// ─────────────────────────────────────────────────────────────────────────────

const IFSC_DATASET_URL =
  "https://github.com/razorpay/ifsc/releases/latest/download/IFSC.csv";

const BANK_NAMES_URL =
  "https://raw.githubusercontent.com/razorpay/ifsc/master/src/banknames.json";

async function fetchBankNameLookup(): Promise<Record<string, string>> {
  const { data } = await axios.get<Record<string, string>>(BANK_NAMES_URL);
  return data;
}

function resolveBankName(
  ifsc: string,
  csvBankName: string,
  bankNameLookup: Record<string, string>,
): string {
  if (csvBankName) return csvBankName;

  const bankCode = ifsc.slice(0, 4);
  return bankNameLookup[bankCode] ?? ""; // still empty if truly unmapped — see below
}

async function fetchBankBranchRows(): Promise<BankBranchRow[]> {
  const bankNameLookup = await fetchBankNameLookup();

  const response = await axios.get(IFSC_DATASET_URL, {
    responseType: "stream",
  });

  return new Promise((resolve, reject) => {
    const rows: BankBranchRow[] = [];
    const parser = parse({ columns: true, skip_empty_lines: true });

    response.data.pipe(parser);

    parser.on("data", (row: RawCsvRow) => {
      const ifsc = (row.IFSC ?? "").trim();
      rows.push({
        id: randomUUID(),
        ifsc,
        bankName: resolveBankName(
          ifsc,
          (row.BANK ?? "").trim(),
          bankNameLookup,
        ),
        branchName: (row.BRANCH ?? "").trim(),
        address: (row.ADDRESS ?? "").trim(),
        city: (row.CITY ?? "").trim(),
        district: (row.DISTRICT ?? "").trim(),
        state: (row.STATE ?? "").trim(),
      });
    });

    parser.on("end", () => {
      // rows is fully built here — check before handing off to the caller
      const unresolvedBankCodes = new Set(
        rows.filter((row) => !row.bankName).map((row) => row.ifsc.slice(0, 4)),
      );
      if (unresolvedBankCodes.size > 0) {
        console.warn(
          `⚠️  ${unresolvedBankCodes.size} bank codes have no resolvable name:`,
          [...unresolvedBankCodes].join(", "),
        );
      }

      resolve(rows);
    });
    parser.on("error", reject);
  });
}
// ─────────────────────────────────────────────────────────────────────────────
// Bulk insert via COPY (unchanged from before)
// ─────────────────────────────────────────────────────────────────────────────

function rowsToCopyStream(rows: BankBranchRow[]): Readable {
  const escape = (value: string): string => {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/\t/g, "\\t")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r");
  };

  const now = new Date().toISOString();

  const lines = rows.map((row) =>
    [
      escape(row.id),
      escape(row.ifsc),
      escape(row.bankName),
      escape(row.branchName),
      escape(row.address),
      escape(row.city),
      escape(row.district),
      escape(row.state),
      "\\N", // searchVector — NULL, populated in bulk after COPY
      escape(now),
    ].join("\t"),
  );

  return Readable.from(lines.join("\n") + "\n");
}

async function bulkInsert(
  client: Client,
  rows: BankBranchRow[],
): Promise<void> {
  const copyQuery = `
    COPY "BankBranch" (
      id, ifsc, "bankName", "branchName", address, city, district, state, "searchVector", "updated_at"
    )
    FROM STDIN
    WITH (FORMAT text, NULL '\\N')
  `;

  await new Promise<void>((resolve, reject) => {
    const stream = (client as any).query(
      require("pg-copy-streams").from(copyQuery),
    );
    stream.on("error", reject);
    stream.on("finish", resolve);
    rowsToCopyStream(rows).pipe(stream);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set — refusing to run without it.");
    process.exit(1);
  }

  const client = new Client({ connectionString });

  try {
    await client.connect();
    console.log("✅ Connected to Postgres");

    const existing = await client.query(`SELECT COUNT(*) FROM "BankBranch"`);
    const existingCount = parseInt(existing.rows[0].count, 10);

    if (existingCount > 0) {
      console.log(`⚠️  BankBranch table already has ${existingCount} rows.`);
      console.log("   Truncating before re-import...");
      await client.query(`TRUNCATE "BankBranch"`);
    }

    console.log(`📖 Streaming IFSC.csv from ${IFSC_DATASET_URL}...`);
    const rows = await fetchBankBranchRows();
    console.log(`   ${rows.length} branches parsed`);

    console.log(`⬆️  Inserting ${rows.length} rows via COPY...`);
    const startTime = Date.now();
    await bulkInsert(client, rows);
    const insertTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`   Inserted in ${insertTime}s`);

    console.log("🔍 Building search vectors...");
    const vectorStart = Date.now();
    await client.query(`
      UPDATE "BankBranch" SET
        "searchVector" =
          setweight(to_tsvector('english', coalesce("bankName", '')),   'A') ||
          setweight(to_tsvector('english', coalesce("branchName", '')), 'B') ||
          setweight(to_tsvector('english', coalesce(city, '')),         'C') ||
          setweight(to_tsvector('english', coalesce(ifsc, '')),         'D')
    `);
    const vectorTime = ((Date.now() - vectorStart) / 1000).toFixed(2);
    console.log(`   Vectors built in ${vectorTime}s`);

    const final = await client.query(`SELECT COUNT(*) FROM "BankBranch"`);
    console.log(`\n✅ Import complete. Total rows: ${final.rows[0].count}`);
  } catch (error) {
    console.error("❌ Import failed:", error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
