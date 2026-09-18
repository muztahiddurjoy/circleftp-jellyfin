/**
 * In-process event bus feeding the SSE endpoint.
 *
 * The download worker and the HTTP layer live in the same process, so progress
 * needs no broker — just a typed emitter. Listeners are SSE connections, and a
 * slow or dead one must never be able to block the worker, so delivery is
 * fire-and-forget and each listener's failures are its own.
 */
import { EventEmitter } from 'node:events';

import type { ServerEvent } from '@cfj/shared';

import { logger } from './logger.js';

class ServerEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open SSE connection; the default cap of 10 would warn
    // as soon as a few tabs are open.
    this.emitter.setMaxListeners(200);
  }

  publish(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    const wrapped = (event: ServerEvent): void => {
      try {
        listener(event);
      } catch (error) {
        // A broken client connection must not take down the worker's emit.
        logger.debug({ err: error }, 'SSE listener threw');
      }
    };
    this.emitter.on('event', wrapped);
    return () => this.emitter.off('event', wrapped);
  }

  get listenerCount(): number {
    return this.emitter.listenerCount('event');
  }
}

export const events = new ServerEventBus();
