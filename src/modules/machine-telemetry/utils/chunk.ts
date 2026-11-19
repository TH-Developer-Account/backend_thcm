// Pure, generic — splits an array into fixed-size slices (the last one
// may be shorter). Used by runC4CSync to process machines in bounded
// batches (fetch → enrich → write per batch) instead of collecting the
// entire result set in memory before writing anything.

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push(items.slice(offset, offset + size));
  }
  return chunks;
}
