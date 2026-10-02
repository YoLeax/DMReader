import { useCallback, useEffect, useState } from 'react';

const pages = ['overview', 'analytics', 'events', 'voices', 'viewers', 'designs', 'logs', 'settings'] as const;
export type Page = typeof pages[number];
const pageFromHash = (hash: string): Page => pages.find(page => hash === `#${page}`) || 'overview';

export function useHashPage(): [Page, (page: Page) => void] {
  const [page, setPage] = useState(() => pageFromHash(window.location.hash));
  useEffect(() => {
    const sync = () => {
      const current = pageFromHash(window.location.hash);
      // Replace empty or unknown routes without adding a back-button trap.
      if (window.location.hash !== `#${current}`) {
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${current}`);
      }
      setPage(current);
    };
    window.addEventListener('hashchange', sync);
    sync();
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const navigate = useCallback((next: Page) => {
    if (window.location.hash !== `#${next}`) window.location.hash = next;
  }, []);
  return [page, navigate];
}
