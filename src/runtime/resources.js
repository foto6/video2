import { runtimeError } from "./errors.js";

export const RESOURCE_CLASSES = Object.freeze(["cpu", "gpu", "render", "probe", "qa"]);

export const DEFAULT_RESOURCE_BUDGETS = Object.freeze({
  cpu: 2,
  gpu: 0,
  render: 1,
  probe: 1,
  qa: 1
});

function normalizeBudgets(input = {}) {
  const budgets = { ...DEFAULT_RESOURCE_BUDGETS, ...input };
  for (const name of RESOURCE_CLASSES) {
    const value = budgets[name];
    const minimum = name === "gpu" ? 0 : 1;
    if (!Number.isInteger(value) || value < minimum) {
      throw new TypeError(`resource budget ${name} must be an integer >= ${minimum}`);
    }
  }
  return budgets;
}

export function normalizeResourceRequirements(input = {}) {
  const requirements = {};
  for (const name of RESOURCE_CLASSES) {
    const value = input[name] ?? 0;
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`resource requirement ${name} must be a non-negative integer`);
    }
    requirements[name] = value;
  }
  return requirements;
}

function sameRequirements(a, b) {
  return RESOURCE_CLASSES.every((name) => a[name] === b[name]);
}

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
  constructor(limits = {}, { clock = () => Date.now() } = {}) {
    this.budgets = normalizeBudgets(limits);
    this.clock = clock;
    this.used = Object.fromEntries(RESOURCE_CLASSES.map((name) => [name, 0]));
    this.maxUsed = Object.fromEntries(RESOURCE_CLASSES.map((name) => [name, 0]));
    this.busySlotMs = Object.fromEntries(RESOURCE_CLASSES.map((name) => [name, 0]));
    this.waiters = [];
    this.externalReservations = new Map();
    this.startedAtMs = this.clock();
    this.lastAccountAtMs = this.startedAtMs;
    this.sequence = 0;
  }

  #account() {
    const now = this.clock();
    const elapsed = Math.max(0, now - this.lastAccountAtMs);
    if (elapsed > 0) {
      for (const name of RESOURCE_CLASSES) {
        this.busySlotMs[name] += this.used[name] * elapsed;
      }
      this.lastAccountAtMs = now;
    }
    return now;
  }

  #canFit(requirements) {
    return RESOURCE_CLASSES.every((name) =>
      this.used[name] + requirements[name] <= this.budgets[name]
    );
  }

  assertFitsBudget(input) {
    const requirements = normalizeResourceRequirements(input);
    for (const name of RESOURCE_CLASSES) {
      if (requirements[name] > this.budgets[name]) {
        throw runtimeError(
          "resource_profile_unavailable",
          `resource requirement ${name}=${requirements[name]} exceeds budget ${this.budgets[name]}`
        );
      }
    }
    return requirements;
  }

  #reserve(requirements) {
    this.#account();
    for (const name of RESOURCE_CLASSES) {
      this.used[name] += requirements[name];
      this.maxUsed[name] = Math.max(this.maxUsed[name], this.used[name]);
    }
  }

  #release(requirements) {
    this.#account();
    for (const name of RESOURCE_CLASSES) {
      this.used[name] -= requirements[name];
      if (this.used[name] < 0) {
        throw runtimeError("resource_accounting_error", `resource ${name} released below zero`);
      }
    }
    this.#drain();
  }

  acquire(input, signal = null) {
    const requirements = this.assertFitsBudget(input);
    if (signal?.aborted) {
      return Promise.reject(runtimeError("cancelled", "operation cancelled before resource acquisition"));
    }

    const requestedAtMs = this.clock();
    if (this.#canFit(requirements) && this.waiters.length === 0) {
      this.#reserve(requirements);
      return Promise.resolve(this.#lease(requirements, requestedAtMs));
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        sequence: this.sequence++,
        requirements,
        requestedAtMs,
        resolve,
        reject,
        signal,
        abort: null
      };
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(runtimeError("cancelled", "operation cancelled while waiting for resources"));
          this.#drain();
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
      this.#drain();
    });
  }

  #lease(requirements, requestedAtMs) {
    let released = false;
    const acquiredAtMs = this.clock();
    return {
      requirements: { ...requirements },
      waitMs: Math.max(0, acquiredAtMs - requestedAtMs),
      release: () => {
        if (released) return false;
        released = true;
        this.#release(requirements);
        return true;
      }
    };
  }

  #drain() {
    for (;;) {
      const waiter = this.waiters[0];
      if (!waiter) return;
      if (waiter.signal?.aborted) {
        this.waiters.shift();
        waiter.reject(runtimeError("cancelled", "operation cancelled while waiting for resources"));
        continue;
      }
      if (!this.#canFit(waiter.requirements)) return;
      this.waiters.shift();
      if (waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
      this.#reserve(waiter.requirements);
      waiter.resolve(this.#lease(waiter.requirements, waiter.requestedAtMs));
    }
  }

  reserveExternal(token, input) {
    if (typeof token !== "string" || token.length === 0) throw new TypeError("external reservation token is required");
    const requirements = normalizeResourceRequirements(input);
    const existing = this.externalReservations.get(token);
    if (existing) {
      if (!sameRequirements(existing, requirements)) {
        throw runtimeError("resource_reservation_conflict", `external reservation ${token} changed requirements`);
      }
      return false;
    }

    this.#reserve(requirements);
    this.externalReservations.set(token, { ...requirements });
    return true;
  }

  releaseExternal(token) {
    const requirements = this.externalReservations.get(token);
    if (!requirements) return false;
    this.externalReservations.delete(token);
    this.#release(requirements);
    return true;
  }

  hasExternalReservation(token) {
    return this.externalReservations.has(token);
  }

  async withResource(name, signal, fn) {
    return this.withResources({ [name]: 1 }, signal, fn);
  }

  async withResources(requirements, signal, fn) {
    const lease = await this.acquire(requirements, signal);
    try {
      return await fn({ waitMs: lease.waitMs, requirements: lease.requirements });
    } finally {
      lease.release();
    }
  }

  snapshot() {
    const now = this.#account();
    const elapsed = Math.max(1, now - this.startedAtMs);
    const utilization = {};
    for (const name of RESOURCE_CLASSES) {
      const capacityMs = this.budgets[name] * elapsed;
      utilization[name] = capacityMs > 0
        ? Math.min(1, this.busySlotMs[name] / capacityMs)
        : (this.used[name] > 0 ? 1 : 0);
    }
    return {
      budgets: { ...this.budgets },
      used: { ...this.used },
      maxUsed: { ...this.maxUsed },
      waiters: this.waiters.length,
      externalReservations: this.externalReservations.size,
      busySlotMs: { ...this.busySlotMs },
      utilization
    };
  }
}
