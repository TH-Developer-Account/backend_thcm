// Shared by both sync paths (ConSite and C4C) — each maps its own API's
// lat/long fields via Number(...), which silently produces NaN for a
// missing or non-numeric field. Turf's point() rejects NaN with
// "coordinates must contain numbers", and since pincode resolution runs
// as one synchronous .map() over the whole batch, a single NaN coordinate
// anywhere in that batch throws out of the entire pass — discarding every
// other machine's already-good data along with it, not just the bad one.
//
// So this check has to run BEFORE a row is treated as a success, at the
// point each row is first built — not caught later inside enrichRows.
// Any row that fails this check is handled exactly like any other
// per-machine failure (same bucket as "no record returned", "missing
// pin", etc.) — logged, counted, retried automatically on tomorrow's run.

export function hasValidCoordinates(
  latitude: number,
  longitude: number,
): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude);
}
