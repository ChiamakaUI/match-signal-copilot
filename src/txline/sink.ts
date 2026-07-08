/**
 * In-memory {@link Sink} implementation for the TxLINE ingestion pipeline.
 *
 * {@link EventEmitterSink} fans out each pushed item to two independent
 * consumption paths:
 *   - push-subscribe callbacks registered via {@link EventEmitterSink.subscribe},
 *   - one or more async iterators (`for await...of`) obtained from the sink.
 *
 * There is no networking here — this is the pure, testable emitter that later
 * slices (SSE client, normalizer) write into.
 */

import type { Sink, Subscription } from "./types.js";

/**
 * A single-consumer buffered async queue.
 *
 * `put` either wakes a parked `next()` immediately or buffers the item until a
 * consumer asks for it, so items pushed before consumption are never lost and
 * each item is yielded exactly once. `end` completes the stream.
 */
class AsyncQueue<T> {
  readonly #buffer: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #ended = false;

  put(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return;
    }
    this.#buffer.push(item);
  }

  end(): void {
    this.#ended = true;
    let waiter = this.#waiters.shift();
    while (waiter !== undefined) {
      waiter({ value: undefined, done: true });
      waiter = this.#waiters.shift();
    }
  }

  async *drain(onDone: () => void): AsyncGenerator<T> {
    try {
      while (true) {
        if (this.#buffer.length > 0) {
          yield this.#buffer.shift() as T;
          continue;
        }
        if (this.#ended) return;
        const result = await new Promise<IteratorResult<T>>((resolve) => {
          this.#waiters.push(resolve);
        });
        if (result.done === true) return;
        yield result.value;
      }
    } finally {
      onDone();
    }
  }
}

export class EventEmitterSink<T> implements Sink<T> {
  readonly #listeners = new Set<(item: T) => void>();
  readonly #consumers = new Set<AsyncQueue<T>>();
  #closed = false;

  push(item: T): void {
    if (this.#closed) {
      throw new Error("EventEmitterSink: push() called after close()");
    }
    // Snapshot listeners so a subscriber that unsubscribes during delivery
    // does not perturb the in-flight fan-out order.
    for (const listener of [...this.#listeners]) {
      listener(item);
    }
    for (const consumer of this.#consumers) {
      consumer.put(item);
    }
  }

  subscribe(listener: (item: T) => void): Subscription {
    this.#listeners.add(listener);
    return {
      unsubscribe: (): void => {
        this.#listeners.delete(listener);
      },
    };
  }

  /**
   * Complete all async-iterator consumers and reject further pushes. Callback
   * subscribers simply stop receiving items.
   */
  close(): void {
    this.#closed = true;
    for (const consumer of this.#consumers) {
      consumer.end();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    const queue = new AsyncQueue<T>();
    // Register synchronously so items pushed after this call but before the
    // first next() are buffered rather than dropped.
    this.#consumers.add(queue);
    if (this.#closed) {
      queue.end();
    }
    return queue.drain(() => {
      this.#consumers.delete(queue);
    });
  }
}
