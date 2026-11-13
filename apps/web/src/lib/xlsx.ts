/**
 * Excel import and export. ExcelJS is imported lazily, so it is downloaded only when an admin
 * actually exports or imports — it never lands in the first-open budget (§8.1).
 */
import type { FieldDefinition, Lead, LeadFilters, Tag } from './types';
import { STATUS_META, safeCell } from './leads';

const HEADER_FILL = 'FF047857'; // brand green
const BAND_FILL = 'FFF1F8F5';

export interface ExportContext {
  fields: FieldDefinition[];
  tags: Tag[];
  eventName: (id: string) => string;
  filters: LeadFilters;
  filterSummary: string[];
  companyName: string;
  photoLink: (l: Lead) => string;
}

/** Styled workbook: green header, frozen row, a filter arrow on every column, banded rows. */
export async function leadsToXlsx(leads: Lead[], ctx: ExportContext): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WeTa Snap';
  wb.created = new Date();

  const ws = wb.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
  const cols = [
    ...ctx.fields.map((f) => ({ header: f.label, key: f.key, width: widthFor(f) })),
    { header: 'Tags', key: '_tags', width: 22 },
    { header: 'Interest', key: '_interest', width: 10 },
    { header: 'Notes', key: '_notes', width: 40 },
    { header: 'Consent', key: '_consent', width: 9 },
    { header: 'Captured by', key: '_by', width: 18 },
    { header: 'Event', key: '_event', width: 24 },
    { header: 'Source', key: '_source', width: 10 },
    { header: 'CRM status', key: '_status', width: 12 },
    { header: 'Captured at', key: '_at', width: 18 },
    { header: 'Card photo', key: '_photo', width: 16 },
  ];
  ws.columns = cols;

  const tagName = (id: string) => ctx.tags.find((t) => t.id === id)?.name ?? id;
  leads.forEach((l) => {
    const row: Record<string, string | number | Date | null> = {};
    for (const f of ctx.fields) row[f.key] = safeCell(l.fields[f.key]?.value ?? '');
    row._tags = (l.tag_ids ?? []).map(tagName).join(', ');
    row._interest = l.interest ? l.interest[0]!.toUpperCase() + l.interest.slice(1) : '';
    row._notes = safeCell(l.notes);
    row._consent = l.consent ? 'Yes' : 'No';
    row._by = l.captured_by_name;
    row._event = ctx.eventName(l.event_id);
    row._source = l.source;
    row._status = STATUS_META[l.status].label;
    row._at = new Date(l.created_at);
    row._photo = l.has_photo ? ctx.photoLink(l) : '';
    const r = ws.addRow(row);
    r.getCell('_at').numFmt = 'dd/mm/yyyy hh:mm';
    // Phone-like columns stay text so Excel does not eat the leading +.
    for (const f of ctx.fields) if (f.type === 'phone') r.getCell(f.key).alignment = { horizontal: 'left' };
    if (l.has_photo) {
      const c = r.getCell('_photo');
      c.value = { text: 'Open photo', hyperlink: ctx.photoLink(l) };
      c.font = { color: { argb: 'FF1D4ED8' }, underline: true };
    }
    if (r.number % 2 === 1) r.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } }; });
  });

  const header = ws.getRow(1);
  header.height = 22;
  header.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    c.alignment = { vertical: 'middle', horizontal: 'left' };
    c.border = { bottom: { style: 'thin', color: { argb: 'FF065F46' } } };
  });
  // A filter arrow on every column (ADM-06).
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, leads.length + 1), column: cols.length } };
  ws.eachRow((r) => r.eachCell((c) => { c.alignment = { ...c.alignment, wrapText: false }; }));

  // Second sheet: what produced this file.
  const info = wb.addWorksheet('Filters');
  info.columns = [{ header: 'Item', key: 'k', width: 22 }, { header: 'Value', key: 'v', width: 60 }];
  info.getRow(1).font = { bold: true };
  info.addRows([
    { k: 'Company', v: ctx.companyName },
    { k: 'Exported', v: new Date().toLocaleString() },
    { k: 'Leads', v: String(leads.length) },
    ...ctx.filterSummary.map((f) => ({ k: 'Filter', v: f })),
    { k: 'Photo links', v: 'Valid for 7 days' },
  ]);

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** An empty workbook with this company's columns — the file to fill in and import. */
export async function importTemplateXlsx(fields: FieldDefinition[]): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Leads');
  ws.columns = fields.map((f) => ({ header: f.label + (f.required ? ' *' : ''), key: f.key, width: widthFor(f) }));
  ws.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  });
  ws.addRow(Object.fromEntries(fields.map((f) => [f.key, exampleFor(f)])));
  ws.getRow(2).font = { italic: true, color: { argb: 'FF94A3B8' } };
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export interface Sheet { headers: string[]; rows: string[][] }

/** Reads .xlsx / .xls / .csv into plain rows for the column-mapping step. */
export async function readSpreadsheet(file: File): Promise<Sheet> {
  if (/\.csv$|\.txt$/i.test(file.name) || file.type.includes('csv')) return parseCsv(await file.text());
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('That file has no sheets.');
  const rows: string[][] = [];
  ws.eachRow((r) => rows.push((r.values as unknown[]).slice(1).map(cellText)));
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows: rows.filter((r) => r.some((c) => c.trim())) };
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[]; hyperlink?: string };
    if (o.richText) return o.richText.map((t) => t.text).join('');
    if (o.text) return o.text;
    if (o.result !== undefined) return String(o.result);
    if (o.hyperlink) return o.hyperlink;
    return '';
  }
  return String(v);
}

/** Handles quotes, commas and semicolons (Excel in Europe writes semicolons). */
export function parseCsv(text: string): Sheet {
  const clean = text.replace(/^﻿/, '');
  const delim = (clean.split('\n')[0]?.match(/;/g)?.length ?? 0) > (clean.split('\n')[0]?.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows: rows.filter((r) => r.some((c) => c.trim())) };
}

/** First guess at which column is which field, so the mapping screen starts mostly filled in. */
export function guessMapping(headers: string[], fields: FieldDefinition[]): Record<string, string> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const alias: Record<string, string[]> = {
    first_name: ['firstname', 'givenname', 'vorname', 'prenom', 'nombre', 'name'],
    last_name: ['lastname', 'surname', 'familyname', 'nachname', 'nom', 'apellido'],
    company: ['company', 'organisation', 'organization', 'account', 'firma', 'societe', 'empresa'],
    job_title: ['jobtitle', 'title', 'designation', 'position', 'role', 'funktion'],
    email: ['email', 'emailaddress', 'mail', 'epost'],
    phone: ['phone', 'mobile', 'telephone', 'tel', 'cell', 'telefon', 'mobil'],
    website: ['website', 'web', 'url', 'site', 'homepage'],
    country: ['country', 'land', 'pays', 'pais'],
    address: ['address', 'street', 'adresse', 'location', 'city'],
  };
  const out: Record<string, string> = {};
  for (const f of fields) {
    const want = [norm(f.key), norm(f.label), ...(alias[f.key] ?? [])];
    const hit = headers.find((h) => want.includes(norm(h)));
    if (hit) out[f.key] = hit;
  }
  return out;
}

const widthFor = (f: FieldDefinition) => (f.type === 'longtext' ? 40 : f.type === 'email' || f.type === 'link' ? 28 : f.key === 'company' ? 26 : 18);

function exampleFor(f: FieldDefinition) {
  switch (f.type) {
    case 'email': return 'name@company.com';
    case 'phone': return '+49 151 2345678';
    case 'link': return 'https://company.com';
    case 'choice': return f.options[0] ?? '';
    default: return f.key === 'first_name' ? 'Lukas' : f.key === 'last_name' ? 'Schneider' : f.key === 'company' ? 'Feldtechnik GmbH' : '';
  }
}
