export async function mapWithConcurrency(items, concurrency, mapper, { signal } = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer');
  }
  if (typeof mapper !== 'function') throw new TypeError('mapper must be a function');
  if (items.length === 0) return [];

  const results = new Array(items.length);
  let nextIndex = 0;
  let stopped = false;

  async function worker() {
    while (!stopped) {
      signal?.throwIfAborted();
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
