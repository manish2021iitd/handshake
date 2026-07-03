export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `fn` until `done(value)` is true or `timeoutMs` elapses.
 * `fn` may return null (e.g. "not found yet") — treated as not-done.
 * Returns the final value, or null on timeout.
 */
export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  done: (t: T) => boolean,
  timeoutMs: number,
  intervalMs = 40,
): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== null && done(v)) return v;
    if (Date.now() - start >= timeoutMs) return v ?? null;
    await sleep(intervalMs);
  }
}
