/** One request at a time; stop/start invalidates callbacks from older loops. */
export class PollLoop {
  constructor(task, interval = 3000, schedule = (...args) => setTimeout(...args), cancel = timer => clearTimeout(timer)) {
    Object.assign(this, { task, interval, schedule, cancel });
    this.generation = 0;
    this.timer = null;
    this.running = false;
  }
  start() {
    this.stop();
    this.running = true;
    const generation = this.generation;
    const tick = async () => {
      if (!this.running || generation !== this.generation) return;
      try { await this.task(); }
      finally {
        if (this.running && generation === this.generation) this.timer = this.schedule(tick, this.interval);
      }
    };
    this.timer = this.schedule(tick, 0);
  }
  stop() {
    this.running = false;
    this.generation++;
    if (this.timer != null) this.cancel(this.timer);
    this.timer = null;
  }
}
