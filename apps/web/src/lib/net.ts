import { createStore } from './store';

/** Connection state. `simulated` lets demos show offline behaviour without airplane mode. */
export const net = createStore({ online: typeof navigator === 'undefined' ? true : navigator.onLine ?? true, simulatedOffline: false });

export const isOnline = () => net.get().online && !net.get().simulatedOffline;

export class OfflineError extends Error {
  constructor() { super('offline'); }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => net.set((s) => ({ ...s, online: true })));
  window.addEventListener('offline', () => net.set((s) => ({ ...s, online: false })));
}
