/**
 * scripts/importPincodes.ts
 *
 * One-time bulk import of the All India Pincodes Directory into the Pincode table.
 *
 * Strategy: xlsx → in-memory rows → pg COPY stream → Postgres
 * COPY is orders of magnitude faster than prisma.createMany for 165K rows.
 * The tsvector trigger fires on each inserted row automatically.
 *
 * Usage:
 *   npx ts-node scripts/importPincodes.ts ./data/All_India_Pincodes_Directory.xlsx
 *
 * Dependencies (add to devDependencies if not already present):
 *   npm install --save-dev xlsx pg @types/pg
 */
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import * as XLSX from "xlsx";
import { Client } from "pg";
import { randomUUID } from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface RawRow {
  circlename: string;
  regionname: string;
  divisionname: string;
  officename: string;
  pincode: string | number;
  officetype: string;
  delivery: string;
  district: string;
  statename: string;
  latitude: number;
  longitude: number;
}

interface PincodeRow {
  id: string;
  pincode: string;
  officeName: string;
  officeType: string;
  delivery: string;
  district: string;
  stateName: string;
  circleName: string;
  regionName: string;
  divisionName: string;
  latitude: number;
  longitude: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse xlsx
// ─────────────────────────────────────────────────────────────────────────────

function parseXlsx(filePath: string): PincodeRow[] {
  console.log(`📖 Reading ${filePath}...`);
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw: RawRow[] = XLSX.utils.sheet_to_json(sheet);

  console.log(`   ${raw.length} rows found`);

  return raw.map(
    (row): PincodeRow => ({
      id: randomUUID(),
      pincode: String(row.pincode).trim(),
      officeName: String(row.officename ?? "").trim(),
      officeType: String(row.officetype ?? "").trim(),
      delivery: String(row.delivery ?? "").trim(),
      district: String(row.district ?? "").trim(),
      stateName: String(row.statename ?? "").trim(),
      circleName: String(row.circlename ?? "").trim(),
      regionName: String(row.regionname ?? "").trim(),
      divisionName: String(row.divisionname ?? "").trim(),
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk insert via COPY
//
// Converts rows to a tab-separated stream and pipes into Postgres COPY.
// The trigger on the table auto-populates searchVector for each row.
// ─────────────────────────────────────────────────────────────────────────────

function rowsToCopyStream(rows: PincodeRow[]): Readable {
  // Tab-separated values — escape tabs and newlines in field values
  const escape = (value: string | number): string => {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/\t/g, "\\t")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r");
  };

  const lines = rows.map((row) =>
    [
      escape(row.id),
      escape(row.pincode),
      escape(row.officeName),
      escape(row.officeType),
      escape(row.delivery),
      escape(row.district),
      escape(row.stateName),
      escape(row.circleName),
      escape(row.regionName),
      escape(row.divisionName),
      escape(row.latitude),
      escape(row.longitude),
      "\\N", // searchVector — NULL, trigger will populate it
    ].join("\t"),
  );

  return Readable.from(lines.join("\n") + "\n");
}

async function bulkInsert(client: Client, rows: PincodeRow[]): Promise<void> {
  const copyQuery = `
    COPY "Pincode" (
      id, pincode, "officeName", "officeType", delivery,
      district, "stateName", "circleName", "regionName", "divisionName",
      latitude, longitude, "searchVector"
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
  const filePath = process.argv[2];
  if (!filePath) {
    console.error(
      "Usage: npx ts-node scripts/importPincodes.ts <path-to-xlsx>",
    );
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const client = new Client({
    connectionString:
      "postgresql://postgres:123@localhost:5432/postgres?schema=public",
  });

  try {
    await client.connect();
    console.log("✅ Connected to Postgres");

    // Idempotent — safe to re-run
    const existing = await client.query(`SELECT COUNT(*) FROM "Pincode"`);
    const existingCount = parseInt(existing.rows[0].count, 10);

    if (existingCount > 0) {
      console.log(`⚠️  Pincode table already has ${existingCount} rows.`);
      console.log("   Truncating before re-import...");
      await client.query(`TRUNCATE "Pincode"`);
    }

    const rows = parseXlsx(path.resolve(filePath));

    console.log(`⬆️  Inserting ${rows.length} rows via COPY...`);
    const startTime = Date.now();

    // Note: COPY bypasses the tsvector trigger.
    // We run the UPDATE below to populate searchVector after COPY.
    await bulkInsert(client, rows);

    const insertTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`   Inserted in ${insertTime}s`);

    // Populate searchVector in bulk — much faster than row-by-row trigger
    console.log("🔍 Building search vectors...");
    const vectorStart = Date.now();
    await client.query(`
      UPDATE "Pincode" SET
        "searchVector" =
          setweight(to_tsvector('english', coalesce(pincode, '')),         'A') ||
          setweight(to_tsvector('english', coalesce("officeName", '')),    'B') ||
          setweight(to_tsvector('english', coalesce(district, '')),        'C') ||
          setweight(to_tsvector('english', coalesce("stateName", '')),     'D')
    `);
    const vectorTime = ((Date.now() - vectorStart) / 1000).toFixed(2);
    console.log(`   Vectors built in ${vectorTime}s`);

    const final = await client.query(`SELECT COUNT(*) FROM "Pincode"`);
    console.log(`\n✅ Import complete. Total rows: ${final.rows[0].count}`);
  } catch (error) {
    console.error("❌ Import failed:", error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
