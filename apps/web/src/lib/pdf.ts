/**
 * PDF export of the leads list (ADM-06). jsPDF and its autoTable plugin are imported lazily —
 * exactly like ExcelJS in xlsx.ts — so they are downloaded only when an admin actually exports
 * and never land in the first-open budget (§8.1).
 */
import type { Lead } from './types';
import type { ExportContext } from './xlsx';
import { INTEREST_META, STATUS_META, leadName } from './leads';
import { t } from './i18n';

const BRAND: [number, number, number] = [4, 120, 87]; // #047857
const STRIPE: [number, number, number] = [241, 248, 245];
const INK: [number, number, number] = [30, 41, 59];
const MUTED: [number, number, number] = [100, 116, 139];

const MARGIN = 10;
const BAND_H = 22;
const TABLE_TOP = 26; // keeps the band clear on continuation pages

interface Col {
  header: string;
  /** Share of the usable width; turned into millimetres once the set is known. */
  weight: number;
  value: (l: Lead) => string;
}

/** A4 landscape, green header band, striped table, page numbers and the WeTano line. */
export async function leadsToPdf(leads: Lead[], ctx: ExportContext): Promise<Blob> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const usable = pageW - MARGIN * 2;

  const cols = columns(ctx);
  const total = cols.reduce((n, c) => n + c.weight, 0);
  const columnStyles: Record<number, { cellWidth: number }> = {};
  cols.forEach((c, i) => { columnStyles[i] = { cellWidth: (c.weight / total) * usable }; });

  // What produced this file, printed under the band on the first page.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  const meta = [
    `${t('Exported')}: ${new Date().toLocaleString()} · ${t('{n} leads', { n: leads.length })}`,
    ...ctx.filterSummary,
  ].flatMap((line) => doc.splitTextToSize(line, usable) as string[]);
  const startY = BAND_H + 5 + meta.length * 4;

  autoTable(doc, {
    startY,
    margin: { top: TABLE_TOP, left: MARGIN, right: MARGIN, bottom: 14 },
    theme: 'striped',
    head: [cols.map((c) => c.header)],
    body: leads.map((l) => cols.map((c) => c.value(l))),
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.8, textColor: INK, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: BRAND, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8, cellPadding: 2.2 },
    alternateRowStyles: { fillColor: STRIPE },
    columnStyles,
  });

  // Band, first-page summary and footer are painted afterwards, when the page count is known.
  const pages = doc.getNumberOfPages();
  const year = new Date().getFullYear();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);

    doc.setFillColor(...BRAND);
    doc.rect(0, 0, pageW, BAND_H, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.text(ctx.companyName || t('WeTa Snap'), MARGIN, 11);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(t('Leads export'), MARGIN, 17.5);
    doc.setFontSize(9);
    doc.text(t('{n} leads', { n: leads.length }), pageW - MARGIN, 14, { align: 'right' });

    if (p === 1) {
      doc.setTextColor(...MUTED);
      doc.setFontSize(8.5);
      meta.forEach((line, i) => doc.text(line, MARGIN, BAND_H + 6 + i * 4));
    }

    doc.setTextColor(...MUTED);
    doc.setFontSize(8);
    doc.text(`© ${year} WeTano Solutions · ${t('WeTa Snap')}`, MARGIN, pageH - 6);
    doc.text(t('Page {n} of {total}', { n: p, total: pages }), pageW - MARGIN, pageH - 6, { align: 'right' });
  }

  return doc.output('blob');
}

/**
 * The most useful card fields plus the lead's own columns — deliberately not every field,
 * so the rows stay readable on one landscape page.
 */
function columns(ctx: ExportContext): Col[] {
  const field = (key: string) => ctx.fields.find((f) => f.key === key);
  const text = (key: string) => (l: Lead) => l.fields[key]?.value ?? '';
  const out: Col[] = [];

  if (ctx.fields.some((f) => ['first_name', 'last_name', 'name'].includes(f.key))) {
    out.push({ header: t('Name'), weight: 2, value: leadName });
  }
  for (const [key, weight] of [['company', 2], ['job_title', 1.6], ['email', 2.4], ['phone', 1.6]] as const) {
    const f = field(key);
    if (f) out.push({ header: f.label, weight, value: text(key) });
  }
  // Unusual template (none of the standard keys) — fall back to the first few fields.
  if (!out.length) out.push(...ctx.fields.slice(0, 4).map((f) => ({ header: f.label, weight: 2, value: text(f.key) })));

  const tagName = (id: string) => ctx.tags.find((g) => g.id === id)?.name ?? id;
  out.push(
    { header: t('Tags'), weight: 1.5, value: (l) => (l.tag_ids ?? []).map(tagName).join(', ') },
    { header: t('Interest'), weight: 0.8, value: (l) => (l.interest ? t(INTEREST_META[l.interest].label) : '') },
    { header: t('Captured by'), weight: 1.4, value: (l) => l.captured_by_name },
    { header: t('Event'), weight: 1.6, value: (l) => ctx.eventName(l.event_id) },
    { header: t('CRM status'), weight: 1, value: (l) => t(STATUS_META[l.status].label) },
    { header: t('Time'), weight: 1.3, value: (l) => when(l.created_at) },
  );
  return out;
}

function when(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
