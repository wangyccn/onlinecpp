/** One in-flight write per file; queued revisions are replaced, not appended. */
export class WriteQueue<T> {
  private pending = new Map<string, { value: T; revision: number; due: number }>();
  private active = new Map<string, Promise<void>>();
  private waiters = new Map<string, Array<{ revision: number; resolve: () => void; reject: (error: unknown) => void }>>();
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private write: (path: string, value: T) => Promise<void>, private concurrency = 6) {}

  public enqueue(path: string, value: T, delay = 0): Promise<void> {
    const revision = ++this.revision;
    this.pending.set(path, { value, revision, due: Date.now() + delay });
    const promise = new Promise<void>((resolve, reject) => {
      const list = this.waiters.get(path) || [];
      list.push({ revision, resolve, reject });
      this.waiters.set(path, list);
    });
    this.drain();
    return promise;
  }

  public get busy(): boolean { return this.pending.size > 0 || this.active.size > 0; }

  public async flush(path?: string): Promise<void> {
    const matches = (key: string) => path === undefined || key === path || key.startsWith(path + '/');
    for (const [key, entry] of this.pending) if (matches(key)) entry.due = 0;
    const waits = [...this.waiters].filter(([key]) => matches(key)).flatMap(([, list]) => list).map((waiter) => new Promise<void>((resolve, reject) => {
      const success = waiter.resolve, failure = waiter.reject;
      waiter.resolve = () => { success(); resolve(); };
      waiter.reject = (error) => { failure(error); reject(error); };
    }));
    this.drain();
    await Promise.all(waits);
  }

  private drain(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    let nextDue = Infinity;
    for (const [path, entry] of this.pending) {
      if (this.active.has(path)) continue;
      if (this.active.size >= this.concurrency) break;
      if (entry.due > Date.now()) { nextDue = Math.min(nextDue, entry.due); continue; }
      this.pending.delete(path);
      // Defer IO until the caller has received its completion promise.
      const task = Promise.resolve().then(() => this.write(path, entry.value));
      this.active.set(path, task);
      task.then(() => this.settle(path, entry.revision), (error) => this.settle(path, entry.revision, error))
        .finally(() => { this.active.delete(path); this.drain(); });
    }
    if (nextDue !== Infinity) this.timer = setTimeout(() => this.drain(), Math.max(0, nextDue - Date.now()));
  }

  private settle(path: string, revision: number, error?: unknown): void {
    const remaining = [];
    for (const waiter of this.waiters.get(path) || []) {
      if (waiter.revision > revision) remaining.push(waiter);
      else if (error !== undefined) waiter.reject(error);
      else waiter.resolve();
    }
    if (remaining.length) this.waiters.set(path, remaining);
    else this.waiters.delete(path);
  }
}
