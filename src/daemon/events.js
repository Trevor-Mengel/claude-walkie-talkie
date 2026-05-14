import { EventEmitter } from 'node:events';

/** Returns a fresh EventEmitter — one per daemon instance. */
export function createEvents() {
  const e = new EventEmitter();
  e.setMaxListeners(100);
  return e;
}
