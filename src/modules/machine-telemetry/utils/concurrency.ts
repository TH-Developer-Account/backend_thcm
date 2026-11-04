// Bounded-concurrency map: runs `worker` over every item in `items`, never
// more than `limit` calls in flight at once. Written in-house instead of
// pulling in a library (e.g. p-limit) — the whole thing is ~15 lines and
// this is the only place in the codebase that needs it so far (KISS: no
// new dependency for something this small).

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const index = nextIndex++;
    if (index >= items.length) return;
    results[index] = await worker(items[index]);
    await runNext();
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, runNext));

  return results;
}
