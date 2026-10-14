import { t } from './lib/i18n';
import type { ComponentType } from 'preact';
import { useEffect } from 'preact/hooks';
import { LocationProvider, Router, Route, lazy, useLocation, ErrorBoundary } from 'preact-iso';
import { AppShell } from './components/AppShell';
import { Spinner, Toaster } from './components/ui';
import { useStore } from './lib/store';
import { session } from './lib/session';
import { startSync, stopSync } from './lib/sync';
import { doorForRole, isOldAppPath, linkFor, readPath, signInPath } from './lib/portal';
import { reportError } from './lib/errors';
import { SCREENS, canSee, homeFor } from './routes';

// Pages load on demand to keep the first download small (§8.1).
const SignIn = lazy(() => import('./screens/SignIn'));
const Scan = lazy(() => import('./screens/Scan'));
const MyLeads = lazy(() => import('./screens/MyLeads'));
const Leads = lazy(() => import('./screens/Leads'));
const Team = lazy(() => import('./screens/Team'));
const Settings = lazy(() => import('./screens/Settings'));
const Companies = lazy(() => import('./screens/Companies'));
const Subscriptions = lazy(() => import('./screens/Subscriptions'));
const AuditLog = lazy(() => import('./screens/AuditLog'));
const Support = lazy(() => import('./screens/Support'));
const Usage = lazy(() => import('./screens/Usage'));
const Security = lazy(() => import('./screens/Security'));
const Profile = lazy(() => import('./screens/Profile'));

const COMPONENTS: Record<string, ComponentType> = {
  '/scan': Scan, '/my-leads': MyLeads, '/leads': Leads, '/team': Team, '/settings': Settings, '/settings/crm': Settings,
  '/companies': Companies, '/subscriptions': Subscriptions, '/audit': AuditLog, '/support': Support, '/usage': Usage,
  '/security': Security, '/profile': Profile,
};

const Loading = () => <div class="flex h-full items-center justify-center py-16" role="status" aria-label={t('Loading')} data-loading><Spinner class="size-7 text-brand-700" /></div>;

/**
 * Two doors: /super-admin for the WeTano Console and the plain address for the company app.
 * Inside each, the person's role decides which screens they can open; anything else sends them
 * to their own home screen.
 */
function Guarded() {
  const s = useStore(session);
  const { path, route } = useLocation();
  const { door, here } = readPath(path);

  useEffect(() => {
    if (s === undefined) return;
    // Company links from the days of three portals keep working.
    if (isOldAppPath(path)) { route(here + location.search + location.hash, true); return; }
    if (!s) {
      if (here !== '/signin') {
        // Come back here once they are in, if their role has this screen — but not when they
        // just signed out on purpose, or were signed out for being idle.
        const left = sessionStorage.getItem('wetasnap-left') === '1';
        if (left) sessionStorage.removeItem('wetasnap-left');
        const next = here === '/' || left ? '' : `?next=${encodeURIComponent(here + location.search)}`;
        route(`${signInPath(door)}${next}${location.hash}`, true);
      }
      return;
    }
    // A WeTano account belongs in the console, and a company account outside it. A screen this
    // role does have (profile, security, support) opens at its own address rather than sending
    // the person home for a missing prefix.
    if (doorForRole(s.person.role) !== door) {
      route(canSee(s.person.role, here) ? linkFor(s.person.role, here) + location.search : homeFor(s.person.role), true);
      return;
    }
    if (here === '/signin' || here === '/') {
      const asked = new URLSearchParams(location.search).get('next') ?? '';
      const target = asked.startsWith('/') ? asked : '';
      const wanted = readPath(target.split('?')[0]!).here;
      route(target && canSee(s.person.role, wanted) ? target : homeFor(s.person.role), true);
      return;
    }
    if (!canSee(s.person.role, here)) route(homeFor(s.person.role), true);
  }, [s, path]);

  useEffect(() => {
    if (s && s.person.role !== 'super_admin') startSync();
    else stopSync();
  }, [s?.person.id]);

  if (s === undefined) return <Loading />;
  if (!s) return here === '/signin' ? <SignIn door={door} /> : <Loading />;
  if (doorForRole(s.person.role) !== door || !canSee(s.person.role, here)) return <Loading />;

  const base = door === 'console' ? '/super-admin' : '';
  return (
    <AppShell>
      <Router>
        {SCREENS[s.person.role].map((p) => <Route key={p} path={base + p} component={COMPONENTS[p]!} />)}
        <Route default component={Loading} />
      </Router>
    </AppShell>
  );
}

export function App() {
  return (
    <LocationProvider>
      <ErrorBoundary onError={(e) => reportError(e, { action: 'Show a screen', where: 'App › ErrorBoundary' })}>
        <Guarded />
      </ErrorBoundary>
      <Toaster />
    </LocationProvider>
  );
}
