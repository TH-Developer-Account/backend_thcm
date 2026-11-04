// Generic retry-with-backoff wrapper. Each call to `operation` is
// independent, so a transient failure on one machine's C4C call never
// affects any other machine's call.

type RetryOptions = {
  attempts: number;
  delayMs: number;
};

export async function withRetry<T>(
  operation: () => Promise<T>,
  { attempts, delayMs }: RetryOptions,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delayMs * attempt); // linear backoff: 1s, 2s, 3s...
      }
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
