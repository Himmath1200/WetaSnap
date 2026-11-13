import { describe, expect, it, beforeEach } from 'vitest';
import { createDemoBackend } from '../backend/demo';

describe('Individual registration and quota management', () => {
  let b: ReturnType<typeof createDemoBackend>;

  beforeEach(() => {
    b = createDemoBackend();
  });

  it('allows direct individual registration and returns signed-in session', async () => {
    const res = await b.registerIndividual({
      name: 'Test Solo User',
      email: 'solo.test@example.com',
      phone: '+1 555 123 4567',
      password: 'password123',
    });

    expect(res.person).toBeDefined();
    expect(res.person.role).toBe('individual');
    expect(res.person.plan).toBe('free');
    expect(res.person.monthly_scans).toBe(0);
    expect(res.person.email).toBe('solo.test@example.com');
    expect(res.company).toBeNull();
  });

  it('rejects duplicate email during registration', async () => {
    await b.registerIndividual({
      name: 'First User',
      email: 'dup@example.com',
      phone: '+1 555 999 0001',
      password: 'password123',
    });

    await expect(
      b.registerIndividual({
        name: 'Second User',
        email: 'dup@example.com',
        phone: '+1 555 999 0002',
        password: 'password123',
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it('tracks scan quota up to 5 scans for free individuals', async () => {
    const user = await b.registerIndividual({
      name: 'Quota Tester',
      email: 'quota@example.com',
      phone: '+1 555 888 0003',
      password: 'password123',
    });
    b.setToken(user.token);

    // 1st scan
    let usage = await b.recordScanUsage();
    expect(usage.allowed).toBe(true);
    expect(usage.count).toBe(1);

    // 2nd to 5th scan
    await b.recordScanUsage();
    await b.recordScanUsage();
    await b.recordScanUsage();
    usage = await b.recordScanUsage();
    expect(usage.allowed).toBe(true);
    expect(usage.count).toBe(5);

    // 6th scan should be blocked
    usage = await b.recordScanUsage();
    expect(usage.allowed).toBe(false);
  });

  it('allows unlimited scans after upgrading to Pro', async () => {
    const user = await b.registerIndividual({
      name: 'Pro Tester',
      email: 'pro@example.com',
      phone: '+1 555 777 0004',
      password: 'password123',
    });
    b.setToken(user.token);

    // Max out free scans
    for (let i = 0; i < 5; i++) {
      await b.recordScanUsage();
    }
    let usage = await b.recordScanUsage();
    expect(usage.allowed).toBe(false);

    // Upgrade to Pro
    await b.upgradeMyPlan('pro', 'monthly');

    // Now scans are allowed
    usage = await b.recordScanUsage();
    expect(usage.allowed).toBe(true);
    expect(usage.plan).toBe('pro');
  });

  it('allows super admin to list and manage individuals', async () => {
    // Sign in as super admin
    const PW = 'WetaSnap#2026';
    let r = await b.signInWithPassword('super@wetano.com', PW, 'console');
    if (r.next === 'email_code') r = await b.verifyLoginCode('super@wetano.com', r.demoCode!);
    if (r.next === 'totp') { const s = await b.verifyTotp('super@wetano.com', '123456'); b.setToken(s.token); }
    else if (r.next === 'done') { b.setToken(r.token); }

    const individuals = await b.listIndividuals();
    expect(individuals.length).toBeGreaterThanOrEqual(1);

    const first = individuals[0]!;
    await b.updateIndividualPlan(first.id, 'pro');
    await b.resetIndividualScans(first.id);

    const refreshed = await b.listIndividuals();
    const updated = refreshed.find((i) => i.id === first.id);
    expect(updated?.plan).toBe('pro');
    expect(updated?.monthly_scans).toBe(0);
  });

  it('allows super admin to create an organizer and participants to register with referral code', async () => {
    const PW = 'WetaSnap#2026';
    let r = await b.signInWithPassword('super@wetano.com', PW, 'console');
    if (r.next === 'email_code') r = await b.verifyLoginCode('super@wetano.com', r.demoCode!);
    if (r.next === 'totp') { const s = await b.verifyTotp('super@wetano.com', '123456'); b.setToken(s.token); }
    else if (r.next === 'done') { b.setToken(r.token); }

    const created = await b.createOrganizer({
      event_name: 'Summer Expo 2026',
      starts_on: '2026-11-15',
      ends_on: '2026-11-20',
      venue: 'Main Hall',
      organizer_name: 'John Organizer',
      organizer_email: 'john.org@example.com',
      max_logins: 2,
    });

    expect(created.organizer.role).toBe('organizer');
    expect(created.referral_code).toMatch(/^ORG-/);

    // Register 1st participant
    const p1 = await b.registerReferral({
      name: 'Participant 1',
      email: 'part1@example.com',
      phone: '+1 555 666 0005',
      password: 'password123',
      referral_code: created.referral_code,
    });
    expect(p1.person.role).toBe('staff');
    expect(p1.person.event_ends_on).toBe('2026-11-20');

    // Register 2nd participant
    await b.registerReferral({
      name: 'Participant 2',
      email: 'part2@example.com',
      phone: '+1 555 666 0006',
      password: 'password123',
      referral_code: created.referral_code,
    });

    // 3rd participant exceeds max_logins = 2
    await expect(
      b.registerReferral({
        name: 'Participant 3',
        email: 'part3@example.com',
        phone: '+1 555 666 0007',
        password: 'password123',
        referral_code: created.referral_code,
      }),
    ).rejects.toThrow(/maximum allowed participant logins limit/i);
  });
});
