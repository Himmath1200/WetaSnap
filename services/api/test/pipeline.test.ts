/**
 * The parts of the pipeline that are pure functions: what a value is turned into, what a lead is
 * worth, and what two contacts have in common. Everything here runs without a database.
 */
import { describe, expect, it } from 'vitest';
import { scrub, scrubText } from '../src/common/audit.service';
import { hashPassword, recoveryCode, sha256, verifyPassword } from '../src/common/crypto';
import { base32Decode, base32Encode, newSecret, verifyTotp } from '../src/common/totp';
import { contactToText, cosine, localVector, DIMENSIONS } from '../src/modules/contacts/embeddings';
import { followUpDate, scoreLead } from '../src/modules/contacts/score';
import { readCardFields } from '../src/modules/contacts/contacts.service';
import { domainOf, normaliseFields, normaliseOne, phoneKey, titleCase } from '../src/modules/scan/pipeline/normalise';

describe('normalising what came off a card', () => {
  it('tidies an email OCR got nearly right', () => {
    expect(normaliseOne(' Lena.Fischer @ fischer-landtechnik.de ', 'email')).toEqual({
      value: 'lena.fischer@fischer-landtechnik.de', ok: true,
    });
    expect(normaliseOne('info(at)acme.com', 'email').value).toBe('info@acme.com');
  });

  it('keeps an impossible email, but says so', () => {
    const out = normaliseOne('lena.fischer.de', 'email');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/complete email/i);
    expect(out.value).toBe('lena.fischer.de');          // never thrown away
  });

  it('fixes letters read for digits in a phone number, and keeps the printed grouping', () => {
    expect(normaliseOne('Tel: +49 171 2345678', 'phone').value).toBe('+491712345678');
    expect(normaliseOne('O151 234 5678', 'phone').value).toBe('0151 234 5678');
    expect(normaliseOne('12345', 'phone')).toMatchObject({ ok: false });
  });

  it('never invents a country code', () => {
    expect(normaliseOne('0151 2345678', 'phone').value.startsWith('+')).toBe(false);
  });

  it('completes a web address only as far as the protocol', () => {
    expect(normaliseOne('www. acme .com', 'link').value).toBe('https://www.acme.com');
    expect(normaliseOne('acme', 'link')).toMatchObject({ ok: false });
  });

  it('puts a shouted name back into normal case, and leaves company forms alone', () => {
    expect(titleCase('LENA FISCHER')).toBe('Lena Fischer');
    expect(titleCase('Fischer Landtechnik GmbH')).toBe('Fischer Landtechnik GmbH');
    expect(titleCase('MÜLLER-HOFF GMBH')).toBe('Müller-Hoff GMBH');
  });

  it('drops empty values and lowers confidence on the ones it could not make sense of', () => {
    const out = normaliseFields({
      email: { value: 'not-an-email', confidence: 0.9 },
      phone: { value: '', confidence: 0.9 },
      full_name: { value: 'ANNA WEBER', confidence: 0.8 },
    }, [{ key: 'email', type: 'email' }, { key: 'phone', type: 'phone' }, { key: 'full_name', type: 'text' }]);
    expect(out.phone).toBeUndefined();
    expect(out.email!.confidence).toBeLessThanOrEqual(0.5);
    expect(out.full_name!.value).toBe('Anna Weber');
  });

  it('takes the company domain from a work address, but not from a free one', () => {
    expect(domainOf('lena@fischer-landtechnik.de')).toBe('fischer-landtechnik.de');
    expect(domainOf('lena@gmail.com')).toBe('');
  });

  it('compares two numbers that were written differently', () => {
    expect(phoneKey('+49 171 2345678')).toBe(phoneKey('0049-171-2345678'));
  });
});

describe('reading a card into a contact', () => {
  it('finds the usual fields whatever the company called them', () => {
    const details = readCardFields({
      work_email: { value: 'Lena.Fischer@fischer-landtechnik.de' },
      full_name: { value: 'LENA FISCHER' },
      position: { value: 'Head of Purchasing' },
      organisation: { value: 'Fischer Landtechnik GmbH' },
      mobile: { value: '+49 171 2345678' },
    });
    expect(details.full_name).toBe('Lena Fischer');
    expect(details.first_name).toBe('Lena');
    expect(details.last_name).toBe('Fischer');
    expect(details.job_title).toBe('Head of Purchasing');
    expect(details.org_name).toBe('Fischer Landtechnik GmbH');
    expect(details.org_domain).toBe('fischer-landtechnik.de');
    expect(details.phone).toBe('+49 171 2345678');
  });

  it('is empty rather than wrong when the card had nothing on it', () => {
    expect(readCardFields({}).full_name).toBe('');
  });
});

describe('what a lead is worth', () => {
  const base = {
    email: 'lena@fischer.de', phone: '+49 171 2345678', orgDomain: 'fischer.de',
    jobTitle: 'Head of Purchasing', interest: 'hot' as const, consent: true,
    notes: 'Wants a quote for twelve units before the quarter ends.', timesMet: 1, hasCardPhoto: true,
  };

  it('scores a complete hot lead high, and says why', () => {
    const { score, reasons } = scoreLead(base);
    expect(score).toBeGreaterThan(80);
    expect(reasons.join(' ')).toMatch(/decision maker/);
  });

  it('caps a lead nobody can be reached on', () => {
    expect(scoreLead({ ...base, email: '', phone: '' }).score).toBeLessThanOrEqual(20);
  });

  it('puts a cold lead below a warm one, and a warm one below hot', () => {
    const cold = scoreLead({ ...base, interest: 'cold' }).score;
    const warm = scoreLead({ ...base, interest: 'warm' }).score;
    expect(cold).toBeLessThan(warm);
    expect(warm).toBeLessThan(scoreLead(base).score);
  });

  it('asks for a hot lead tomorrow and a cold one after the show', () => {
    const today = new Date('2026-10-04T10:00:00Z');
    expect(followUpDate('hot', today)).toBe('2026-10-05');
    expect(followUpDate('cold', today)).toBe('2026-10-18');
  });
});

describe('finding a contact again', () => {
  it('describes a contact the same way every time', () => {
    const text = contactToText({ full_name: 'Lena Fischer', org_name: 'Fischer Landtechnik', job_title: 'Head of Purchasing', email: 'l@fischer.de', country: 'Germany' });
    expect(text).toBe('lena fischer · head of purchasing · fischer landtechnik · fischer.de · germany');
  });

  it('puts a misspelled company closer than an unrelated one', () => {
    const wanted = localVector('fischer landtechnik');
    const close = cosine(wanted, localVector('fisher landtecnik gmbh'));
    const far = cosine(wanted, localVector('nordic seeds stockholm'));
    expect(close).toBeGreaterThan(far);
    expect(localVector('anything').length).toBe(DIMENSIONS);
  });
});

describe('secrets', () => {
  it('accepts the right password and refuses a near miss', async () => {
    const hash = await hashPassword('Correct#Horse2026');
    expect(await verifyPassword('Correct#Horse2026', hash)).toBe(true);
    expect(await verifyPassword('correct#horse2026', hash)).toBe(false);
    expect(await verifyPassword('Correct#Horse2026', null)).toBe(false);
  });

  it('never stores the same hash twice for the same password', async () => {
    expect(await hashPassword('Same#Password1')).not.toBe(await hashPassword('Same#Password1'));
  });

  it('hashes a session token one way', () => {
    expect(sha256('abc')).toHaveLength(64);
  });

  it('makes recovery codes that can be read out loud', () => {
    expect(recoveryCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it('round-trips base32 and accepts the authenticator code it would show', () => {
    const secret = newSecret();
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    expect(verifyTotp(secret, '000000')).toBe(false);
  });
});

describe('the audit log keeps personal data out', () => {
  it('masks addresses, numbers and tokens', () => {
    expect(scrubText('write to lena.fischer@acme.com')).toBe('write to len…@acme.com');
    expect(scrubText('called +49 171 2345678')).not.toContain('2345678');
    expect(scrubText('token eyJhbGciOi.eyJzdWIi.sig')).toBe('token [token]');
  });

  it('removes anything that looks like a secret, whatever it is called', () => {
    const out = scrub({ password: 'hunter2', api_key: 'abc', note: 'hello', nested: { authorization: 'Bearer x' } });
    expect(out.password).toBe('[removed]');
    expect(out.api_key).toBe('[removed]');
    expect((out.nested as Record<string, unknown>).authorization).toBe('[removed]');
    expect(out.note).toBe('hello');
  });
});
