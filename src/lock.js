/**
 * Tiny in-process mutex keyed by string. Cloud Run runs a single instance
 * (max-instances 1), so this is enough to serialise read-modify-write work
 * on one tenant's Drive documents and to keep one chat's AI steps in order.
 *
 *   await withLock(locks, 'opp:U123', async () => { ...critical section... });
 *
 * `maxWaitMs` stops a hung holder from blocking everyone forever: after that
 * long the waiter proceeds anyway (best effort, logged).
 */
export function withLock(locks, key, fn, { maxWaitMs = 0 } = {}) {
  const prev = locks.get(key) || Promise.resolve();
  const waitPrev = maxWaitMs > 0
    ? Promise.race([prev, new Promise((resolve) => {
      const t = setTimeout(() => {
        console.warn(`lock ${key}: waited ${maxWaitMs} ms, continuing`);
        resolve();
      }, maxWaitMs);
      t.unref?.();
    })])
    : prev;
  const run = waitPrev.then(() => fn());
  const tail = run.then(() => {}, () => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}
