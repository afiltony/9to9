import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { config, ROOT } from '../config.js';
import { eventContent } from '../content.js';
import { dayLabel, displayName, fullName, shortDate, timeRange } from '../lib/format.js';
import { ARCHDIOCESE, PARISHES_BY_FORANE } from '../parishes.js';

const MM = 72 / 25.4;
// the participant card: 10 cm wide × 12.5 cm high
export const CARD_W = 100 * MM;
export const CARD_H = 125 * MM;

const INK = '#1b1d24';
const MUTED = '#5d6272';
const LINE = '#dcdfe8';

// ---------------------------------------------------------------- fonts (embedded)

const FONT_DIR = path.join(ROOT, 'node_modules', '@fontsource');
const FONT_FILES = {
  Display: 'roboto-slab/files/roboto-slab-latin-900-normal.woff',
  Heading: 'roboto-slab/files/roboto-slab-latin-700-normal.woff',
  HeadingMed: 'roboto-slab/files/roboto-slab-latin-700-normal.woff',
  Body: 'roboto/files/roboto-latin-400-normal.woff',
  BodyMed: 'roboto/files/roboto-latin-500-normal.woff',
  BodyBold: 'roboto/files/roboto-latin-700-normal.woff',
  BodyItalic: 'roboto/files/roboto-latin-400-italic.woff',
  Title: 'poppins/files/poppins-latin-900-normal.woff',
  TitleBold: 'poppins/files/poppins-latin-700-normal.woff',
};
const fontCache = {};

function newDoc(options) {
  const doc = new PDFDocument({ autoFirstPage: false, ...options });
  for (const [name, file] of Object.entries(FONT_FILES)) {
    fontCache[name] ??= fs.readFileSync(path.join(FONT_DIR, file));
    doc.registerFont(name, fontCache[name]);
  }
  return doc;
}

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function colors(event) {
  const { theme } = eventContent(event);
  return { primary: theme.primary, secondary: theme.secondary };
}

// ---------------------------------------------------------------- images

export const checkinUrl = (p) => `${config.baseUrl}/checkin/${p.qr_token}`;

function storageFile(rel) {
  if (!rel) return null;
  const file = path.join(config.storageDir, rel);
  return fs.existsSync(file) ? file : null;
}

function logoFile(event) {
  return storageFile(event.logo_path) || (fs.existsSync(path.join(ROOT, 'public/img/logo.png')) ? path.join(ROOT, 'public/img/logo.png') : null);
}

/** Draws the QR code as vector squares, so it stays sharp at any print size. */
function drawQr(doc, text, x, y, size) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 1;
  const cell = size / (n + quiet * 2);
  doc.save().rect(x, y, size, size).fill('#ffffff');
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.modules.get(r, c)) { c++; continue; }
      const start = c;
      while (c < n && qr.modules.get(r, c)) c++;
      doc.rect(x + (start + quiet) * cell, y + (r + quiet) * cell, (c - start) * cell + 0.02, cell + 0.02);
    }
  }
  doc.fill('#000000').restore();
}

/** Round photo centred on (cx, cy): a coloured disc with the photo set inside a white ring. */
function drawPhoto(doc, p, cx, cy, r, disc) {
  doc.circle(cx, cy, r).fill(disc);
  const pr = r - 5;
  doc.circle(cx, cy, pr + 1.8).fill('#ffffff');
  doc.save().circle(cx, cy, pr).clip();
  const file = storageFile(p.profile_photo_path);
  let drawn = false;
  if (file) {
    try {
      doc.image(file, cx - pr, cy - pr, { cover: [pr * 2, pr * 2], align: 'center', valign: 'center' });
      drawn = true;
    } catch {
      // unreadable image: placeholder below
    }
  }
  if (!drawn) {
    doc.rect(cx - pr, cy - pr, pr * 2, pr * 2).fill('#eceef4');
    doc.fillColor(MUTED).font('Body').fontSize(6.5).text('PHOTO', cx - pr, cy - 4, { width: pr * 2, align: 'center' });
  }
  doc.restore();
}

// the event wordmark printed at the top of the card front
const WORDMARK = path.join(ROOT, 'public/img/logo-wordmark.jpg');

/** Pale quarter-circle pattern behind the card front, as on the event's printed badges. */
function drawPattern(doc, x, y, W, H, tint) {
  const cell = W / 4;
  doc.save().rect(x, y, W, H).clip();
  for (let r = 0; r * cell < H; r++) {
    for (let c = 0; c < 4; c++) {
      const cx = x + c * cell;
      const cy = y + r * cell;
      // the arc's centre sits on one corner of the cell, rotating round the grid
      const k = (c + r * 3) % 4;
      const ox = cx + (k === 1 || k === 2 ? cell : 0);
      const oy = cy + (k >= 2 ? cell : 0);
      doc.save().rect(cx + 1.5, cy + 1.5, cell - 3, cell - 3).clip();
      doc.circle(ox, oy, cell - 3).fill(tint);
      doc.restore();
    }
  }
  doc.restore();
}

/** Diocese as typed, or the Archdiocese when the parish is one of its own. */
function dioceseOf(p) {
  if (p.diocese) return p.diocese;
  return PARISHES_BY_FORANE[p.forane]?.includes(p.parish) ? ARCHDIOCESE : null;
}

/** Writes one line of text, shrinking it down to `min` points so it fits the width. */
function fitLine(doc, text, x, y, width, font, size, min, opts = {}) {
  doc.font(font).fontSize(size);
  while (size > min && doc.widthOfString(text, opts) > width) doc.fontSize(size -= 0.25);
  doc.text(text, x, y, { width, lineBreak: false, ellipsis: true, ...opts });
  return size;
}

// ---------------------------------------------------------------- ID card (100 × 125 mm portrait)

function cardFooter(doc, event, x, y, W, H, text) {
  const { primary } = colors(event);
  doc.rect(x, y + H - 20, W, 20).fill(primary);
  doc.fillColor('#ffffff').font('HeadingMed').fontSize(8.5)
    .text(text, x + 8, y + H - 14, { width: W - 16, align: 'center', characterSpacing: 0.4, lineBreak: false, ellipsis: true });
}

// Front, laid out like the event's printed badges: wordmark, title, round photo, then the
// name at the bottom left with parish, diocese and organization. The QR code is on the back.
function drawIdFront(doc, event, p, x, y) {
  const { primary } = colors(event);
  const W = CARD_W;
  const H = CARD_H;
  const pad = 16;
  doc.save();
  doc.rect(x, y, W, H).clip();
  doc.rect(x, y, W, H).fill('#ffffff');
  drawPattern(doc, x, y, W, H - 20, '#fcf6f6');

  // wordmark and title
  const logoW = 132;
  try { doc.image(WORDMARK, x + (W - logoW) / 2, y + 12, { width: logoW }); } catch { /* no wordmark */ }
  const theme = eventContent(event).hero_theme;
  if (theme) doc.fillColor(INK).font('TitleBold').fontSize(6.5).text(theme.toUpperCase(), x, y + 57, { width: W, align: 'center', characterSpacing: 0.8, lineBreak: false });
  doc.fillColor(primary).font('Title').fontSize(29).text('24 HOUR', x, y + 62, { width: W, align: 'center', lineBreak: false });
  doc.fillColor(INK).font('Title').fontSize(19).text('GOD EXPERIENCE', x, y + 93, { width: W, align: 'center', lineBreak: false });

  // round photo
  drawPhoto(doc, p, x + W / 2, y + 170, 48, primary);

  // name: first word large, the rest below it, both shrinking to fit the width
  const [first, ...rest] = displayName(p).toUpperCase().split(/\s+/);
  let ny = y + 222;
  doc.fillColor(primary);
  fitLine(doc, first, x + pad, ny, W - pad * 2, 'Title', 24, 14);
  ny += 29;
  if (rest.length) {
    doc.fillColor(INK);
    fitLine(doc, rest.join(' '), x + pad, ny, W - pad * 2, 'TitleBold', 14, 9);
    ny += 18;
  }
  doc.fillColor(MUTED).font('BodyItalic').fontSize(8.5).text(`Reg. No. ${p.registration_number}`, x + pad, ny, { lineBreak: false });

  // parish, diocese and organization are optional: only print what was collected
  const org = p.organization || p.institution || p.youth_group;
  const details = [
    p.parish && ['Parish', p.parish],
    dioceseOf(p) && ['Diocese', dioceseOf(p)],
    org && ['Organization', org],
  ].filter(Boolean);
  const labelW = 66;
  let dy = y + H - 20 - 7 - details.length * 11.5;
  doc.moveTo(x + pad, dy - 5).lineTo(x + W - pad, dy - 5).lineWidth(0.8).stroke(primary);
  for (const [label, value] of details) {
    doc.fillColor(primary).font('TitleBold').fontSize(6.5).text(label.toUpperCase(), x + pad, dy + 1.2, { width: labelW, characterSpacing: 0.6, lineBreak: false });
    doc.fillColor(INK);
    fitLine(doc, value, x + pad + labelW, dy, W - pad * 2 - labelW, 'BodyBold', 8.5, 6.5);
    dy += 11.5;
  }

  cardFooter(doc, event, x, y, W, H,
    `${shortDate(event.start_at).toUpperCase()} 9 AM – ${shortDate(event.end_at).toUpperCase()} 9 AM${event.venue ? ` · ${event.venue.toUpperCase()}` : ''}`);
  doc.restore();
}

// Back: "My experience" — every booked activity with day, time and venue. The text shrinks
// when someone has booked a lot, so the whole list always fits on the card.
function drawIdBack(doc, event, p, bookings, x, y) {
  const { primary, secondary } = colors(event);
  const W = CARD_W;
  const H = CARD_H;
  const pad = 16;
  doc.save();
  doc.rect(x, y, W, H).clip();
  doc.rect(x, y, W, H).fill('#ffffff');
  doc.rect(x, y, W, 44).fill(primary);
  doc.rect(x, y + 44, W, 3).fill(secondary);
  doc.fillColor('#ffffff').font('Heading').fontSize(14).text('MY EXPERIENCE', x + pad, y + 9, { characterSpacing: 1, lineBreak: false });
  doc.fillColor(secondary).font('BodyBold').fontSize(8.5)
    .text(`${fullName(p).toUpperCase()} · ${p.registration_number}`, x + pad, y + 28, { width: W - pad * 2, lineBreak: false, ellipsis: true });

  const top = y + 56;
  const qr = 64;
  const bottom = y + H - 20 - qr - 14;
  const timeW = 100;
  const actX = x + pad + timeW;
  const actW = x + W - pad - actX;
  const rows = bookings.map((b) => ({
    day: dayLabel(b.start_at),
    time: timeRange(b.start_at, b.end_at),
    activity: b.label ? `${b.activity_name} — ${b.label}` : b.activity_name,
    venue: b.venue || '',
  }));

  // lays the list out at scale s; draws it when `draw` is set; returns the height used
  const layout = (s, draw) => {
    let cy = top;
    let lastDay = null;
    for (const r of rows) {
      if (r.day !== lastDay) {
        if (draw) doc.fillColor(primary).font('BodyBold').fontSize(7.5 * s).text(r.day.toUpperCase(), x + pad, cy + 2 * s, { characterSpacing: 0.6, lineBreak: false });
        cy += 14 * s;
        lastDay = r.day;
      }
      doc.font('BodyBold').fontSize(9.5 * s);
      const actH = doc.heightOfString(r.activity, { width: actW });
      const h = actH + (r.venue ? 10.5 * s : 0) + 6 * s;
      if (draw) {
        doc.fillColor(INK).font('BodyMed').fontSize(8.4 * s).text(r.time, x + pad, cy + 1, { width: timeW - 4, lineBreak: false });
        doc.font('BodyBold').fontSize(9.5 * s).text(r.activity, actX, cy, { width: actW });
        if (r.venue) doc.fillColor(MUTED).font('Body').fontSize(8 * s).text(r.venue, actX, cy + actH + 0.5, { width: actW, lineBreak: false, ellipsis: true });
        doc.moveTo(x + pad, cy + h - 2.5 * s).lineTo(x + W - pad, cy + h - 2.5 * s).lineWidth(0.4).stroke(LINE);
      }
      cy += h;
    }
    return cy - top;
  };

  if (!rows.length) {
    doc.fillColor(MUTED).font('Body').fontSize(10)
      .text('No activity bookings. You are welcome at all open programmes — see the schedule at the help desk.', x + pad, top + 20, { width: W - pad * 2, align: 'center' });
  } else {
    let s = 1;
    while (s > 0.5 && layout(s, false) > bottom - top) s -= 0.05;
    layout(s, true);
  }

  // check-in QR code at the bottom, next to its instructions
  const qy = y + H - 20 - qr - 6;
  doc.moveTo(x + pad, qy - 4).lineTo(x + W - pad, qy - 4).lineWidth(0.6).stroke(LINE);
  drawQr(doc, checkinUrl(p), x + W - pad - qr + 3, qy, qr);
  doc.fillColor(primary).font('TitleBold').fontSize(9).text('SCAN AT CHECK-IN', x + pad, qy + 18, { width: W - pad * 2 - qr, characterSpacing: 0.5, lineBreak: false });
  doc.fillColor(MUTED).font('Body').fontSize(7.5)
    .text('Show this QR code at check-in and at each activity.', x + pad, qy + 32, { width: W - pad * 2 - qr - 8 });
  cardFooter(doc, event, x, y, W, H, event.contact_phone ? `HELP DESK: ${event.contact_phone}` : 'EVENT HELP DESK');
  doc.restore();
}

/** One participant's ID card for a card printer: page 1 front, page 2 back (with their bookings). */
export async function idCardPdf(event, p, bookings = []) {
  return idCardsPdf(event, [p], { layout: 'card', bookings: new Map([[p.id, bookings]]) });
}

function cropMarks(doc, x0, y0, cols, rows) {
  const len = 5 * MM;
  const off = 1.5 * MM;
  doc.save().lineWidth(0.3).strokeColor('#000000');
  for (let c = 0; c <= cols; c++) {
    const x = x0 + c * CARD_W;
    doc.moveTo(x, y0 - off - len).lineTo(x, y0 - off).stroke();
    doc.moveTo(x, y0 + rows * CARD_H + off).lineTo(x, y0 + rows * CARD_H + off + len).stroke();
  }
  for (let r = 0; r <= rows; r++) {
    const y = y0 + r * CARD_H;
    doc.moveTo(x0 - off - len, y).lineTo(x0 - off, y).stroke();
    doc.moveTo(x0 + cols * CARD_W + off, y).lineTo(x0 + cols * CARD_W + off + len, y).stroke();
  }
  doc.restore();
}

/**
 * ID cards for many participants.
 *  layout 'card': one card per page (front, back, front, back…) for the card printer.
 *  layout 'a4':   as many cards as fit on an A4 sheet (4), with crop marks; each front sheet is followed by its
 *                 back sheet, mirrored left-to-right for long-edge duplex printing.
 * bookings: Map(participantId → confirmed bookings), printed on the back as "My experience".
 */
export async function idCardsPdf(event, participants, { layout = 'card', bookings = new Map() } = {}) {
  const booked = (p) => bookings.get(p.id) || [];
  const doc = newDoc({ info: { Title: `${event.name} — ID cards`, Author: event.name } });
  if (layout === 'a4') {
    const pageW = 595.28;
    const pageH = 841.89;
    // 2 × 2 cards: 200 × 250 mm on the 210 × 297 mm sheet
    const cols = Math.max(1, Math.floor((pageW - 8 * MM) / CARD_W));
    const rows = Math.max(1, Math.floor((pageH - 8 * MM) / CARD_H));
    const x0 = (pageW - cols * CARD_W) / 2;
    const y0 = (pageH - rows * CARD_H) / 2;
    for (let i = 0; i < participants.length; i += cols * rows) {
      const batch = participants.slice(i, i + cols * rows);
      doc.addPage({ size: 'A4', margin: 0 });
      batch.forEach((p, k) => drawIdFront(doc, event, p, x0 + (k % cols) * CARD_W, y0 + Math.floor(k / cols) * CARD_H));
      cropMarks(doc, x0, y0, cols, rows);
      doc.addPage({ size: 'A4', margin: 0 });
      batch.forEach((p, k) => drawIdBack(doc, event, p, booked(p), x0 + (cols - 1 - (k % cols)) * CARD_W, y0 + Math.floor(k / cols) * CARD_H));
      cropMarks(doc, x0, y0, cols, rows);
    }
  } else {
    for (const p of participants) {
      doc.addPage({ size: [CARD_W, CARD_H], margin: 0 });
      drawIdFront(doc, event, p, 0, 0);
      doc.addPage({ size: [CARD_W, CARD_H], margin: 0 });
      drawIdBack(doc, event, p, booked(p), 0, 0);
    }
  }
  return toBuffer(doc);
}

// ---------------------------------------------------------------- activity card (A5)

function drawActivityCard(doc, event, p, bookings, openItems) {
  const { primary, secondary } = colors(event);
  const content = eventContent(event);
  doc.addPage({ size: 'A5', margins: { top: 36, bottom: 20, left: 36, right: 36 } });
  const W = doc.page.width;
  const H = doc.page.height;
  const L = 36;
  const R = W - 36;

  // header
  doc.rect(0, 0, W, 96).fill(primary);
  doc.rect(0, 96, W, 4).fill(secondary);
  const logo = logoFile(event);
  if (logo) { try { doc.image(logo, L, 18, { fit: [58, 58] }); } catch { /* no logo */ } }
  doc.fillColor('#ffffff').font('Display').fontSize(26).text('9 to 9 meet', 0, 17, { width: W, align: 'center', lineBreak: false });
  doc.fillColor(secondary).font('Heading').fontSize(9).text('24 HOUR GOD EXPERIENCE', 0, 48, { width: W, align: 'center', characterSpacing: 1.2, lineBreak: false });
  doc.fillColor('#cfd5ea').font('BodyMed').fontSize(7.5)
    .text((event.subtitle || '').toUpperCase(), 0, 64, { width: W, align: 'center', characterSpacing: 0.6, lineBreak: false });
  doc.fillColor('#cfd5ea').font('Body').fontSize(7)
    .text(`${shortDate(event.start_at)} 9 AM – ${shortDate(event.end_at)} 9 AM${event.venue ? ` · ${event.venue}` : ''}`, 0, 77, { width: W, align: 'center', lineBreak: false });

  doc.fillColor(primary).font('Heading').fontSize(10).text('PARTICIPANT ACTIVITY CARD', L, 114, { characterSpacing: 1, lineBreak: false });

  const qrSize = 94;
  drawQr(doc, checkinUrl(p), R - qrSize, 108, qrSize);
  doc.fillColor(MUTED).font('BodyMed').fontSize(7).text('PARTICIPANT', L, 136, { characterSpacing: 0.5 });
  doc.fillColor(INK).font('Heading').fontSize(14).text(fullName(p).toUpperCase(), L, 146, { width: R - qrSize - L - 10, height: 36, ellipsis: true });
  doc.fillColor(MUTED).font('BodyMed').fontSize(7).text('REGISTRATION', L, 180, { characterSpacing: 0.5 });
  doc.fillColor(primary).font('Heading').fontSize(12).text(p.registration_number, L, 189, { characterSpacing: 0.6, lineBreak: false });

  let y = 220;
  const cols = [
    { title: 'TIME', x: L, w: 104 },
    { title: 'ACTIVITY', x: L + 106, w: 146 },
    { title: 'VENUE', x: L + 254, w: R - (L + 254) - 22 },
    { title: '✓', x: R - 20, w: 20 },
  ];
  const header = () => {
    doc.rect(L, y, R - L, 17).fill('#eef1f8');
    doc.fillColor(primary).font('Heading').fontSize(7);
    for (const c of cols.slice(0, 3)) doc.text(c.title, c.x + 4, y + 5.5, { width: c.w - 4, lineBreak: false });
    y += 21;
  };
  const ensureRoom = (h) => {
    if (y + h > H - 64) {
      doc.addPage({ size: 'A5', margins: { top: 36, bottom: 20, left: 36, right: 36 } });
      y = 36;
      header();
    }
  };

  const section = (title, items, emptyText, withBox) => {
    ensureRoom(44);
    doc.fillColor(INK).font('Heading').fontSize(9.5).text(title, L, y, { lineBreak: false });
    y += 15;
    header();
    if (!items.length) {
      doc.fillColor(MUTED).font('Body').fontSize(8.5).text(emptyText, L + 4, y);
      y += 20;
      return;
    }
    let lastDay = null;
    for (const b of items) {
      const day = dayLabel(b.start_at);
      if (day !== lastDay) {
        ensureRoom(34);
        doc.fillColor(MUTED).font('BodyBold').fontSize(6.8).text(day.toUpperCase(), L + 4, y, { characterSpacing: 0.6, lineBreak: false });
        y += 11;
        lastDay = day;
      }
      const activity = b.label ? `${b.activity_name} — ${b.label}` : b.activity_name;
      doc.font('BodyBold').fontSize(8.5);
      const h = Math.max(17, doc.heightOfString(activity, { width: cols[1].w - 4 }) + 7);
      ensureRoom(h);
      doc.fillColor(INK).font('BodyMed').fontSize(8.3).text(timeRange(b.start_at, b.end_at), cols[0].x + 4, y + 3.5, { width: cols[0].w - 4 });
      doc.font('BodyBold').fontSize(8.5).text(activity, cols[1].x + 4, y + 3.5, { width: cols[1].w - 4 });
      doc.font('Body').fontSize(8.3).text(b.venue || '—', cols[2].x + 4, y + 3.5, { width: cols[2].w - 4 });
      if (withBox) {
        // stamped or ticked by staff at the activity
        doc.roundedRect(cols[3].x + 5, y + 3, 10, 10, 2).lineWidth(0.8).stroke(b.checked_in_at ? primary : '#9aa0b4');
        if (b.checked_in_at) doc.moveTo(cols[3].x + 7, y + 8).lineTo(cols[3].x + 9.5, y + 10.5).lineTo(cols[3].x + 13.5, y + 5).lineWidth(1.3).stroke(primary);
      }
      y += h;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).stroke(LINE);
      y += 2;
    }
    y += 10;
  };

  section('MY EXPERIENCE', bookings, 'No slot bookings. You are welcome at all open programmes.', true);
  if (openItems.length) section('OPEN TO ALL PARTICIPANTS', openItems, '', false);

  doc.fillColor(MUTED).font('Body').fontSize(7.3)
    .text(`Show the QR code on this card or your ID card at each activity. ${event.help_desk_text || 'For assistance please contact the EVENT HELP DESK.'}`,
      L, H - 54, { width: R - L, align: 'center' });
}

/** Card 2: A5 personal activity card with the participant's bookings. */
export async function activityCardPdf(event, p, bookings, openItems = []) {
  return activityCardsPdf(event, [{ participant: p, bookings }], openItems);
}

/** Activity cards for many participants in one PDF. items: [{ participant, bookings }] */
export async function activityCardsPdf(event, items, openItems = []) {
  const doc = newDoc({ info: { Title: `${event.name} — Activity cards`, Author: event.name } });
  for (const { participant, bookings } of items) drawActivityCard(doc, event, participant, bookings, openItems);
  return toBuffer(doc);
}

/** PNG data URL of the check-in QR for showing on web pages. */
export function qrDataUrl(p) {
  return QRCode.toDataURL(checkinUrl(p), { errorCorrectionLevel: 'M', margin: 1, width: 320 });
}
