import { describe, expect, it } from 'vitest';
import { domainBaseOf, domainScoreOf, isFreeMailDomain, isNameShaped, isPersonLine, parseCardText, repairCompanySpelling } from '../offlineReader';

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

  it('never guesses the website from a public mailbox', () => {
    for (const domain of [
      'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'ymail.com',
      'outlook.com', 'hotmail.com', 'hotmail.de', 'live.com', 'msn.com',
      'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me',
      'tutanota.com', 'gmx.de', 'web.de', 't-online.de', 'orange.fr', 'free.fr',
      'libero.it', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', 'naver.com',
      'rediffmail.com', 'uol.com.br', 'sapo.pt', 'zoho.com', 'mail.com',
      'bigpond.com', 'seznam.cz', 'wp.pl', 'walla.co.il',
    ]) {
      const r = parseCardText(['Priya Nair', `priya.nair@${domain}`, '+91 98400 12345'].join('\n'));
      expect(r.email?.value).toBe(`priya.nair@${domain}`);
      expect(r.website, `no website from ${domain}`).toBeUndefined();
      // And the name line is not stolen as the company either.
      expect(r.company, `no company from ${domain}`).toBeUndefined();
      // The name still resolves by shape plus a whisper of local-part tiebreak.
      expect(r.first_name?.value).toBe('Priya');
      expect(r.last_name?.value).toBe('Nair');
    }
  });

  it('a public mailbox abstains on the company either way round', () => {
    // Name-first and company-first: with gmail there is no signal, so the company
    // stays blank in both orders instead of flipping a coin — the name still resolves.
    for (const cardLines of [
      ['Priya Nair', 'Enrich Spaces', 'priya.nair@gmail.com', '+91 98400 12345'],
      ['Enrich Spaces', 'Priya Nair', 'priya.nair@gmail.com', '+91 98400 12345'],
    ]) {
      const r = parseCardText(cardLines.join('\n'));
      expect(r.company, `no company guess for ${cardLines[0]}`).toBeUndefined();
      expect(r.first_name?.value).toBe('Priya');
      expect(r.last_name?.value).toBe('Nair');
    }
  });

  it('isFreeMailDomain matches case-insensitively and ignores trailing dots', () => {
    expect(isFreeMailDomain('GMail.COM')).toBe(true);
    expect(isFreeMailDomain('gmail.com.')).toBe(true);
    expect(isFreeMailDomain('nordsaat.de')).toBe(false);
    expect(isFreeMailDomain('mygmail.com')).toBe(false); // a company domain, not Google's
    expect(isFreeMailDomain('')).toBe(false);
  });

  it('resolves the company behind an email domain', () => {
    expect(domainBaseOf('enrichspaces.co.in')).toBe('enrichspaces');
    expect(domainBaseOf('nordsaat.de')).toBe('nordsaat');
    expect(domainBaseOf('harvestanalytics.co.uk')).toBe('harvestanalytics');
    expect(domainBaseOf('mail.company.com')).toBe('company');
    expect(domainBaseOf('gmail.com')).toBe('gmail');
    expect(domainBaseOf('invalid')).toBe('');
    expect(domainScoreOf('Enrich Spaces', 'enrichspaces')).toBe(1);
    expect(domainScoreOf('NORDSAAT Saatgut GmbH', 'nordsaat')).toBeGreaterThanOrEqual(0.8);
    expect(domainScoreOf('Ennich Spaces', 'enrichspaces')).toBeGreaterThanOrEqual(0.55); // one OCR slip
    expect(domainScoreOf('Priya Nair', 'enrichspaces')).toBe(0);
    expect(isPersonLine('Priya Nair', 'priya.nair')).toBe(true);
    expect(isPersonLine('Priya Nair', 'info')).toBe(false);
    expect(isPersonLine('Enrich Spaces', 'info')).toBe(false); // no signal either way
    expect(isPersonLine('Enrich Spaces', '')).toBe(false);
    expect(isNameShaped('Priya Nair')).toBe(true);
    expect(isNameShaped('Enrich Spaces')).toBe(true);
    expect(isNameShaped('ENRICH')).toBe(false);
    expect(isNameShaped('Chennai 600118')).toBe(false);
  });

  it('cross-checks name and company against the email domain', () => {
    // No legal suffix anywhere: the domain decides which line is the company…
    const r = parseCardText([
      'Enrich Spaces',
      'Preeti Balaraman',
      'preeti@enrichspaces.co.in',
      '+91 99406 42190',
    ].join('\n'));

    expect(r.company?.value).toBe('Enrich Spaces');
    expect(r.company?.confidence).toBeGreaterThanOrEqual(0.7);
    expect(r.company?.reason).toMatch(/email/i);
    expect(r.first_name?.value).toBe('Preeti');
    expect(r.last_name?.value).toBe('Balaraman');
  });

  it('prefers the domain line even when the name comes first', () => {
    const r = parseCardText([
      'Preeti Balaraman',
      'Enrich Spaces',
      'preeti@enrichspaces.co.in',
      '+91 99406 42190',
    ].join('\n'));

    expect(r.company?.value).toBe('Enrich Spaces');
    expect(r.first_name?.value).toBe('Preeti');
    expect(r.last_name?.value).toBe('Balaraman');
  });

  it('a printed website outranks the email domain', () => {
    const r = parseCardText([
      'Enrich Spaces',
      'Preeti Balaraman',
      'preeti@enrichspaces.co.in',
      'www.enrichspaces.co.in',
      '+91 99406 42190',
    ].join('\n'));

    expect(r.website?.value).toBe('https://www.enrichspaces.co.in');
    expect(r.company?.value).toBe('Enrich Spaces');
    expect(r.company?.confidence).toBe(0.8);
    expect(r.company?.reason).toMatch(/website/i);
    expect(r.first_name?.value).toBe('Preeti');
    expect(r.last_name?.value).toBe('Balaraman');
  });

  it('the website decides even with a public mailbox', () => {
    const r = parseCardText([
      'Enrich Spaces',
      'Preeti Balaraman',
      'preeti.balaraman@gmail.com',
      'www.enrichspaces.co.in',
      '+91 99406 42190',
    ].join('\n'));

    expect(r.website?.value).toBe('https://www.enrichspaces.co.in');
    expect(r.company?.value).toBe('Enrich Spaces');
    expect(r.company?.confidence).toBe(0.8);
    expect(r.first_name?.value).toBe('Preeti');
    expect(r.last_name?.value).toBe('Balaraman');
  });

  it('still matches the company with one OCR slip in its name', () => {
    const r = parseCardText([
      'Ennich Spaces',
      'Preeti Balaraman',
      'preeti@enrichspaces.co.in',
      '+91 99406 42190',
    ].join('\n'));

    expect(r.company?.value).toBe('Ennich Spaces');
    expect(r.company?.reason).toMatch(/email/i);
    expect(r.first_name?.value).toBe('Preeti');
    expect(r.last_name?.value).toBe('Balaraman');
  });

  it('repairs the company spelling from the website, keeping word breaks', () => {
    expect(repairCompanySpelling('Ennich Spaces', 'enrichspaces')).toBe('Enrich Spaces');
    expect(repairCompanySpelling('ENNICH SPACES', 'enrichspaces')).toBe('ENRICH SPACES');
    expect(repairCompanySpelling('Enrich Spaces', 'enrichspaces')).toBe('Enrich Spaces');
    expect(repairCompanySpelling('Priya Nair', 'enrichspaces')).toBe('Priya Nair');
    expect(repairCompanySpelling('Enrich Spaces', '')).toBe('Enrich Spaces');
  });

  it('fixes a misread logo from the printed website', () => {
    const r = parseCardText([
      'Ennich Spaces',
      'Preeti Balaraman',
      'preeti@enrichspaces.co.in',
      'www.enrichspaces.co.in',
      '+91 99406 42190',
    ].join('\n'));

    expect(r.company?.value).toBe('Enrich Spaces');
    expect(r.company?.confidence).toBe(0.75);
    expect(r.company?.reason).toMatch(/website/i);
    expect(r.first_name?.value).toBe('Preeti');
    expect(r.last_name?.value).toBe('Balaraman');
  });

  it('never stores the person as the company', () => {
    // A card with nothing but a name and a public mailbox: no company to find.
    const r = parseCardText(['Priya Nair', 'priya.nair@gmail.com', '+91 98400 12345'].join('\n'));

    expect(r.company).toBeUndefined();
    expect(r.first_name?.value).toBe('Priya');
    expect(r.last_name?.value).toBe('Nair');
  });

  it('reads names with initials, and single letters do not become the company', () => {
    const r = parseCardText([
      'VR Foods',
      'V Rakesh Reddy',
      'Purchase Manager',
      'v.rakesh@vrfoods.in',
      '+91 98400 12345',
    ].join('\n'));

    expect(r.company?.value).toBe('VR Foods');
    expect(r.first_name?.value).toBe('V Rakesh');
    expect(r.last_name?.value).toBe('Reddy');
    expect(r.job_title?.value).toBe('Purchase Manager');
  });

  it('reads dotted initials in the middle of a name', () => {
    const r = parseCardText([
      'Christian R.S. Arokiaswamy',
      'christian@arokia.in',
      '+91 98400 12346',
    ].join('\n'));

    expect(r.first_name?.value).toBe('Christian R.S.');
    expect(r.last_name?.value).toBe('Arokiaswamy');
  });

  it('keeps every distinct number: comma-joined and two places', () => {
    const r = parseCardText([
      'Priya Nair',
      'M: +91 98400 12345, +91 98410 54321',
      'T: +91 44 2812 3456',
      'priya@enrichspaces.co.in',
    ].join('\n'));

    expect(r.phone?.value).toBe('+91 98400 12345');
    expect(r.phone2?.value).toBe('+91 98410 54321');
    expect(r.phone3?.value).toBe('+91 44 2812 3456');
  });

  it('defaults a bare 10-digit mobile to India only with Indian context', () => {
    const withContext = parseCardText([
      'Priya Nair',
      'M: +91 98400 12345',
      'T: 98410 54321',
      'priya@enrichspaces.co.in',
    ].join('\n'));
    expect(withContext.phone2?.value).toBe('+91 9841054321');

    const printed = parseCardText([
      'Priya Nair',
      '98410 54321',
      'Chennai, India',
    ].join('\n'));
    expect(printed.phone?.value).toBe('+91 9841054321');

    // A German card keeps its bare number untouched.
    const german = parseCardText([
      'Lea Koch',
      'Tel 0151 2345678',
      'lea.koch@nordsaat.de',
    ].join('\n'));
    expect(german.phone?.value).toBe('0151 2345678');
  });

  it('reads the street address with a 6-digit pincode', () => {
    const r = parseCardText([
      'Enrich Spaces',
      'Preeti Balaraman',
      'First Door, 3/4, East Coast Rd.',
      'Neelankarai, Chennai 600118',
      'preeti@enrichspaces.co.in',
      '+91 99406 42190',
    ].join('\n'));

    expect(r.address?.value).toBe('First Door, 3/4, East Coast Rd., Neelankarai, Chennai 600118');
    expect(r.address?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(r.company?.value).toBe('Enrich Spaces');
    expect(r.first_name?.value).toBe('Preeti');
  });

  it('reads a street address without a pincode, flagged for checking', () => {
    const r = parseCardText([
      'Nordsaat GmbH',
      'Am Schwabeplan 8, 39164 Magdeburg, Germany',
    ].join('\n'));

    expect(r.address?.value).toBe('Am Schwabeplan 8, 39164 Magdeburg, Germany');
    expect(r.address?.reason).toMatch(/postcode/i);
  });

  it('recognises founder, proprietor and lead titles as roles', () => {
    const founder = parseCardText([
      'FieldFirst UK',
      'Amelia Hughes',
      'Founder & CEO',
      'amelia@fieldfirst.co.uk',
    ].join('\n'));
    expect(founder.job_title?.value).toBe('Founder & CEO');
    expect(founder.first_name?.value).toBe('Amelia');

    const dealer = parseCardText([
      'Cauvery Fertilisers',
      'Mohan Gowda',
      'Proprietor',
      'mohan@cauvery.in',
    ].join('\n'));
    expect(dealer.job_title?.value).toBe('Proprietor');
    expect(dealer.company?.value).toBe('Cauvery Fertilisers');

    const lead = parseCardText([
      'Greenline Agritech',
      'James Carter',
      'Product Lead',
      'james@greenline.co.uk',
    ].join('\n'));
    expect(lead.job_title?.value).toBe('Product Lead');
    expect(lead.first_name?.value).toBe('James');
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
