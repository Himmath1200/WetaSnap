import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import './styles.css';
import { App } from './App';
import { requestPersistentStorage } from './lib/db';
import { initTheme } from './lib/theme';
import { installErrorCapture } from './lib/errors';
import { restoreSession } from './lib/session';
import { toast } from './lib/store';

installErrorCapture();
initTheme();
void requestPersistentStorage();
void restoreSession();
render(<App />, document.getElementById('app')!);

// Installable, offline-capable app with an update prompt (vite-plugin-pwa).
const update = import.meta.env.PROD ? registerSW({
  onNeedRefresh() {
    toast('A new version is ready — it will load the next time you open the app.', 'info', 6000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void update?.(true); }, { once: true });
  },
}) : null;
