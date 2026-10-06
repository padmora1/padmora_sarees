// Tiny, dependency-free spreadsheet helpers for the "bulk update order status"
// feature: read a column of order IDs out of an .xlsx or .csv an admin uploads,
// and build the downloadable template. An .xlsx is just a zip of XML files, and
// Node ships zlib, so no npm package is needed (nothing new to install on the
// server). Only the first column of the first sheet is ever read.

const zlib = require('zlib');

const MAX_UNZIPPED = 30 * 1024 * 1024; // zip-bomb guard
const MAX_IDS = 2000;

// ---------- reading ----------

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That file is not a valid .xlsx workbook.');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error('That file is not a valid .xlsx workbook.');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    files.set(name, { method, compSize, size, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: name => files.has(name),
    names: () => [...files.keys()],
    read(name) {
      const f = files.get(name);
      if (!f) return null;
      if (f.size > MAX_UNZIPPED) throw new Error('That workbook is too large.');
      const lo = f.localOff;
      if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('That file is not a valid .xlsx workbook.');
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
      const raw = buf.subarray(start, start + f.compSize);
      if (f.method === 0) return raw.toString('utf8');
      if (f.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNZIPPED }).toString('utf8');
      throw new Error('That workbook uses an unsupported compression.');
    }
  };
}

function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function textOf(xml) {
  // Concatenate every <t> run (rich text splits one string into several),
  // ignoring phonetic <rPh> hints.
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  clean.replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g, (_, t) => { out += decodeXml(t); return ''; });
  return out;
}

function attr(attrs, name) {
  const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(attrs);
  return m ? decodeXml(m[1]) : null;
}

function loadFirstSheet(buf) {
  const zip = readZip(buf);
  const shared = [];
  const sst = zip.read('xl/sharedStrings.xml');
  if (sst) {
    sst.replace(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g, (_, inner) => { shared.push(inner ? textOf(inner) : ''); return ''; });
  }

  // Resolve the first sheet through workbook.xml + its rels; fall back to the
  // conventional path if either is missing or oddly shaped.
  let sheetPath = null;
  const wb = zip.read('xl/workbook.xml');
  const rels = zip.read('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const sm = /<sheet\b([^>]*?)\/?>/.exec(wb);
    const rid = sm ? attr(sm[1], 'r:id') : null;
    if (rid) {
      const re = /<Relationship\b([^>]*?)\/?>/g;
      let m;
      while ((m = re.exec(rels))) {
        if (attr(m[1], 'Id') === rid) {
          const target = attr(m[1], 'Target') || '';
          sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
          break;
        }
      }
    }
  }
  if (!sheetPath || !zip.has(sheetPath)) {
    sheetPath = zip.names().filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  }
  const sheet = sheetPath && zip.read(sheetPath);
  if (!sheet) throw new Error('Could not find a worksheet in that file.');

  return { shared, sheet };
}

function firstColumnFromXlsx(buf) {
  const { shared, sheet } = loadFirstSheet(buf);

  const rows = [];
  sheet.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (_, attrs, inner) => {
    const ref = attr(attrs, 'r');
    const m = ref && /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m || m[1] !== 'A' || inner == null) return '';
    const type = attr(attrs, 't');
    let value = '';
    if (type === 'inlineStr') value = textOf(inner);
    else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      if (v) {
        if (type === 's') value = shared[Number(v[1])] || '';
        else if (type === 'b' || type === 'e') value = '';
        else value = decodeXml(v[1]);
      }
    }
    rows.push({ row: Number(m[2]), value });
    return '';
  });
  return rows.sort((a, b) => a.row - b.row).map(r => r.value);
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Every cell of the first sheet as rows of strings ("" where a cell is empty), each with its row number in the file.
function tableFromXlsx(buf) {
  const { shared, sheet } = loadFirstSheet(buf);
  const byRow = new Map();
  sheet.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (_, attrs, inner) => {
    const ref = attr(attrs, 'r');
    const m = ref && /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m || inner == null) return '';
    const type = attr(attrs, 't');
    let value = '';
    if (type === 'inlineStr') value = textOf(inner);
    else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      if (v) {
        if (type === 's') value = shared[Number(v[1])] || '';
        else if (type === 'b' || type === 'e') value = '';
        else value = decodeXml(v[1]);
      }
    }
    const r = Number(m[2]);
    if (!byRow.has(r)) byRow.set(r, []);
    byRow.get(r)[colIndex(m[1])] = value;
    return '';
  });
  return [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([row, cells]) => ({ row, cells: Array.from(cells, c => c == null ? '' : c) }));
}

// RFC-4180 style: quoted cells may hold commas, quotes ("") and line breaks. The separator (comma, semicolon or tab)
// is taken from the first line, because Excel in some regions saves "CSV" with semicolons.
function tableFromCsv(buf) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const firstLine = text.split(/\r\n|\n|\r/)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of firstLine) { if (ch === '"') inQ = !inQ; else if (!inQ && ch in counts) counts[ch]++; }
  const sep = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const out = [];
  let row = [], cell = '', quoted = false, line = 1, rowLine = 1;
  const endRow = () => { row.push(cell); cell = ''; out.push({ row: rowLine, cells: row }); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else { if (ch === '\n') line++; cell += ch; }
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow(); line++; rowLine = line;
    } else cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  return out;
}

// Reads the first sheet of an .xlsx / .csv as rows of cells: [{ row, cells: [...] }], blank rows left out.
function readTable(buf, { maxRows = 5000 } = {}) {
  if (!buf || !buf.length) throw new Error('The file is empty.');
  if (buf.length > 4 && buf.readUInt32BE(0) === 0xD0CF11E0) {
    throw new Error('That is an old .xls file. In Excel choose File → Save As → "Excel Workbook (.xlsx)" or "CSV", then upload again.');
  }
  let rows;
  if (buf[0] === 0x50 && buf[1] === 0x4B) rows = tableFromXlsx(buf);
  else {
    if (buf.subarray(0, 512).includes(0)) throw new Error('That does not look like an .xlsx or .csv file.');
    rows = tableFromCsv(buf);
  }
  rows = rows.filter(r => r.cells.some(c => String(c).trim() !== ''));
  if (rows.length > maxRows) throw new Error(`That file has ${rows.length} rows — please upload at most ${maxRows} at a time.`);
  return rows;
}

function firstColumnFromCsv(buf) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text.split(/\r\n|\n|\r/).map(line => {
    line = line.trim();
    if (!line) return '';
    if (line[0] === '"') {
      const end = line.indexOf('"', 1);
      return end > 0 ? line.slice(1, end) : line.slice(1);
    }
    const cut = line.search(/[,;\t]/);
    return cut >= 0 ? line.slice(0, cut) : line;
  });
}

function normalizeOrderId(v) {
  return String(v == null ? '' : v).replace(/[​-‍﻿]/g, '').replace(/\s+/g, '').replace(/^#/, '').toUpperCase();
}

// Returns { ids, duplicates, blankRows } — IDs de-duplicated, in file order.
function readOrderIds(buf) {
  if (!buf || !buf.length) throw new Error('The file is empty.');
  let cells;
  if (buf.length > 4 && buf.readUInt32BE(0) === 0xD0CF11E0) {
    throw new Error('That is an old .xls file. In Excel choose File → Save As → "Excel Workbook (.xlsx)" or "CSV", then upload again.');
  }
  if (buf[0] === 0x50 && buf[1] === 0x4B) cells = firstColumnFromXlsx(buf);
  else {
    // Anything else must be plain text (CSV) — a binary file renamed to .csv/.xlsx would otherwise
    // be read as garbage "order IDs".
    if (buf.subarray(0, 512).includes(0)) throw new Error('That does not look like an .xlsx or .csv file.');
    cells = firstColumnFromCsv(buf);
  }

  const ids = [];
  const seen = new Set();
  let duplicates = 0;
  let headerSkipped = false;
  for (const raw of cells) {
    const id = normalizeOrderId(raw);
    if (!id) continue;
    if (!headerSkipped) {
      headerSkipped = true;
      if (['ORDERID', 'ORDERIDS', 'ORDER', 'ORDERNO', 'ORDERNUMBER', 'ID'].includes(id)) continue;
    }
    if (seen.has(id)) { duplicates++; continue; }
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > MAX_IDS) throw new Error(`That file has ${ids.length} order IDs — please upload at most ${MAX_IDS} at a time.`);
  return { ids, duplicates };
}

// ---------- writing (template) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Minimal "stored" (uncompressed) zip writer — valid for Excel/LibreOffice/Sheets.
function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const dosTime = 0, dosDate = (1 << 5) | 1; // 1980-01-01; the timestamp is irrelevant here
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, end]);
}

const NOTES = [
  'How to use this file',
  'List one order ID per row in column A, under "Order ID" (e.g. ZR12345).',
  'Only column A is read — this notes column is ignored.',
  'Then upload it in Admin → Orders → Bulk update status.'
];

function buildTemplateXlsx() {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cell = (ref, text, style) => `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t>${esc(text)}</t></is></c>`;
  const rows = NOTES.map((note, i) => `<row r="${i + 1}">${i === 0 ? cell('A1', 'Order ID', 1) : ''}${cell('C' + (i + 1), note, i === 0 ? 1 : 0)}</row>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="24" style="2" customWidth="1"/><col min="2" max="2" width="4" customWidth="1"/><col min="3" max="3" width="70" customWidth="1"/></cols><sheetData>${rows}</sheetData></worksheet>`;
  return buildZip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Order IDs" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ['xl/worksheets/sheet1.xml', sheet]
  ]);
}

function buildTemplateCsv() {
  return '﻿Order ID\r\n';
}

// ---------- Instagram orders template ----------

const INSTAGRAM_COLUMNS = [
  { key: 'date', header: 'Order Date', width: 14, required: true },
  { key: 'name', header: 'Customer Name', width: 24, required: true },
  { key: 'phone', header: 'Phone', width: 16, required: true },
  { key: 'address', header: 'Customer Address', width: 46, required: true },
  { key: 'product', header: 'Product Name', width: 30, required: true },
  { key: 'code', header: 'Product Code', width: 16, required: true },
  { key: 'payment', header: 'Payment Method', width: 18, required: true },
  { key: 'price', header: 'Price', width: 12, required: true },
  { key: 'email', header: 'Email (optional)', width: 26 },
  { key: 'city', header: 'City (optional)', width: 16 },
  { key: 'state', header: 'State (optional)', width: 16 },
  { key: 'pincode', header: 'Pincode (optional)', width: 16 }
];

const INSTAGRAM_NOTES = [
  'How to fill the Instagram Orders sheet',
  '',
  'One row = one order = one saree. Fill the sheet called "Instagram Orders" and upload it in Admin → Instagram Orders.',
  'The dark-red columns (up to Price) are required. Email, City, State and Pincode (pink) are optional.',
  '',
  'Order Date — the day the order was taken, like 05/10/2026 or 5 Oct 2026 (day first). Not a future date.',
  'Customer Name — the name on the order.',
  "Phone — the customer's mobile number. Customers use it to track the order and to raise an Order Inquiry, and the courier needs it. Add the country code (+44 …) for numbers outside India.",
  'Customer Address — the full delivery address. If it ends with a 6-digit pincode, the Pincode column is filled in for you.',
  'Product Name and Product Code — as you call the saree. These sarees need not exist in your Products list.',
  'Payment Method — one of: UPI, COD, Bank Transfer, Card, Cash, Other.',
  'Price — what the customer pays in rupees, a whole number, for example 4500 (include shipping if you charged it).',
  'Email — if given, the customer also gets the order e-mail and can log in with it to see the order in their account.',
  '',
  'Example (do not copy this row into the sheet):',
  '05/10/2026 | Anita Rao | 9876543210 | 12 MG Road, Indiranagar, Bengaluru, Karnataka 560038 | Kanjivaram silk – peacock green | KJV-204 | UPI | 8500'
];

const xmlEsc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colLetter = i => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

function buildInstagramTemplateXlsx() {
  const cols = INSTAGRAM_COLUMNS;
  const head = cols.map((c, i) => `<c r="${colLetter(i)}1" t="inlineStr" s="${c.required ? 1 : 2}"><is><t>${xmlEsc(c.header)}</t></is></c>`).join('');
  const colXml = cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"${c.key === 'price' ? '' : ' style="3"'}/>`).join('');
  const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${colXml}</cols><sheetData><row r="1" ht="22" customHeight="1">${head}</row></sheetData></worksheet>`;
  const notes = INSTAGRAM_NOTES.map((t, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"${i === 0 ? ' s="4"' : ''}><is><t>${xmlEsc(t)}</t></is></c></row>`).join('');
  const sheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="150" customWidth="1"/></cols><sheetData>${notes}</sheetData></worksheet>`;
  return buildZip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Instagram Orders" sheetId="1" r:id="rId1"/><sheet name="How to fill" sheetId="2" r:id="rId2"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    // xf 0 normal · 1 required header (white on maroon) · 2 optional header (dark on pink) · 3 text cells · 4 bold title
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF7A1F2B"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3DDE3"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ['xl/worksheets/sheet1.xml', sheet1],
    ['xl/worksheets/sheet2.xml', sheet2]
  ]);
}

function buildInstagramTemplateCsv() {
  return '﻿' + INSTAGRAM_COLUMNS.map(c => c.header).join(',') + '\r\n';
}

module.exports = { readOrderIds, buildTemplateXlsx, buildTemplateCsv, normalizeOrderId, MAX_IDS, readTable, buildInstagramTemplateXlsx, buildInstagramTemplateCsv, INSTAGRAM_COLUMNS, buildZip };
