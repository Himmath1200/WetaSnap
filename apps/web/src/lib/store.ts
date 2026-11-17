import { useEffect, useState } from 'preact/hooks';
import { reportShownError } from './errors';

/** Minimal observable store — avoids pulling in a state library (size budget §8.1). */
export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: (v: T) => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<(v: T) => void>();
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? (next as (p: T) => T)(value) : next;
      subs.forEach((fn) => fn(value));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  const [v, setV] = useState(store.get());
  useEffect(() => {
    setV(store.get());
    return store.subscribe(setV);
  }, [store]);
  return v;
}

// ---- toasts ----
export interface Toast { id: number; text: string; tone: 'info' | 'success' | 'error' }
export const toasts = createStore<Toast[]>([]);
let toastId = 0;
export function toast(text: string, tone: Toast['tone'] = 'info', ms = 3500) {
  // An error toast means an action failed — record it in the audit log with where it happened.
  if (tone === 'error') void reportShownError(text);
  const id = ++toastId;
  toasts.set((t) => [...t, { id, text, tone }]);
  setTimeout(() => toasts.set((t) => t.filter((x) => x.id !== id)), ms);
}
