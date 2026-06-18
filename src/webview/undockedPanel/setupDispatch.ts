/**
 * Must be the FIRST import in undockedPanel/main.tsx.
 *
 * The host wraps every outgoing message as { target: 'log'|'commit', msg }.
 * This module intercepts ALL window 'message' events, unwraps the envelope,
 * and re-dispatches the inner payload to two separate listener queues — one
 * for LOG messages and one for COMMIT messages.
 *
 * Sub-app components register via the normal window.addEventListener('message', ...)
 * call (patched below), and receive only the synthetic inner messages.
 * Messages from the wrong target arrive but are ignored by the sub-app switch/case.
 */

type Target = 'log' | 'commit';

const logHandlers: Array<(e: MessageEvent) => void> = [];
const commitHandlers: Array<(e: MessageEvent) => void> = [];

const originalAdd = EventTarget.prototype.addEventListener.bind(window);
const originalRemove = EventTarget.prototype.removeEventListener.bind(window);

// Weak map to track handler→wrapped function so removeEventListener works
const wrapMap = new WeakMap<object, (e: MessageEvent) => void>();

window.addEventListener = function(
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions,
): void {
  if (type !== 'message' || !listener) {
    return originalAdd(type, listener, options as boolean | undefined);
  }
  const fn = typeof listener === 'function' ? listener : (e: Event) => (listener as EventListenerObject).handleEvent(e);
  wrapMap.set(listener as object, fn as (e: MessageEvent) => void);
  logHandlers.push(fn as (e: MessageEvent) => void);
  commitHandlers.push(fn as (e: MessageEvent) => void);
};

window.removeEventListener = function(
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: boolean | EventListenerOptions,
): void {
  if (type !== 'message' || !listener) {
    return originalRemove(type, listener, options as boolean | undefined);
  }
  const fn = wrapMap.get(listener as object);
  if (!fn) return;
  wrapMap.delete(listener as object);
  const removeFrom = (arr: Array<(e: MessageEvent) => void>) => {
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  };
  removeFrom(logHandlers);
  removeFrom(commitHandlers);
};

// Central dispatcher registered on the real addEventListener
originalAdd('message', (e: Event) => {
  const me = e as MessageEvent;
  const envelope = me.data as { target?: Target; msg?: unknown } | null;
  if (!envelope?.target || !envelope?.msg) return;

  const synthetic = new MessageEvent('message', { data: envelope.msg });

  const handlers = envelope.target === 'log' ? logHandlers : commitHandlers;
  // Slice to avoid issues if handlers mutate during iteration
  handlers.slice().forEach(h => h(synthetic));
});
