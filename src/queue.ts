import { ApiError } from './errors.js';
interface Job { start: () => Promise<void>; reject: (error: Error) => void; timer?: NodeJS.Timeout }
/** Bounded FIFO. A timed-out task retains its slot until its abort cleanup settles. */
export class WorkQueue {
  private pending: Job[] = [];
  private active = 0;
  private closed = false;
  private controllers = new Set<AbortController>();
  constructor(private concurrency: number, private maxQueue: number, private queueTimeoutMs: number, private operationTimeoutMs: number) {}
  get stats() { return { active: this.active, queued: this.pending.length, concurrency: this.concurrency }; }
  run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ApiError('SHUTTING_DOWN', 'The API is shutting down.', 503, true));
    if (this.active >= this.concurrency && this.pending.length >= this.maxQueue) {
      return Promise.reject(new ApiError('QUEUE_FULL', 'The browser queue is full. Retry later.', 503, true));
    }
    return new Promise<T>((resolve, reject) => {
      const job: Job = { reject, start: async () => {
        clearTimeout(job.timer);
        this.active++;
        const controller = new AbortController();
        this.controllers.add(controller);
        const timer = setTimeout(() => {
          const error = new ApiError('OPERATION_TIMEOUT', 'The registry lookup exceeded its time limit.', 504, true);
          controller.abort(error); reject(error);
        }, this.operationTimeoutMs);
        try { resolve(await fn(controller.signal)); } catch (error) { reject(error); }
        finally { clearTimeout(timer); this.controllers.delete(controller); this.active--; this.drain(); }
      }};
      if (this.active < this.concurrency) void job.start();
      else {
        job.timer = setTimeout(() => {
          this.pending = this.pending.filter(candidate => candidate !== job);
          reject(new ApiError('QUEUE_TIMEOUT', 'The lookup waited too long for a browser slot.', 503, true));
        }, this.queueTimeoutMs);
        this.pending.push(job);
      }
    });
  }
  private drain() { if (!this.closed && this.active < this.concurrency) void this.pending.shift()?.start(); }
  close() {
    this.closed = true;
    const error = new ApiError('SHUTTING_DOWN', 'The API is shutting down.', 503, true);
    for (const job of this.pending.splice(0)) { clearTimeout(job.timer); job.reject(error); }
    for (const controller of this.controllers) controller.abort(error);
  }
}
