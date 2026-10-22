import { t } from '../lib/i18n';

/** Placeholder until the real home page lands; the nav entry already points here. */
export default function Home() {
  return (
    <div class="mx-auto max-w-2xl py-10 text-center">
      <h1 class="title text-2xl">{t('Home')}</h1>
      <p class="mt-2 text-sm text-muted">{t('Coming soon.')}</p>
    </div>
  );
}
