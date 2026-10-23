/**
 * Integration test for the scanning pipeline, against a real PostgreSQL and the worker:
 * quality gate → crop → store → duplicate check → contact → lead score.
 *
 *   npm run dev      (one terminal)        npm run worker   (another)
 *   npm run smoke
 *
 * The cards are drawn here rather than loaded from a file, so the test carries no sample data
 * and the same run works on any machine.
 */
import sharp from 'sharp';

const API = process.env.API_URL ?? 'http://localhost:4000';
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(detail ?? null).slice(0, 300)}`}`);
  if (!ok) failures += 1;
};

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

/** A printed business card on a desk: the card is 70 % of the frame, like a real photo. */
async function cardPhoto({ blurred = false, dark = false, small = false } = {}) {
  const card = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1050" height="600">
    <rect width="1050" height="600" fill="#ffffff"/>
    <rect x="0" y="0" width="1050" height="14" fill="#047857"/>
    <text x="60" y="150" font-family="Helvetica" font-size="58" font-weight="bold" fill="#0f172a">Lena Fischer</text>
    <text x="60" y="210" font-family="Helvetica" font-size="34" fill="#475569">Head of Purchasing</text>
    <text x="60" y="300" font-family="Helvetica" font-size="40" font-weight="bold" fill="#047857">Fischer Landtechnik GmbH</text>
    <text x="60" y="380" font-family="Helvetica" font-size="30" fill="#0f172a">lena.fischer@fischer-landtechnik.de</text>
    <text x="60" y="430" font-family="Helvetica" font-size="30" fill="#0f172a">+49 171 2345678</text>
    <text x="60" y="480" font-family="Helvetica" font-size="30" fill="#0f172a">www.fischer-landtechnik.de</text>
    <text x="60" y="540" font-family="Helvetica" font-size="26" fill="#64748b">Hannover · Germany</text>
  </svg>`);
  let image = sharp({ create: { width: 1500, height: 1000, channels: 3, background: { r: 120, g: 125, b: 130 } } })
    .composite([{ input: small ? await sharp(card).resize(420).toBuffer() : card, top: small ? 380 : 200, left: small ? 540 : 230 }]);
  let buf = await image.jpeg({ quality: 92 }).toBuffer();
  if (blurred) buf = await sharp(buf).blur(9).jpeg({ quality: 92 }).toBuffer();
  if (dark) buf = await sharp(buf).modulate({ brightness: 0.12 }).jpeg({ quality: 92 }).toBuffer();
  return buf.toString('base64');
}

// ---------------------------------------------------------------- sign in
const signIn = await call('/v1/auth/password', {
  method: 'POST', body: { email: 'sam.staff@agroexpo.test', password: 'WetaSnap#2026', door: 'app', device: 'Pipeline · Node' },
});
const token = signIn.body.token;
check('signed in', signIn.body.next === 'done', signIn.body);
const events = await call('/v1/events', { token });
const eventId = events.body[0].id;

// ---------------------------------------------------------------- 2 · quality gate
const good = await call('/v1/scan/quality', { method: 'POST', token, body: { image: await cardPhoto() } });
check('a clear photo passes the quality check', good.body.verdict === 'good', good.body);

const blurred = await call('/v1/scan/quality', { method: 'POST', token, body: { image: await cardPhoto({ blurred: true }) } });
check('a blurred photo is refused, with a reason',
  blurred.body.verdict === 'poor' && /blurred/i.test(blurred.body.reasons?.[0] ?? ''), blurred.body);

const dark = await call('/v1/scan/quality', { method: 'POST', token, body: { image: await cardPhoto({ dark: true }) } });
check('a dark photo is refused', dark.body.verdict === 'poor' && /light/i.test(dark.body.reasons?.join(' ')), dark.body);

const far = await call('/v1/scan/quality', { method: 'POST', token, body: { image: await cardPhoto({ small: true }) } });
check('a card too small in the frame is refused', far.body.verdict === 'poor', far.body);

// ---------------------------------------------------------------- 3–7 · read
const read = await call('/v1/scan/read', {
  method: 'POST', token,
  body: {
    image: await cardPhoto(), event_id: eventId,
    on_device: {                      // what the phone read for itself before sending
      full_name: { value: 'lena  fischer', confidence: 0.6 },
      email: { value: 'lena.fischer @fischer-landtechnik.de', confidence: 0.55 },
      phone: { value: 'O49 171 2345678', confidence: 0.5 },
    },
  },
});
check('the read is answered with quality and fields', read.status === 201 && !!read.body.fields, read.body);
check('an image sent without a crop is not cut again', read.body.cropped === false, read.body.cropped);

const blurredRead = await call('/v1/scan/read', { method: 'POST', token, body: { image: await cardPhoto({ blurred: true }), event_id: eventId } });
check('a poor photo is refused before any reading', blurredRead.status === 422 && blurredRead.body.code === 'poor_quality', blurredRead.body);

// ---------------------------------------------------------------- 8–13 · lead → card → contact
const leadId = crypto.randomUUID();
await call('/v1/leads/sync', {
  method: 'POST', token,
  body: {
    id: leadId, event_id: eventId, source: 'camera', device: 'Pipeline · Node',
    fields: {
      full_name: { value: 'Lena Fischer', by: 'ai', confidence: 0.95 },
      job_title: { value: 'Head of Purchasing', by: 'ai', confidence: 0.9 },
      company: { value: 'Fischer Landtechnik GmbH', by: 'ai', confidence: 0.92 },
      email: { value: 'lena.fischer@fischer-landtechnik.de', by: 'ai', confidence: 0.96 },
      phone: { value: '+49 171 2345678', by: 'ai', confidence: 0.9 },
    },
    interest: 'hot', notes: 'Wants a quote for 12 units before the quarter ends.', consent: true,
    consent_at: new Date().toISOString(), status: 'synced',
  },
});

const photo = await call('/v1/scan/photo', {
  method: 'POST', token, body: { lead_id: leadId, side: 'front', image: await cardPhoto() },
});
check('the card image is stored', photo.status === 201 && photo.body.stored, photo.body);

const withCrop = await call('/v1/scan/photo', {
  method: 'POST', token,
  body: { lead_id: leadId, side: 'back', image: await cardPhoto(), crop: { x: 100, y: 100, w: 900, h: 600 } },
});
check('a crop sent by the app is accepted', withCrop.status === 201, withCrop.body);

// the worker links the contact; give it a moment
await new Promise((r) => setTimeout(r, 6000));

const contacts = await call('/v1/contacts?q=fischer', { token });
const contact = contacts.body?.[0];
check('a contact was made from the lead', !!contact && /Lena Fischer/i.test(contact.full_name), contacts.body);
check('the company domain was filled in from the email',
  contact?.org_domain === 'fischer-landtechnik.de', contact?.org_domain);

const leadsNow = await call('/v1/leads/search', { method: 'POST', token, body: {} });
const scored = leadsNow.body.find((l) => l.id === leadId);
check('the lead was scored', (scored?.lead_score ?? 0) >= 60, scored?.lead_score);

// a second card for the same person at another stand must merge, not duplicate
const secondLead = crypto.randomUUID();
await call('/v1/leads/sync', {
  method: 'POST', token,
  body: {
    id: secondLead, event_id: eventId, source: 'camera',
    fields: {
      full_name: { value: 'L. Fischer', by: 'ai', confidence: 0.8 },
      company: { value: 'Fischer Landtechnik GmbH', by: 'ai', confidence: 0.9 },
      email: { value: 'lena.fischer@fischer-landtechnik.de', by: 'ai', confidence: 0.95 },
      mobile: { value: '+49 171 9999999', by: 'ai', confidence: 0.8 },
    },
    interest: 'warm', status: 'synced',
  },
});
await new Promise((r) => setTimeout(r, 6000));
const after = await call('/v1/contacts?q=fischer', { token });
const sameOne = after.body.filter((c) => /fischer/i.test(c.full_name));
check('the same person met twice stays one contact', sameOne.length === 1 && sameOne[0].times_met >= 2,
  sameOne.map((c) => ({ name: c.full_name, met: c.times_met })));

const detail = contact ? await call(`/v1/contacts/${sameOne[0]?.id ?? contact.id}`, { token }) : null;
check('the contact shows both leads and its timeline',
  (detail?.body?.leads?.length ?? 0) >= 2 && (detail?.body?.activities?.length ?? 0) > 0,
  { leads: detail?.body?.leads?.length, activities: detail?.body?.activities?.length });

// the stored image is served back, and only to someone who may see the lead
const file = await fetch(`${API}/v1/files/card/${leadId}/front`, { headers: { authorization: `Bearer ${token}` } });
check('the card image comes back through the API', file.ok && file.headers.get('content-type') === 'image/jpeg', file.status);
const nobody = await fetch(`${API}/v1/files/card/${leadId}/front`);
check('without a session it does not', nobody.status === 401, nobody.status);

console.log(`\n${failures ? `  ${failures} check(s) failed` : '  all pipeline checks passed'}\n`);
process.exit(failures ? 1 : 0);
