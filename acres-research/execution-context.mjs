import {AsyncLocalStorage} from 'node:async_hooks';

// Carries cancellation through nested research providers without global fetch hooks.
// Billing settlement deliberately does not use this signal: dispatched work still
// needs to be reconciled after the user stops its consumer.
const execution = new AsyncLocalStorage();
export const executionSignal = () => execution.getStore();
export const withExecutionSignal = (signal, fn) => execution.run(signal, fn);
export function combinedSignal(...signals) {
  const active = signals.filter(Boolean);
  return active.length > 1 ? AbortSignal.any(active) : active[0];
}
export function throwIfCancelled() { executionSignal()?.throwIfAborted(); }
export function stoppedError(message = 'Stopped.') {
  return Object.assign(new Error(message), {name: 'AbortError', retryable: false});
}
export function requestSignal(timeoutMs) {
  throwIfCancelled();
  return combinedSignal(executionSignal(), AbortSignal.timeout(timeoutMs));
}
export function abortable(promise, signal = executionSignal()) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
