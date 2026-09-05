/**
 * Serializes work per session code.
 *
 * `propose` and `swapPlayer` both read who is already on a court and then
 * write a pairing built from that read. Two of them interleaving at an await
 * boundary can each compute against the same pre-write snapshot and assign the
 * same player to two courts — the exact race the engines were moved
 * server-side to prevent (docs/overview.md, "Why the engines run on the
 * server").
 *
 * This is in-process, so it holds for the single-API-container deployment in
 * `docker-compose.yml`. Running more than one API process would need a
 * database-level lock instead.
 */
export class SessionLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Settle either way — one caller's failure must not block the queue.
    const result = previous.then(work, work);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
