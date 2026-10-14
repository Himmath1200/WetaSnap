/**
 * Billing exports for WeTano (S9): the subscriptions and invoices lists as styled Excel files,
 * and invoices as A4 PDFs (one invoice per page). ExcelJS and jsPDF are imported lazily —
 * exactly as in xlsx.ts / pdf.ts — so nothing here lands in the first-open budget (§8.1).
 */
import type { Workbook, Worksheet } from 'exceljs';
import type { Invoice, InvoiceStatus, Subscription } from './types';
import { t } from './i18n';

export type SubscriptionRow = Subscription & { company_name: string; plan_name: string; mrr: number; currency: string };

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: 'Draft', sent: 'Sent', paid: 'Paid', overdue: 'Overdue', cancelled: 'Cancelled',
};

export interface BillingExportContext {
  /** Plain-English list of what produced the file, written to the second “Filters” sheet. */
  filterSummary: string[];
}

export interface BillTo { name: string; headquarters: string; country: string }

export interface InvoicePdfContext {
  /** Company name, head-office address and country for the “Bill to” block. */
  billTo: (companyId: string) => BillTo | undefined;
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HEADER_FILL = 'FF047857'; // brand green, as in xlsx.ts
const BAND_FILL = 'FFF1F8F5';
const DATE_FMT = 'dd/mm/yyyy';

// ---------------------------------------------------------------- Excel

/** Company subscriptions (SUB-02) — one row per company. */
export async function subscriptionsToXlsx(rows: SubscriptionRow[], ctx: BillingExportContext): Promise<Blob> {
  const wb = await workbook();
  const ws = wb.addWorksheet('Subscriptions', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: t('Company'), key: 'company', width: 30 },
    { header: t('Plan'), key: 'plan', width: 18 },
    { header: t('Billing cycle'), key: 'cycle', width: 14 },
    { header: t('Renews on'), key: 'renews', width: 13 },
    { header: t('Days to renewal'), key: 'days', width: 15 },
    { header: t('Auto-renew'), key: 'auto', width: 12 },
    { header: t('MRR'), key: 'mrr', width: 14 },
    { header: t('Currency'), key: 'currency', width: 10 },
  ];
  for (const s of rows) {
    const r = ws.addRow({
      company: s.company_name,
      plan: s.plan_name || t('No plan'),
      cycle: s.billing_cycle === 'annual' ? t('Yearly') : t('Monthly'),
      renews: excelDate(s.renews_on),
      days: s.renews_on ? daysTo(s.renews_on) : null,
      auto: s.auto_renew ? t('On') : t('Off'),
      mrr: major(s.mrr),
      currency: s.currency,
    });
    r.getCell('renews').numFmt = DATE_FMT;
    r.getCell('mrr').numFmt = currencyFormat(s.currency);
  }
  styleTable(ws, rows.length);
  filtersSheet(wb, t('Subscriptions'), rows.length, ctx.filterSummary);
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: XLSX_TYPE });
}

/** Invoices (SUB-03) — net, tax and total as real numbers with the invoice's currency format. */
export async function invoicesToXlsx(rows: Invoice[], ctx: BillingExportContext): Promise<Blob> {
  const wb = await workbook();
  const ws = wb.addWorksheet('Invoices', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: t('Number'), key: 'number', width: 15 },
    { header: t('Company'), key: 'company', width: 30 },
    { header: t('Plan'), key: 'plan', width: 16 },
    { header: t('Period start'), key: 'ps', width: 13 },
    { header: t('Period end'), key: 'pe', width: 13 },
    { header: t('Issued on'), key: 'issued', width: 13 },
    { header: t('Due on'), key: 'due', width: 13 },
    { header: t('Status'), key: 'status', width: 12 },
    { header: t('Net'), key: 'net', width: 13 },
    { header: t('Tax'), key: 'tax', width: 12 },
    { header: t('Total'), key: 'total', width: 14 },
    { header: t('Currency'), key: 'currency', width: 10 },
    { header: t('Paid on'), key: 'paid_on', width: 13 },
    { header: t('Paid by'), key: 'paid_by', width: 18 },
    { header: t('Notes'), key: 'notes', width: 40 },
  ];
  for (const i of rows) {
    const r = ws.addRow({
      number: i.number,
      company: i.company_name,
      plan: i.plan_name || '',
      ps: excelDate(i.period_start),
      pe: excelDate(i.period_end),
      issued: excelDate(i.issued_on),
      due: excelDate(i.due_on),
      status: t(INVOICE_STATUS_LABEL[i.status]),
      net: major(i.amount),
      tax: major(i.tax),
      total: major(i.amount + i.tax),
      currency: i.currency,
      paid_on: excelDate(i.paid_on),
      paid_by: i.paid_by,
      notes: i.notes,
    });
    for (const k of ['ps', 'pe', 'issued', 'due', 'paid_on']) r.getCell(k).numFmt = DATE_FMT;
    const fmt = currencyFormat(i.currency);
    for (const k of ['net', 'tax', 'total']) r.getCell(k).numFmt = fmt;
    r.getCell('total').font = { bold: true };
    if (i.status === 'overdue') r.getCell('status').font = { bold: true, color: { argb: 'FFB91C1C' } };
    if (i.status === 'paid') r.getCell('status').font = { bold: true, color: { argb: 'FF047857' } };
  }
  styleTable(ws, rows.length);
  filtersSheet(wb, t('Invoices'), rows.length, ctx.filterSummary);
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: XLSX_TYPE });
}

async function workbook(): Promise<Workbook> {
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WeTa Snap';
  wb.created = new Date();
  return wb;
}

/** Green header, banded rows, a filter arrow on every column — the same look as the leads export. */
function styleTable(ws: Worksheet, count: number) {
  const cols = ws.columns.length;
  const header = ws.getRow(1);
  header.height = 22;
  header.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    c.alignment = { vertical: 'middle', horizontal: 'left' };
    c.border = { bottom: { style: 'thin', color: { argb: 'FF065F46' } } };
  });
  for (let r = 3; r <= count + 1; r += 2) {
    const row = ws.getRow(r);
    for (let c = 1; c <= cols; c++) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, count + 1), column: cols } };
}

function filtersSheet(wb: Workbook, what: string, count: number, summary: string[]) {
  const info = wb.addWorksheet('Filters');
  info.columns = [{ header: t('Item'), key: 'k', width: 22 }, { header: t('Value'), key: 'v', width: 60 }];
  info.getRow(1).font = { bold: true };
  info.addRows([
    { k: t('Exported by'), v: 'WeTano Solutions · WeTa Snap' },
    { k: t('Exported'), v: new Date().toLocaleString() },
    { k: what, v: String(count) },
    ...(summary.length ? summary : [t('No filters — all rows')]).map((f) => ({ k: t('Filter'), v: f })),
  ]);
}

/** Excel number format that shows the right symbol while the cell stays a number. */
function currencyFormat(currency: string) {
  const sym: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', INR: '₹', JPY: '¥' };
  const code = (currency || 'EUR').toUpperCase();
  return sym[code] ? `"${sym[code]}"#,##0.00;-"${sym[code]}"#,##0.00` : `#,##0.00 "${code}";-#,##0.00 "${code}"`;
}

/** yyyy-mm-dd → a UTC-midnight Date, so Excel shows the same calendar day everywhere. */
function excelDate(iso: string | null): Date | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

const major = (minor: number) => Math.round(minor || 0) / 100;
const daysTo = (date: string) => Math.ceil((new Date(`${date}T23:59:59`).getTime() - Date.now()) / 86_400_000);

// ---------------------------------------------------------------- PDF

const BRAND: [number, number, number] = [4, 120, 87]; // #047857
const BRAND_TINT: [number, number, number] = [236, 247, 242];
const RED: [number, number, number] = [185, 28, 28];
const INK: [number, number, number] = [30, 41, 59];
const MUTED: [number, number, number] = [100, 116, 139];
const LINE: [number, number, number] = [226, 232, 240];
const M = 16;

/** One A4 page per invoice: header with logo, bill-to, dates, plan line, totals, status stamp, payment line. */
export async function invoicesToPdf(invoices: Invoice[], ctx: InvoicePdfContext): Promise<Blob> {
  const [{ jsPDF }, { default: autoTable }, logo] = await Promise.all([import('jspdf'), import('jspdf-autotable'), loadLogo()]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const right = W - M;

  const text = (s: string, x: number, y: number, opts?: { align?: 'left' | 'right' | 'center' }) => doc.text(clean(s), x, y, opts);
  const font = (size: number, style: 'normal' | 'bold' = 'normal', colour: [number, number, number] = INK) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(...colour);
  };

  invoices.forEach((inv, index) => {
    if (index > 0) doc.addPage();
    const to = ctx.billTo(inv.company_id) ?? { name: inv.company_name, headquarters: '', country: '' };

    // Header: accent band, logo, seller, “INVOICE” and its number.
    doc.setFillColor(...BRAND);
    doc.rect(0, 0, W, 5, 'F');
    if (logo) doc.addImage(logo, 'PNG', M, 12, 17, 17);
    else {
      doc.setFillColor(...BRAND);
      doc.roundedRect(M, 12, 17, 17, 3, 3, 'F');
      font(12, 'bold', [255, 255, 255]);
      text('W', M + 8.5, 22.8, { align: 'center' });
    }
    font(15, 'bold');
    text('WeTano Solutions', M + 21, 19);
    font(9, 'normal', MUTED);
    text(t('WeTa Snap · exhibition lead capture'), M + 21, 24.5);
    font(22, 'bold', BRAND);
    text(t('INVOICE'), right, 20, { align: 'right' });
    font(10, 'bold');
    text(inv.number, right, 26.5, { align: 'right' });
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.3);
    doc.line(M, 35, right, 35);

    // Bill to (left) and the invoice facts (right).
    font(8, 'bold', MUTED);
    text(t('BILL TO'), M, 44);
    font(11, 'bold');
    const nameLines = doc.splitTextToSize(clean(to.name), 88) as string[];
    doc.text(nameLines, M, 50);
    let y = 50 + nameLines.length * 5;
    font(9.5, 'normal');
    const address = [
      ...to.headquarters.split(/\r?\n/).flatMap((l) => doc.splitTextToSize(clean(l.trim()), 88) as string[]),
      clean(to.country),
    ].filter(Boolean);
    address.forEach((l) => { doc.text(l, M, y); y += 4.6; });
    const leftEnd = y;

    const facts: [string, string][] = [
      [t('Invoice number'), inv.number],
      [t('Issue date'), pdfDate(inv.issued_on)],
      [t('Due date'), pdfDate(inv.due_on)],
      [t('Billing period'), `${pdfDate(inv.period_start)} - ${pdfDate(inv.period_end)}`],
      [t('Status'), t(INVOICE_STATUS_LABEL[inv.status])],
    ];
    if (inv.paid_on) facts.push([t('Paid on'), pdfDate(inv.paid_on)]);
    let fy = 44;
    facts.forEach(([k, v]) => {
      font(8.5, 'normal', MUTED);
      text(k, right - 78, fy);
      font(9.5, 'bold');
      text(v, right, fy, { align: 'right' });
      fy += 6;
    });

    // The plan line.
    const startY = Math.max(leftEnd, fy) + 8;
    const planName = inv.plan_name || t('Subscription');
    autoTable(doc, {
      startY,
      margin: { left: M, right: M, bottom: 30 },
      theme: 'plain',
      head: [[t('Description'), t('Period'), t('Amount')]],
      body: [[
        clean(`${t('{plan} plan', { plan: planName })}\n${t('WeTa Snap subscription')}`),
        clean(`${pdfDate(inv.period_start)} - ${pdfDate(inv.period_end)}`),
        clean(pdfMoney(inv.amount, inv.currency)),
      ]],
      styles: { font: 'helvetica', fontSize: 9.5, cellPadding: { top: 3.5, bottom: 3.5, left: 3, right: 3 }, textColor: INK, valign: 'middle' },
      headStyles: { fillColor: BRAND, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
      columnStyles: { 0: { cellWidth: 'auto' }, 1: { cellWidth: 52 }, 2: { cellWidth: 34, halign: 'right' } },
      didParseCell: (d) => { if (d.section === 'head' && d.column.index === 2) d.cell.styles.halign = 'right'; },
      didDrawCell: (d) => {
        if (d.section === 'body') {
          doc.setDrawColor(...LINE);
          doc.line(d.cell.x, d.cell.y + d.cell.height, d.cell.x + d.cell.width, d.cell.y + d.cell.height);
        }
      },
    });
    const tableEnd = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

    // Totals (right) and the status stamp (left, same height).
    const tx = right - 80;
    let ty = tableEnd + 9;
    const rate = inv.amount > 0 && inv.tax > 0 ? ` (${Math.round((inv.tax / inv.amount) * 1000) / 10}%)` : '';
    const totalRow = (label: string, value: string) => {
      font(9.5, 'normal', MUTED);
      text(label, tx + 3, ty);
      font(9.5, 'normal');
      text(value, right - 3, ty, { align: 'right' });
      ty += 6.5;
    };
    totalRow(t('Subtotal'), pdfMoney(inv.amount, inv.currency));
    totalRow(`${t('Tax')}${rate}`, pdfMoney(inv.tax, inv.currency));
    doc.setFillColor(...BRAND_TINT);
    doc.roundedRect(tx, ty - 4.8, 80, 10, 1.5, 1.5, 'F');
    font(11, 'bold', BRAND);
    text(inv.status === 'paid' ? t('Total paid') : t('Total due'), tx + 3, ty + 1.6);
    text(pdfMoney(inv.amount + inv.tax, inv.currency), right - 3, ty + 1.6, { align: 'right' });
    ty += 12;

    const stamp = stampFor(inv.status);
    if (stamp) {
      const sy = tableEnd + 6;
      doc.setDrawColor(...stamp.colour);
      doc.setLineWidth(1);
      doc.roundedRect(M + 2, sy, 50, 16, 2.5, 2.5, 'S');
      doc.setLineWidth(0.3);
      doc.roundedRect(M + 3.2, sy + 1.2, 47.6, 13.6, 1.8, 1.8, 'S');
      font(17, 'bold', stamp.colour);
      text(stamp.label, M + 27, sy + 10.4, { align: 'center' });
      if (inv.status === 'paid' && inv.paid_on) {
        font(7.5, 'normal', stamp.colour);
        text(pdfDate(inv.paid_on), M + 27, sy + 20.5, { align: 'center' });
      }
    }

    // Notes.
    y = Math.max(ty, tableEnd + 30) + 4;
    if (inv.notes.trim()) {
      font(8, 'bold', MUTED);
      text(t('NOTES'), M, y);
      font(9.5, 'normal');
      const lines = doc.splitTextToSize(clean(inv.notes.trim()), W - M * 2) as string[];
      doc.text(lines.slice(0, 12), M, y + 5.5);
      y += 5.5 + Math.min(lines.length, 12) * 4.6 + 4;
    }

    // Payment details.
    const pay = inv.status === 'paid'
      ? t('Payment received on {date}{by}. Thank you.', { date: pdfDate(inv.paid_on), by: inv.paid_by ? ` (${inv.paid_by})` : '' })
      : inv.status === 'cancelled'
        ? t('This invoice has been cancelled — nothing is due.')
        : t('Please pay {total} by {date}, quoting {number} as the payment reference.', { total: pdfMoney(inv.amount + inv.tax, inv.currency), date: pdfDate(inv.due_on), number: inv.number });
    font(9, 'normal', inv.status === 'overdue' ? RED : INK); // before splitting, so the wrap width is measured in this size
    const payLines = doc.splitTextToSize(clean(`${t('Payment details')}: ${pay}`), W - M * 2 - 8) as string[];
    const boxH = payLines.length * 4.6 + 6;
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(...LINE);
    doc.roundedRect(M, y, W - M * 2, boxH, 2, 2, 'FD');
    doc.text(payLines, M + 4, y + 5.6);
  });

  // Footer on every page, once the page count is known.
  const pages = doc.getNumberOfPages();
  const year = new Date().getFullYear();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.3);
    doc.line(M, H - 18, right, H - 18);
    font(8, 'normal', MUTED);
    text(`WeTano Solutions · ${t('WeTa Snap')} · ${t('Thank you for your business.')}`, M, H - 12);
    text(`© ${year} WeTano Solutions`, M, H - 7.5);
    const inv = invoices[p - 1];
    if (inv) text(inv.number, right, H - 12, { align: 'right' });
    text(t('Page {n} of {total}', { n: p, total: pages }), right, H - 7.5, { align: 'right' });
  }

  doc.setProperties({ title: invoices.length === 1 ? invoices[0]!.number : t('Invoices'), author: 'WeTano Solutions', creator: 'WeTa Snap' });
  return doc.output('blob');
}

function stampFor(status: InvoiceStatus): { label: string; colour: [number, number, number] } | null {
  switch (status) {
    case 'paid': return { label: t('PAID'), colour: BRAND };
    case 'overdue': return { label: t('OVERDUE'), colour: RED };
    case 'cancelled': return { label: t('CANCELLED'), colour: MUTED };
    case 'draft': return { label: t('DRAFT'), colour: MUTED };
    default: return null;
  }
}

/** The app icon as a data URL; null (a drawn “W” is used) when it cannot be fetched, e.g. offline. */
async function loadLogo(): Promise<string | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}icon-192.png`);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.onerror = () => fail(r.error);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** The built-in PDF fonts are Latin-1 only: symbols they have, a currency code otherwise. */
function pdfMoney(minor: number, currency: string) {
  const code = (currency || 'EUR').toUpperCase();
  const n = Math.abs((minor || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = minor < 0 ? '-' : '';
  const sym: Record<string, string> = { EUR: '€', GBP: '£', USD: '$' };
  return sym[code] ? `${sign}${sym[code]}${n}` : `${sign}${code} ${n}`;
}

function pdfDate(iso: string | null) {
  if (!iso) return '-';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Swap characters the standard PDF fonts cannot draw (thin spaces, dashes, arrows) for plain ones. */
function clean(s: string) {
  return s
    .replace(/[    ]/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/→/g, '->')
    .replace(/…/g, '...');
}
