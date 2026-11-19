/**
 * Shared reader for EOR_31.08.xls — the HR master export. Despite the .xls
 * extension this is UTF-16LE tab-delimited text, not a real binary
 * workbook (confirmed by inspecting the raw bytes), so it's read as a
 * string and split manually rather than handed to the xlsx package, which
 * would reject it outright ("Unsupported format").
 *
 * Columns (by fixed index, same "don't trust headers" convention as
 * importUserMaster.ts): Personnel Number, Name, Gender, Cost Center,
 * Cost Center Name, Grade, Designation, Division, Location, Manager ID,
 * Email ID.
 *
 * Extracted as its own module (rather than living inside one script) once
 * a second script (backfillHrMasters.ts, alongside updateUserHrData.ts)
 * needed the exact same parse of the exact same file — one source of truth
 * for "what EOR gives us," with each caller picking whichever fields it
 * needs off EorRecord.
 */
import * as fs from "fs";

import { toNullableString } from "./parseHelpers";

export interface EorRecord {
  employeeCode: string;
  name: string;
  email: string | undefined;
  grade: string | undefined;
  designation: string | undefined;
  division: string | undefined;
  costCenterCode: string | undefined;
  costCenterName: string | undefined;
  location: string | undefined;
}

export function parseEorRows(filePath: string): EorRecord[] {
  const content = fs.readFileSync(filePath, "utf16le");
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
  const [, ...dataLines] = lines; // drop header row — read by fixed index instead

  return dataLines.map((line) => {
    const cols = line.split("\t");
    return {
      employeeCode: toNullableString(cols[0]) ?? "",
      name: toNullableString(cols[1]) ?? "",
      costCenterCode: toNullableString(cols[3]),
      costCenterName: toNullableString(cols[4]),
      grade: toNullableString(cols[5]),
      designation: toNullableString(cols[6]),
      division: toNullableString(cols[7]),
      location: toNullableString(cols[8]),
      email: toNullableString(cols[10])?.toLowerCase(),
    };
  });
}
