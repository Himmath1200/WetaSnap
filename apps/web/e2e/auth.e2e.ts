import { test, expect } from './fixtures';
import { ACC, HOME, PW, backendCall, demoCode, expectToast, deviceRows, fillCode, invitationCode, nav, openMenu, signIn, signOut, submitPassword, uniq } from './helpers';

const alert = (page: import('@playwright/test').Page) => page.getByRole('alert');

test.describe('1 · Portals & auth', () => {
  test('“/” is the one sign-in page — there is no portal to choose', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Choose another portal' })).toHaveCount(0);
  });

  test('old portal links still work: /client-admin/leads → /leads', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await page.goto('/client-admin/leads');
    await expect(page).toHaveURL(/\/leads$/);
    await page.goto('/staff/my-leads');
    await expect(page).toHaveURL(/\/my-leads$/);
  });

  test('two doors: WeTano has its own address, companies share the main one', async ({ page }) => {
    await page.goto('/super-admin');
    await expect(page).toHaveURL(/\/super-admin\/signin$/);
    await expect(page.getByText('WeTano Console')).toBeVisible();

    await page.goto('/');
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByText('WeTano Console')).toHaveCount(0);
  });

  test('an account at the wrong door is refused and told where to go', async ({ page }) => {
    await submitPassword(page, 'client-admin', ACC.super); // WeTano account on the company page
    await expect(alert(page)).toHaveText('WeTano accounts sign in at /super-admin.');

    await page.goto('/super-admin/signin');
    await page.locator('#si-email').fill(ACC.admin); // company account in the console
    await page.locator('#si-pw').fill(PW);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(alert(page)).toHaveText('This is the WeTano Console. Your account signs in at the main address.');
  });

  test('a signed-in super admin keeps the console prefix; company screens send them back', async ({ page }) => {
    await signIn(page, 'super-admin', ACC.super);
    await expect(page).toHaveURL(/\/super-admin\/companies$/);
    await page.goto('/leads');
    await expect(page).toHaveURL(/\/super-admin\/companies$/);
  });

  test('staff sign-in is one step (password) and lands on Scan', async ({ page }) => {
    await page.goto('/signin');
    await expect(page.getByRole('list', { name: 'Sign-in steps' })).toHaveCount(0);
    await submitPassword(page, 'staff', ACC.anna); // one page, one step for staff
    await expect(page).toHaveURL(/\/scan$/);
    await expect(page.getByText('Welcome, Anna')).toBeVisible();
  });

  test('client admin sign-in: password → emailed code → Leads', async ({ page }) => {
    await page.goto('/signin');
    await submitPassword(page, 'client-admin', ACC.admin);
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Sign-in steps' }).locator('li')).toHaveCount(2);
    await expect(page.getByText(`We sent a 6-digit code to ${ACC.admin}`)).toBeVisible();
    await fillCode(page, await demoCode(page));
    await expect(page).toHaveURL(/\/leads$/);
    await expect(page.getByRole('heading', { name: 'Leads', exact: true })).toBeVisible();
  });

  test('super admin sign-in: password → emailed code → Companies (no authenticator required)', async ({ page }) => {
    await page.goto('/super-admin/signin');
    await submitPassword(page, 'super-admin', ACC.super);
    await fillCode(page, await demoCode(page));
    await expect(page).toHaveURL(/\/super-admin\/companies$/);
    await expect(page.getByRole('heading', { name: 'Authenticator code' })).toHaveCount(0);
  });

  test('an authenticator is asked for only once the person sets one up, and can be turned off', async ({ page }) => {
    await signIn(page, 'super-admin', ACC.super);
    await page.goto('/super-admin/security?tab=account');
    await page.getByRole('button', { name: 'Set up two-factor' }).click();
    await page.locator('#mfa-code').fill('123456');
    await page.getByRole('button', { name: 'Turn on two-factor' }).click();
    await expectToast(page, 'Two-factor is on');
    await signOut(page);

    // Now this account is asked for it.
    await submitPassword(page, 'super-admin', ACC.super);
    await fillCode(page, await demoCode(page));
    await expect(page.getByRole('heading', { name: 'Authenticator code' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Sign-in steps' }).locator('li')).toHaveCount(3);
    await fillCode(page, '482913');
    await expect(page).toHaveURL(/\/super-admin\/companies$/);

    // …and nothing forces it to stay on.
    await page.goto('/super-admin/security?tab=account');
    await page.getByRole('button', { name: 'Turn off two-factor' }).click();
    await page.getByRole('dialog').getByLabel('Code from the app').fill('123456');
    await page.getByRole('dialog').getByRole('button', { name: 'Turn it off' }).click();
    await expectToast(page, 'Two-factor is off');
    await signOut(page);
    await submitPassword(page, 'super-admin', ACC.super);
    await fillCode(page, await demoCode(page));
    await expect(page).toHaveURL(/\/super-admin\/companies$/);
  });

  test('tabs never disagree: signing in as someone else in a second tab moves the first one too', async ({ page, context }) => {
    test.setTimeout(180_000);
    await signIn(page, 'staff', ACC.anna);
    await expect(page).toHaveURL(/\/scan$/);

    // A duplicated tab — same browser, same device session.
    const tab2 = await context.newPage();
    await tab2.goto('/scan');
    await expect(tab2).toHaveURL(/\/scan$/);

    // Somebody else signs in there.
    await signOut(tab2);
    await submitPassword(tab2, 'client-admin', ACC.admin);
    await fillCode(tab2, await demoCode(tab2));
    await expect(tab2).toHaveURL(/\/leads$/);

    // The first tab must not still be showing Anna's scanner.
    await expect(page, 'the older tab follows the new person to their own home').toHaveURL(/\/leads$/, { timeout: 30_000 });
    await expect(page.getByText('Julia Hoffmann').first()).toBeVisible();

    // And a sign-out anywhere signs out every tab.
    await signOut(tab2);
    await expect(page, 'a sign-out in one tab reaches the others').toHaveURL(/\/signin/, { timeout: 30_000 });
    await tab2.close();
  });

  test('form validation: invalid email, empty password', async ({ page }) => {
    await page.goto('/signin');
    await page.locator('#si-email').fill('not-an-email');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(alert(page)).toHaveText('Please enter your work email.');
    await page.locator('#si-email').fill(ACC.anna);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(alert(page)).toHaveText('Please enter your password.');
  });

  test('wrong password is refused and the remaining attempts are counted down', async ({ page }) => {
    await page.goto('/signin');
    await submitPassword(page, 'staff', ACC.ben, 'Wrong#Pass123');
    await expect(alert(page)).toHaveText('That email and password do not match.');
    await submitPassword(page, 'staff', ACC.ben, 'Wrong#Pass123');
    await expect(alert(page)).toHaveText('That email and password do not match.');
    await submitPassword(page, 'staff', ACC.ben, 'Wrong#Pass123');
    await expect(alert(page)).toContainText('2 attempts left before the account locks');
  });

  test('unknown email gets the same neutral message', async ({ page }) => {
    await submitPassword(page, 'staff', 'nobody@nowhere.example', PW);
    await expect(alert(page)).toHaveText('That email and password do not match.');
  });

  test('lockout after the policy number of wrong passwords (5)', async ({ page }) => {
    await page.goto('/signin');
    for (let i = 1; i <= 5; i++) {
      await submitPassword(page, 'staff', ACC.ben, `Wrong#Pass12${i}`);
      await expect(alert(page)).toBeVisible();
    }
    await expect(alert(page)).toHaveText('Too many wrong passwords. The account is locked for 15 minutes.');
    // The right password is refused while locked.
    await submitPassword(page, 'staff', ACC.ben, PW);
    await expect(alert(page)).toContainText('Too many wrong passwords. Try again in a few minutes');
  });

  test('seeded locked account (Verde · Luca Ferrari) is refused even with the right password', async ({ page }) => {
    await submitPassword(page, 'staff', ACC.locked, PW);
    await expect(alert(page)).toContainText('Too many wrong passwords');
    await expect(page).toHaveURL(/\/signin/);
  });

  test('wrong emailed code is refused', async ({ page }) => {
    await submitPassword(page, 'client-admin', ACC.admin);
    const code = await demoCode(page);
    const wrong = code === '111111' ? '222222' : '111111';
    await fillCode(page, wrong);
    await expect(alert(page)).toHaveText('That code is not right. Please try again.');
    await expect(page).toHaveURL(/\/signin/);
  });

  test('resend code: waits 30 s, then issues a new code that works (old one no longer does)', async ({ page }) => {
    test.setTimeout(120_000);
    await submitPassword(page, 'client-admin', ACC.admin);
    const first = await demoCode(page);
    await expect(page.getByRole('button', { name: /Resend in \d+s/ })).toBeDisabled();
    const resend = page.getByRole('button', { name: 'Resend code' });
    await expect(resend).toBeEnabled({ timeout: 40_000 });
    await resend.click();
    await expect.poll(() => demoCode(page)).not.toBe(first);
    const second = await demoCode(page);
    await fillCode(page, first);
    await expect(alert(page)).toHaveText('That code is not right. Please try again.');
    await fillCode(page, second);
    await expect(page).toHaveURL(/\/leads$/);
  });

  const lands: [string, 'staff' | 'client-admin' | 'super-admin', string, RegExp][] = [
    ['staff', 'staff', ACC.anna, /\/scan$/],
    ['a client admin', 'client-admin', ACC.admin, /\/leads$/],
    ['a super admin', 'super-admin', ACC.super, /\/companies$/],
  ];
  for (const [who, portal, email, home] of lands) {
    test(`one sign-in page: ${who} lands where that account belongs`, async ({ page }) => {
      await signIn(page, portal, email);
      await expect(page).toHaveURL(home);
    });
  }

  test('signed-in staff opening the admin portal or the console is sent to their own home', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    for (const url of ['/leads', '/team', '/companies', '/audit', '/signin']) {
      await page.goto(url);
      await expect(page).toHaveURL(new RegExp(`${HOME.staff}$`));
    }
  });

  test('a client admin opening a WeTano screen is sent to their own home', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    for (const url of ['/companies', '/usage', '/audit', '/signin']) {
      await page.goto(url);
      await expect(page).toHaveURL(new RegExp(`${HOME['client-admin']}$`));
    }
    await page.goto('/scan'); // scanning is theirs too
    await expect(page).toHaveURL(/\/scan$/);
  });

  test('a super admin opening a company screen is sent to their own home', async ({ page }) => {
    await signIn(page, 'super-admin', ACC.super);
    for (const url of ['/leads', '/scan']) {
      await page.goto(url);
      await expect(page).toHaveURL(new RegExp(`${HOME['super-admin']}$`));
    }
  });

  test('screens keep their own URLs, and “/” goes home', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await page.goto('/team');
    await expect(page).toHaveURL(/\/team$/);
    await page.goto('/settings/crm');
    await expect(page).toHaveURL(/\/settings\/crm$/);
    await expect(page.getByRole('tab', { name: 'CRM connection', selected: true })).toBeVisible();
    await page.goto('/');
    await expect(page).toHaveURL(/\/leads$/);
  });

  for (const [portal, email] of [['staff', ACC.anna], ['client-admin', ACC.admin], ['super-admin', ACC.super]] as const) {
    test(`sign-out asks yes/no and returns to the sign-in page: ${portal}`, async ({ page }) => {
      await signIn(page, portal, email);
      let sheet = await openMenu(page);
      await sheet.getByRole('button', { name: 'Sign out' }).click();
      const dlg = page.getByRole('dialog').filter({ hasText: 'Sign out?' });
      await expect(dlg).toBeVisible();
      await dlg.getByRole('button', { name: 'No, stay signed in' }).click();
      await expect(dlg).toBeHidden();
      await expect(page).toHaveURL(new RegExp(HOME[portal]));
      await page.keyboard.press('Escape');
      sheet = await openMenu(page);
      await sheet.getByRole('button', { name: 'Sign out' }).click();
      await page.getByRole('button', { name: 'Yes, sign out' }).click();
      await expect(page).toHaveURL(/\/signin$/);
      // Signing out wipes the device.
      expect(await deviceRows(page, 'session')).toHaveLength(0);
    });
  }

  test('sign-out confirmation copy matches the sign-in method (staff use a password, not an emailed code)', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    const sheet = await openMenu(page);
    await sheet.getByRole('button', { name: 'Sign out' }).click();
    const dlg = page.getByRole('dialog').filter({ hasText: 'Sign out?' });
    await expect(dlg).toBeVisible();
    await expect(dlg).not.toContainText('email code');
  });

  test('idle timeout signs the person out and says why', async ({ page }) => {
    test.setTimeout(150_000); // the watcher looks every 15 s
    await signIn(page, 'staff', ACC.anna);
    const s = await deviceRows<{ idle_timeout_minutes: number }>(page, 'session');
    expect(s[0]!.idle_timeout_minutes).toBe(30); // from the default security policy
    await page.evaluate(async () => {
      const path = '/src/lib/session.ts';
      const m = await import(/* @vite-ignore */ path);
      const cur = m.session.get();
      m.session.set({ ...cur, last_active_at: new Date(Date.now() - 31 * 60_000).toISOString() });
    });
    await expect(page).toHaveURL(/\/signin$/, { timeout: 90_000 });
    await expect(page.getByText('You were signed out. Sign in again to continue.')).toBeVisible();
  });

  test('idle timeout set by the Super Admin in Security → Policy reaches devices', async ({ page }) => {
    await signIn(page, 'super-admin', ACC.super);
    await page.goto('/super-admin/security');
    await expect(page.getByRole('tab', { name: 'Policy', selected: true })).toBeVisible();
    await page.locator('#sp-idle').fill('1');
    await page.getByRole('button', { name: 'Save security rules' }).click();
    await expect(page.getByText('Security rules saved')).toBeVisible();
    await signOut(page);
    await signIn(page, 'staff', ACC.anna);
    await expect.poll(async () => (await deviceRows<{ idle_timeout_minutes: number }>(page, 'session'))[0]?.idle_timeout_minutes).toBe(1);
    // With nobody touching the screen the device signs out after the minute (checked every 15 s).
    await expect(page).toHaveURL(/\/signin$/, { timeout: 100_000 });
  });

  // AUTH-08 · first-time setup (4 Oct 2026): someone else creates the account, the person is
  // emailed a code and a “Set up password” button, and sets the password they then sign in with.
  test('first-time setup: invited → code + password → “Go to sign in” → signed in', async ({ page }) => {
    const email = `${uniq('newbie')}@agroexpo.de`;
    await signIn(page, 'client-admin', ACC.admin);
    await nav(page, 'Team');
    await page.getByRole('button', { name: 'Invite person' }).click();
    const invite = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Invite person' }) });
    await expect(invite.getByText('Default', { exact: true })).toBeVisible();   // the dialog has finished filling itself in
    await invite.locator('#p-email').fill(email);
    await invite.locator('#p-name').fill('Nina Newbie');
    await invite.getByRole('button', { name: 'Send invite' }).click();

    // What the email carries: the admin sees the same code and link (there is no email in the demo).
    const sent = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Invitation sent' }) });
    await expect(sent.getByText(`Invitation emailed to ${email}`)).toBeVisible();
    const code = await invitationCode(sent);
    const link = await sent.getByRole('textbox', { name: 'Setup link' }).inputValue();
    expect(link).toBe(`${new URL(page.url()).origin}/signin#setup=${encodeURIComponent(email)}`);
    await sent.getByRole('button', { name: 'Done' }).click();
    await signOut(page);

    // The person opens the button in the email. No password yet, so only setup is offered.
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Set up your password' })).toBeVisible();
    await expect(page.getByText(`invitation email for ${email}`)).toBeVisible();
    await page.locator('#rs-code').fill('000000');
    await page.locator('#rs-pw').fill('NinaStarts#2026');
    await page.locator('#rs-pw2').fill('NinaStarts#2026');
    await page.getByRole('button', { name: 'Set up my password' }).click();
    await expect(alert(page)).toContainText(/code/i);

    await page.locator('#rs-code').fill(code);
    await page.locator('#rs-pw2').fill('NinaStarts#Typo');
    await expect(page.getByText('The two passwords are different.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Set up my password' })).toBeDisabled();
    await page.locator('#rs-pw2').fill('NinaStarts#2026');
    await page.getByRole('button', { name: 'Set up my password' }).click();

    await expect(page.getByRole('heading', { name: 'Your password is set' })).toBeVisible();
    await expect(page.getByText(`Sign in with ${email}`)).toBeVisible();
    expect(new URL(page.url()).hash, 'the address is out of the URL again').toBe('');
    await page.getByRole('button', { name: 'Go to sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await submitPassword(page, 'staff', email, 'NinaStarts#2026');
    await expect(page).toHaveURL(/\/scan$/, { timeout: 20_000 });
  });

  test('first-time setup: the code has one purpose — an invited person cannot sign in before it', async ({ page }) => {
    // Mia Braun is seeded as invited (no password yet), which is what a new account looks like.
    await submitPassword(page, 'staff', 'mia.hostess@gmail.com', PW);
    await expect(alert(page)).toContainText('You have not set a password yet.');

    // Lost the email? The same screen sends a new code.
    await page.goto('/signin#setup=mia.hostess%40gmail.com');
    await expect(page.getByRole('heading', { name: 'Set up your password' })).toBeVisible();
    await page.getByRole('button', { name: 'Email me a new code' }).click();
    const code = await demoCode(page);
    await page.locator('#rs-code').fill(code);
    await page.locator('#rs-pw').fill('MiaAtTheBooth#1');
    await page.locator('#rs-pw2').fill('MiaAtTheBooth#1');
    await page.getByRole('button', { name: 'Set up my password' }).click();
    await expect(page.getByRole('heading', { name: 'Your password is set' })).toBeVisible();
    await page.getByRole('button', { name: 'Go to sign in' }).click();
    await submitPassword(page, 'staff', 'mia.hostess@gmail.com', 'MiaAtTheBooth#1');
    await expect(page).toHaveURL(/\/scan$/, { timeout: 20_000 });
  });

  test('first-time setup: “I already have a password” goes straight to signing in', async ({ page }) => {
    await page.goto(`/signin#setup=${encodeURIComponent(ACC.anna)}`);
    await expect(page.getByRole('heading', { name: 'Set up your password' })).toBeVisible();
    await page.getByRole('button', { name: 'I already have a password — sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await submitPassword(page, 'staff', ACC.anna);
    await expect(page).toHaveURL(/\/scan$/, { timeout: 20_000 });
  });

  test('backend: verifying a code without the password step is refused', async ({ page }) => {
    await page.goto('/signin');
    const r = await backendCall(page, 'verifyLoginCode', [ACC.admin, '123456']);
    expect(r.ok).toBe(false);
    const t = await backendCall(page, 'verifyTotp', [ACC.super, '123456']);
    expect(t.ok).toBe(false);
  });
});

