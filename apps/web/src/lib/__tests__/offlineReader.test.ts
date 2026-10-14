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

  it('Ageas card: merged columns split, mobile wins, India from the dialling code', () => {
    const r = parseCardText([
      'g LIFE INSURANCE',
      'Jayakumar P',
      'Chief AL Manager C',
      'jayakumar.p@ageasfederal.com   Ageas Federal Life Insurance Co. Ltd.',
      'T;: +91 8424015630   1st floor, No.21 Patullos Road',
      'M: +91 6383338084   Chennal 600002',
    ].join('\n'));

    expect(r.email?.value).toBe('jayakumar.p@ageasfederal.com');
    expect(r.phone?.value).toBe('M: +91 6383338084'.match(/(\+?\d[\d\s()./-]{7,}\d)/)![1]);
    expect(r.company?.value).toBe('Ageas Federal Life Insurance Co. Ltd.');
    expect(r.first_name?.value).toBe('Jayakumar');
    expect(r.last_name?.value).toBe('P');
    expect(r.country?.value).toBe('India');
    expect(r.job_title?.value).toBe('Chief AL Manager');
  });

  it('repairs Tesseract digit slips (B for 8) without inventing digits', () => {
    const r = parseCardText([
      'Jayakumar P',
      'T: +91 B424015630   1st floor, No.21 Patullos Road',
      'M: +91 6383338084   Chennal 600002',
      'jayakumar.p@ageasfederal.com   Ageas Federal Life Insurance Co. Ltd.',
    ].join('\n'));

    expect(r.phone?.value).toBe('+91 6383338084');
  });

  it('reads "A:" as the mobile label and skips a visibly incomplete mobile', () => {
    const r = parseCardText([
      'Jayakumar P',
      '; +9) 8424015630   1st floor, No.21 Patullos Road',
      'A: +91 63831 8084   Chennal 600002',
      'ayak mar.p@ageasfederal.com   Ageas Federal Life Insurance Co. Ltd.',
    ].join('\n'));

    // The short mobile lost digits; the intact desk number is stored instead, flagged.
    expect(r.phone?.value.replace(/\D/g, '')).toBe('918424015630');
    expect(r.phone?.reason).toBeTruthy();
    expect(r.email?.confidence).toBeLessThan(0.8);
    expect(r.email?.reason).toBeTruthy();
  });

  it('glues a fragmented email and flags it as uncertain', () => {
    const r = parseCardText([
      'ayakumar P',
      'ay 2 kumar.p@ageasfederal.com   Ageas Federal Life Insurance Co. Ltd.',
      'T: +91 8424015630',
    ].join('\n'));

    expect(r.email?.value).toBe('ay2kumar.p@ageasfederal.com');
    expect(r.email?.confidence).toBeLessThan(0.8);
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
