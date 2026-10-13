import { DashboardStore, type CapturedItem, type ClaimedJob } from "./store";

export type ItemCollector = (job: ClaimedJob, signal: AbortSignal) => Promise<CapturedItem>;

export class DashboardQueue {
  private timer?: ReturnType<typeof setInterval>;
  private task: Promise<void> | null = null;
  private current: { job: ClaimedJob; controller: AbortController } | null = null;
  private stopped = true;

  constructor(private readonly store: DashboardStore, private readonly collect: ItemCollector) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.store.recoverJobs();
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref();
    this.wake();
  }

  wake() {
    if (this.stopped || this.task) return;
    // Defer drain so task is assigned even when the queue is empty.
    this.task = Promise.resolve().then(() => this.drain()).catch((error) => {
      console.error("[dashboard queue]", error);
    }).finally(() => { this.task = null; });
  }

  cancelProduct(productId: number) {
    if (this.current?.job.product_id === productId) this.current.controller.abort();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.current?.controller.abort();
    await this.task;
  }

  private async drain() {
    while (!this.stopped) {
      const job = this.store.claimJob();
      if (!job) return;
      const controller = new AbortController();
      this.current = { job, controller };
      try {
        const item = await this.collect(job, controller.signal);
        if (this.stopped) this.store.requeueJob(job);
        else if (!controller.signal.aborted) this.store.completeJob(job, item);
      } catch (error) {
        const status = typeof error === "object" && error !== null ? Reflect.get(error, "status") : null;
        if (this.stopped || status === 429) {
          this.store.requeueJob(job);
          return;
        }
        this.store.failJob(job, error instanceof Error ? error.message : String(error));
      } finally {
        this.current = null;
      }
    }
  }
}
