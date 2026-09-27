import { runtimeError } from "./errors.js";

export class Semaphore {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("semaphore limit must be a positive integer");
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(runtimeError("cancelled", "operation cancelled before resource acquisition"));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.#releaseOnce());
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null };
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(runtimeError("cancelled", "operation cancelled while waiting for resource"));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  #releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.#drain();
    };
  }

  #drain() {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter.signal?.aborted) {
        waiter.reject(runtimeError("cancelled", "operation cancelled while waiting for resource"));
        continue;
      }
      if (waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
      this.active += 1;
      waiter.resolve(this.#releaseOnce());
    }
  }
}

export class ResourceController {
  constructor(limits = { render: 1, probe: 1 }) {
    this.resources = new Map();
    for (const [name, limit] of Object.entries(limits)) this.resources.set(name, new Semaphore(limit));
  }

  async withResource(name, signal, fn) {
    const semaphore = this.resources.get(name);
    if (!semaphore) throw new TypeError(`unknown resource: ${name}`);
    const release = await semaphore.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
