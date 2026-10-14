import { describe, expect, it } from 'vitest';
import { parseCardText } from '../offlineReader';

/**
 * The parser turns the lines an OCR engine read into card fields. The samples below are real
 * Tesseract output shapes: labels, two numbers, honorifics, an address line, a missing website.
 */
describe('parseCardText', () => {
  it('German card: name without the honorific, company, title, contact details', () => {
    const r = parseCardText([
      'Saatgut GmbH',
      'Dr. Katharina Vogel',
      'Head of Export Sales',
      'katharina.vogel@nordsaat.de',
      '+49 391 55 04 128',
      'www.nordsaat.de',
      'Am Schwabeplan 8, 39164 Magdeburg, Germany',
    ].join('\n'));

    expect(r.first_name?.value).toBe('Katharina');
    expect(r.last_name?.value).toBe('Vogel');
    expect(r.company?.value).toBe('Saatgut GmbH');
    expect(r.job_title?.value).toBe('Head of Export Sales');
    expect(r.email?.value).toBe('katharina.vogel@nordsaat.de');
    expect(r.phone?.value).toBe('+49 391 55 04 128');
    expect(r.website?.value).toBe('https://www.nordsaat.de');
    expect(r.country?.value).toBe('Germany');
  });

  it('takes the mobile over the desk number, and says when there was a choice', () => {
    const r = parseCardText([
      'Harvest Analytics Ltd',
      'James Robinson',
      'Sales Director',
      'Tel +44 20 7946 0101',
      'Mobile +44 7700 900 461',
      'Fax +44 20 7946 0199',
      'james.robinson@harvestanalytics.co.uk',
    ].join('\n'));

    expect(r.phone?.value).toBe('+44 7700 900 461');
    expect(r.phone?.reason).toMatch(/more than one number/i);
    expect(r.phone?.value).not.toMatch(/0199/); // never the fax
    expect(r.company?.value).toBe('Harvest Analytics Ltd');
    expect(r.first_name?.value).toBe('James');
    expect(r.last_name?.value).toBe('Robinson');
  });

  it('falls back to the email address for the website and the name', () => {
    const r = parseCardText(['AGRISOL', 'camille.dubois@agrisol.fr', '+33 4 72 00 11 22'].join('\n'));

    expect(r.website?.value).toBe('https://agrisol.fr');
    expect(r.website?.reason).toMatch(/email/i);
    expect(r.first_name?.value).toBe('Camille');
    expect(r.last_name?.value).toBe('Dubois');
    expect(r.first_name?.confidence).toBeLessThan(0.6); // a guess, and it says so
  });

  it('ignores lines that are only labels, and keeps nothing it did not find', () => {
    const r = parseCardText(['E-Mail:', 'Tel:', 'Semi Verdi S.r.l.', 'Marco Bianchi'].join('\n'));

    expect(r.company?.value).toBe('Semi Verdi S.r.l.');
    expect(r.first_name?.value).toBe('Marco');
    expect(r.email).toBeUndefined();
    expect(r.phone).toBeUndefined();
  });

  it('every value carries a confidence and is marked as read on the device', () => {
    const r = parseCardText('Nordsaat GmbH\nLea Koch\nlea.koch@nordsaat.de');
    for (const v of Object.values(r)) {
      expect(v.by).toBe('offline');
      expect(v.confidence).toBeGreaterThan(0);
      expect(v.confidence).toBeLessThanOrEqual(1);
    }
  });
});
