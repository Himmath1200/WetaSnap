import { liveQuery } from 'dexie';
import { useEffect, useState } from 'preact/hooks';

/** Re-renders whenever the IndexedDB data behind `query` changes. */
export function useLive<T>(query: () => Promise<T>, deps: unknown[], initial: T): T {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({ next: setV, error: (e) => console.error(e) });
    return () => sub.unsubscribe();
  }, deps);
  return v;
}
