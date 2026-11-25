// Pure-JS PDF Incremental Update attachment writer & reader for pdfstage /cast.
// Direct port of tools/assistant/ppsx/pdf_attach.go using native CompressionStream('deflate').

const asciiEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

function toAsciiBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i) & 0xff;
  }
  return out;
}

function bytesToLatin1(bytes) {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

async function runTransformStream(bytes, stream) {
  const rs = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).pipeThrough(stream);
  const reader = rs.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function deflateZlib(bytes) {
  return runTransformStream(bytes, new CompressionStream('deflate'));
}

async function inflateZlib(bytes) {
  return runTransformStream(bytes, new DecompressionStream('deflate'));
}

function isPDFWS(b) {
  return b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20;
}

function isPDFDelim(b) {
  return b === 40 || b === 41 || b === 60 || b === 62 || b === 91 || b === 93 || b === 123 || b === 125 || b === 47 || b === 37;
}

function hasPrefix(data, pos, ascii) {
  if (pos + ascii.length > data.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (data[pos + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

function indexOfAscii(data, needleStr, from = 0) {
  const n = toAsciiBytes(needleStr);
  const limit = data.length - n.length;
  outer: for (let i = from; i <= limit; i++) {
    for (let j = 0; j < n.length; j++) {
      if (data[i + j] !== n[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function lastIndexOfAscii(data, needleStr, from = 0) {
  const n = toAsciiBytes(needleStr);
  outer: for (let i = data.length - n.length; i >= from; i--) {
    for (let j = 0; j < n.length; j++) {
      if (data[i + j] !== n[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function decodePDFName(raw) {
  if (!raw.includes('#')) return raw;
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '#' && i + 2 < raw.length) {
      const hex = raw.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(raw.charCodeAt(i) & 0xff);
  }
  return bytesToLatin1(new Uint8Array(bytes));
}

function escapePDFName(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i) & 0xff;
    if (c < 0x21 || c > 0x7e || c === 0x23 || isPDFDelim(c)) {
      out += `#${c.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      out += String.fromCharCode(c);
    }
  }
  return out;
}

function encodePDFStringASCII(str) {
  let out = '(';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 0x5c || c === 0x28 || c === 0x29) {
      out += '\\' + String.fromCharCode(c);
    } else if (c === 0x0a) {
      out += '\\n';
    } else if (c === 0x0d) {
      out += '\\r';
    } else if (c >= 0x20 && c <= 0x7e) {
      out += String.fromCharCode(c);
    } else {
      out += '_';
    }
  }
  return out + ')';
}

function encodePDFStringUnicode(str) {
  let pureASCII = true;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      pureASCII = false;
      break;
    }
  }
  if (pureASCII) return encodePDFStringASCII(str);
  let hex = '<FEFF';
  for (let i = 0; i < str.length; i++) {
    hex += str.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  }
  return hex + '>';
}

function decodePDFRawBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const codeUnits = [];
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      codeUnits.push((bytes[i] << 8) | bytes[i + 1]);
    }
    return String.fromCharCode(...codeUnits);
  }
  // If valid UTF-8 with multibyte sequences, decode as UTF-8, else Latin-1.
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return bytesToLatin1(bytes);
  }
}

function decodePDFStringVal(val) {
  if (!val) return '';
  if (val.kind === 'hex') {
    const inner = val.raw.slice(1, -1).replace(/[\s\0]/g, '');
    const padded = inner.length % 2 === 1 ? inner + '0' : inner;
    const out = new Uint8Array(padded.length / 2);
    for (let i = 0; i < out.length; i++) {
      const byteVal = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(byteVal)) return '';
      out[i] = byteVal;
    }
    return decodePDFRawBytes(out);
  }
  if (val.kind === 'string') {
    let raw = val.raw;
    if (raw.length >= 2 && raw[0] === '(' && raw[raw.length - 1] === ')') {
      raw = raw.slice(1, -1);
    }
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch !== '\\') {
        out.push(raw.charCodeAt(i) & 0xff);
        continue;
      }
      i++;
      if (i >= raw.length) break;
      const esc = raw[i];
      if (esc === 'n') out.push(0x0a);
      else if (esc === 'r') out.push(0x0d);
      else if (esc === 't') out.push(0x09);
      else if (esc === 'b') out.push(0x08);
      else if (esc === 'f') out.push(0x0c);
      else if (esc === '\r') {
        if (i + 1 < raw.length && raw[i + 1] === '\n') i++;
      } else if (esc === '\n') {
        // escaped line break ignored
      } else if (esc === '(' || esc === ')' || esc === '\\') {
        out.push(esc.charCodeAt(0));
      } else if (esc >= '0' && esc <= '7') {
        let oct = esc;
        for (let k = 0; k < 2 && i + 1 < raw.length && raw[i + 1] >= '0' && raw[i + 1] <= '7'; k++) {
          i++;
          oct += raw[i];
        }
        out.push(parseInt(oct, 8) & 0xff);
      } else {
        out.push(esc.charCodeAt(0) & 0xff);
      }
    }
    return decodePDFRawBytes(new Uint8Array(out));
  }
  return val.raw || '';
}

function serializePDFVal(val) {
  switch (val.kind) {
    case 'null': return 'null';
    case 'bool':
    case 'int':
    case 'real':
    case 'string':
    case 'hex':
    case 'ref':
      return val.raw;
    case 'name':
      return '/' + escapePDFName(val.raw);
    case 'array':
      return '[' + val.items.map(serializePDFVal).join(' ') + ']';
    case 'dict':
      return '<<' + val.dict.map((kv) => ` /${escapePDFName(kv.key)} ${serializePDFVal(kv.val)}`).join('') + ' >>';
    default:
      return val.raw || 'null';
  }
}

function dictGet(val, key) {
  if (!val || !val.dict) return undefined;
  for (const kv of val.dict) {
    if (kv.key === key) return kv.val;
  }
  return undefined;
}

class PDFParser {
  constructor(data, pos, idx) {
    this.data = data;
    this.pos = pos;
    this.idx = idx;
  }

  skipWS() {
    while (this.pos < this.data.length) {
      const b = this.data[this.pos];
      if (isPDFWS(b)) {
        this.pos++;
        continue;
      }
      if (b === 0x25) { // % comment
        while (this.pos < this.data.length && this.data[this.pos] !== 0x0a && this.data[this.pos] !== 0x0d) {
          this.pos++;
        }
        continue;
      }
      break;
    }
  }

  readWord() {
    this.skipWS();
    const start = this.pos;
    while (this.pos < this.data.length && !isPDFWS(this.data[this.pos]) && !isPDFDelim(this.data[this.pos])) {
      this.pos++;
    }
    return bytesToLatin1(this.data.subarray(start, this.pos));
  }

  readInt() {
    const saved = this.pos;
    const w = this.readWord();
    if (/^[+-]?\d+$/.test(w)) {
      const v = Number(w);
      if (Number.isSafeInteger(v)) return v;
    }
    this.pos = saved;
    return null;
  }

  async parseIndirectObj() {
    const objNum = this.readInt();
    const gen = this.readInt();
    const kw = this.readWord();
    if (objNum === null || gen === null || kw !== 'obj') {
      throw new Error(`Erwartet '<n> <g> obj' bei Offset ${this.pos}`);
    }
    const val = this.parseValue();
    if (val.kind === 'dict') {
      const saved = this.pos;
      if (this.readWord() === 'stream') {
        if (this.pos < this.data.length && this.data[this.pos] === 0x0d) this.pos++;
        if (this.pos < this.data.length && this.data[this.pos] === 0x0a) this.pos++;
        const streamBytes = await this.readStreamBytes(val);
        return { objNum, val: { kind: 'stream', dict: val.dict, stream: streamBytes } };
      }
      this.pos = saved;
    }
    return { objNum, val };
  }

  async readStreamBytes(dictVal) {
    let length = -1;
    const lv = dictGet(dictVal, 'Length');
    if (lv) {
      if (lv.kind === 'int') {
        length = lv.intVal;
      } else if (lv.kind === 'ref' && this.idx) {
        try {
          const resolved = await this.idx.resolveObject(lv.objNum);
          if (resolved && resolved.kind === 'int') length = resolved.intVal;
        } catch { /* fallback below */ }
      }
    }
    if (length >= 0 && this.pos + length <= this.data.length) {
      const b = this.data.subarray(this.pos, this.pos + length);
      this.pos += length;
      return b;
    }
    const endIdx = indexOfAscii(this.data, 'endstream', this.pos);
    if (endIdx < 0) {
      throw new Error('endstream nicht gefunden');
    }
    let end = endIdx;
    while (end > this.pos && (this.data[end - 1] === 0x0a || this.data[end - 1] === 0x0d)) {
      end--;
    }
    const b = this.data.subarray(this.pos, end);
    this.pos = endIdx + 9;
    return b;
  }

  parseValue() {
    this.skipWS();
    if (this.pos >= this.data.length) {
      throw new Error('Unerwartetes PDF-Ende');
    }
    const b = this.data[this.pos];
    if (b === 0x3c && this.pos + 1 < this.data.length && this.data[this.pos + 1] === 0x3c) {
      return this.parseDict();
    }
    if (b === 0x3c) return this.parseHexString();
    if (b === 0x28) return this.parseLiteralString();
    if (b === 0x5b) return this.parseArray();
    if (b === 0x2f) return this.parseName();

    const start = this.pos;
    const w = this.readWord();
    if (!w) {
      throw new Error(`Unerwartetes Zeichen ${b} bei Offset ${this.pos}`);
    }
    if (w === 'true' || w === 'false') return { kind: 'bool', raw: w };
    if (w === 'null') return { kind: 'null', raw: 'null' };
    if (/^[+-]?\d+$/.test(w)) {
      const iv = Number(w);
      const saved = this.pos;
      const gen = this.readInt();
      if (gen !== null && this.readWord() === 'R') {
        return { kind: 'ref', objNum: iv, genNum: gen, raw: `${iv} ${gen} R` };
      }
      this.pos = saved;
      return { kind: 'int', intVal: iv, raw: w };
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(w)) {
      return { kind: 'real', raw: w };
    }
    return { kind: 'null', raw: bytesToLatin1(this.data.subarray(start, this.pos)) };
  }

  parseDict() {
    this.pos += 2;
    const dict = [];
    for (;;) {
      this.skipWS();
      if (this.pos + 1 < this.data.length && this.data[this.pos] === 0x3e && this.data[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return { kind: 'dict', dict };
      }
      const kVal = this.parseValue();
      if (kVal.kind !== 'name') {
        throw new Error(`Erwartet Dictionary-Key als Name, bekam ${kVal.raw}`);
      }
      const vVal = this.parseValue();
      dict.push({ key: kVal.raw, val: vVal });
    }
  }

  parseArray() {
    this.pos++;
    const items = [];
    for (;;) {
      this.skipWS();
      if (this.pos >= this.data.length) throw new Error('Nicht geschlossenes Array');
      if (this.data[this.pos] === 0x5d) {
        this.pos++;
        return { kind: 'array', items };
      }
      items.push(this.parseValue());
    }
  }

  parseName() {
    this.pos++;
    const start = this.pos;
    while (this.pos < this.data.length && !isPDFWS(this.data[this.pos]) && !isPDFDelim(this.data[this.pos])) {
      this.pos++;
    }
    const raw = bytesToLatin1(this.data.subarray(start, this.pos));
    return { kind: 'name', raw: decodePDFName(raw) };
  }

  parseLiteralString() {
    const start = this.pos;
    this.pos++;
    let depth = 1;
    while (this.pos < this.data.length && depth > 0) {
      const c = this.data[this.pos++];
      if (c === 0x5c) {
        if (this.pos < this.data.length) this.pos++;
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29) depth--;
    }
    return { kind: 'string', raw: bytesToLatin1(this.data.subarray(start, this.pos)) };
  }

  parseHexString() {
    const start = this.pos;
    this.pos++;
    while (this.pos < this.data.length && this.data[this.pos] !== 0x3e) {
      this.pos++;
    }
    if (this.pos < this.data.length) this.pos++;
    return { kind: 'hex', raw: bytesToLatin1(this.data.subarray(start, this.pos)) };
  }

  parseClassicXRef(idx) {
    for (;;) {
      this.skipWS();
      if (hasPrefix(this.data, this.pos, 'trailer')) return;
      const startObj = this.readInt();
      const count = this.readInt();
      if (startObj === null || count === null) {
        throw new Error('Ungültige klassische xref-Sektion');
      }
      for (let i = 0; i < count; i++) {
        const objNum = startObj + i;
        const off = this.readInt();
        const gen = this.readInt();
        if (off === null || gen === null) {
          throw new Error(`xref-Eintrag ${objNum} defekt`);
        }
        this.skipWS();
        if (this.pos >= this.data.length) {
          throw new Error(`xref-Eintrag ${objNum}: Typ fehlt`);
        }
        const flag = String.fromCharCode(this.data[this.pos++]);
        if (!idx.entries.has(objNum)) {
          idx.entries.set(objNum, { typ: flag === 'n' ? 1 : 0, f1: off, f2: gen });
        }
        if (objNum + 1 > idx.maxObjNum) {
          idx.maxObjNum = objNum + 1;
        }
      }
    }
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function applyPredictor(data, predictor, cols) {
  if (predictor === 2) {
    const out = new Uint8Array(data);
    for (let row = 0; row + cols <= out.length; row += cols) {
      for (let c = 1; c < cols; c++) {
        out[row + c] = (out[row + c] + out[row + c - 1]) & 0xff;
      }
    }
    return out;
  }
  if (predictor < 10 || predictor > 15) {
    throw new Error(`Nicht unterstützter PDF-Predictor ${predictor}`);
  }
  const rowStride = cols + 1;
  if (data.length % rowStride !== 0) {
    throw new Error(`PNG-Predictor: Datenlänge ${data.length} kein Vielfaches von ${rowStride}`);
  }
  const numRows = data.length / rowStride;
  const out = new Uint8Array(numRows * cols);
  const prev = new Uint8Array(cols);
  for (let r = 0; r < numRows; r++) {
    const filterType = data[r * rowStride];
    const srcOff = r * rowStride + 1;
    const dstOff = r * cols;
    switch (filterType) {
      case 0:
        out.set(data.subarray(srcOff, srcOff + cols), dstOff);
        break;
      case 1:
        for (let c = 0; c < cols; c++) {
          const left = c > 0 ? out[dstOff + c - 1] : 0;
          out[dstOff + c] = (data[srcOff + c] + left) & 0xff;
        }
        break;
      case 2:
        for (let c = 0; c < cols; c++) {
          out[dstOff + c] = (data[srcOff + c] + prev[c]) & 0xff;
        }
        break;
      case 3:
        for (let c = 0; c < cols; c++) {
          const left = c > 0 ? out[dstOff + c - 1] : 0;
          out[dstOff + c] = (data[srcOff + c] + ((left + prev[c]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let c = 0; c < cols; c++) {
          const left = c > 0 ? out[dstOff + c - 1] : 0;
          const upLeft = c > 0 ? prev[c - 1] : 0;
          out[dstOff + c] = (data[srcOff + c] + paeth(left, prev[c], upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error(`Unbekannter PNG-Filtertyp ${filterType}`);
    }
    prev.set(out.subarray(dstOff, dstOff + cols));
  }
  return out;
}

async function decodePDFStream(streamObj) {
  if (!streamObj || streamObj.kind !== 'stream') {
    throw new Error('Kein PDF-Stream');
  }
  let data = streamObj.stream;
  const filters = [];
  const fVal = dictGet(streamObj, 'Filter');
  if (fVal) {
    if (fVal.kind === 'name') filters.push(fVal.raw);
    else if (fVal.kind === 'array') {
      for (const it of fVal.items) {
        if (it.kind === 'name') filters.push(it.raw);
      }
    }
  }
  for (const flt of filters) {
    if (flt === 'FlateDecode' || flt === 'Fl') {
      data = await inflateZlib(data);
    } else {
      throw new Error(`Nicht unterstützter PDF-Filter /${flt}`);
    }
  }
  let dp = dictGet(streamObj, 'DecodeParms');
  if (dp && dp.kind === 'array' && dp.items.length > 0) {
    dp = dp.items[0];
  }
  if (dp && dp.kind === 'dict') {
    const predVal = dictGet(dp, 'Predictor');
    if (predVal && predVal.kind === 'int' && predVal.intVal > 1) {
      const cVal = dictGet(dp, 'Columns');
      const cols = cVal && cVal.kind === 'int' && cVal.intVal > 0 ? cVal.intVal : 1;
      data = applyPredictor(data, predVal.intVal, cols);
    }
  }
  return data;
}

function readBEUint(bytes, offset, len) {
  let v = 0;
  for (let i = 0; i < len; i++) {
    v = v * 256 + bytes[offset + i];
  }
  return v;
}

function findLastStartXRef(data) {
  let searchFrom = data.length > 4096 ? data.length - 4096 : 0;
  let pos = lastIndexOfAscii(data, 'startxref', searchFrom);
  if (pos < 0) {
    pos = lastIndexOfAscii(data, 'startxref', 0);
    if (pos < 0) throw new Error('Kein startxref im PDF gefunden — ist das eine gültige PDF-Datei?');
  }
  pos += 9;
  while (pos < data.length && isPDFWS(data[pos])) pos++;
  const start = pos;
  while (pos < data.length && data[pos] >= 0x30 && data[pos] <= 0x39) pos++;
  if (pos === start) throw new Error('startxref-Offset fehlt');
  return Number(bytesToLatin1(data.subarray(start, pos)));
}

async function applyXRefStream(streamObj, idx) {
  const sizeVal = dictGet(streamObj, 'Size');
  if (!sizeVal || sizeVal.kind !== 'int') throw new Error('XRef-Stream ohne /Size');
  const size = sizeVal.intVal;
  if (size > idx.maxObjNum) idx.maxObjNum = size;

  const wVal = dictGet(streamObj, 'W');
  if (!wVal || wVal.kind !== 'array' || wVal.items.length !== 3) {
    throw new Error('XRef-Stream ohne gültiges /W');
  }
  const w = [wVal.items[0].intVal, wVal.items[1].intVal, wVal.items[2].intVal];
  const rowLen = w[0] + w[1] + w[2];
  if (rowLen <= 0) throw new Error('XRef-Stream /W-Summe ist 0');

  const raw = await decodePDFStream(streamObj);
  const pairs = [];
  const idxArr = dictGet(streamObj, 'Index');
  if (idxArr && idxArr.kind === 'array' && idxArr.items.length >= 2) {
    for (let i = 0; i + 1 < idxArr.items.length; i += 2) {
      pairs.push([idxArr.items[i].intVal, idxArr.items[i + 1].intVal]);
    }
  } else {
    pairs.push([0, size]);
  }

  let pos = 0;
  for (const [start, count] of pairs) {
    for (let i = 0; i < count; i++) {
      if (pos + rowLen > raw.length) {
        throw new Error(`XRef-Stream zu kurz (${raw.length} < ${pos + rowLen})`);
      }
      const typ = w[0] > 0 ? readBEUint(raw, pos, w[0]) : 1;
      const f1 = readBEUint(raw, pos + w[0], w[1]);
      const f2 = readBEUint(raw, pos + w[0] + w[1], w[2]);
      pos += rowLen;
      const objNum = start + i;
      if (!idx.entries.has(objNum)) {
        idx.entries.set(objNum, { typ, f1, f2 });
      }
      if (objNum + 1 > idx.maxObjNum) idx.maxObjNum = objNum + 1;
    }
  }
}

class PDFDocIndex {
  constructor(data, firstXRefOffset) {
    this.data = data;
    this.entries = new Map();
    this.objStmCache = new Map();
    this.rootObjNum = 0;
    this.infoRef = null;
    this.idVal = null;
    this.maxObjNum = 0;
    this.firstXRefOffset = firstXRefOffset;
    this.usesXRefStream = false;
  }

  captureTrailer(tr) {
    const sz = dictGet(tr, 'Size');
    if (sz && sz.kind === 'int' && sz.intVal > this.maxObjNum) {
      this.maxObjNum = sz.intVal;
    }
    if (this.rootObjNum === 0) {
      const root = dictGet(tr, 'Root');
      if (root && root.kind === 'ref') {
        this.rootObjNum = root.objNum;
        if (root.objNum + 1 > this.maxObjNum) this.maxObjNum = root.objNum + 1;
      }
    }
    if (!this.infoRef) {
      const info = dictGet(tr, 'Info');
      if (info && info.kind === 'ref') this.infoRef = info;
    }
    if (!this.idVal) {
      const idv = dictGet(tr, 'ID');
      if (idv && idv.kind === 'array') this.idVal = idv;
    }
  }

  async resolveValue(val) {
    if (!val || val.kind !== 'ref') return val;
    return this.resolveObject(val.objNum);
  }

  async resolveObject(objNum) {
    const ent = this.entries.get(objNum);
    if (!ent) throw new Error(`Objekt ${objNum} nicht in xref`);
    if (ent.typ === 0) return { kind: 'null', raw: 'null' };
    if (ent.typ === 1) {
      const p = new PDFParser(this.data, ent.f1, this);
      const { val } = await p.parseIndirectObj();
      return val;
    }
    if (ent.typ === 2) {
      const stmNum = ent.f1;
      let objs = this.objStmCache.get(stmNum);
      if (!objs) {
        objs = await this.loadObjStm(stmNum);
        this.objStmCache.set(stmNum, objs);
      }
      const slice = objs.get(objNum);
      if (!slice) throw new Error(`Objekt ${objNum} fehlt in /ObjStm ${stmNum}`);
      const p = new PDFParser(slice, 0, this);
      return p.parseValue();
    }
    throw new Error(`Unbekannter xref-Typ ${ent.typ} für Objekt ${objNum}`);
  }

  async loadObjStm(stmNum) {
    const stmVal = await this.resolveObject(stmNum);
    if (!stmVal || stmVal.kind !== 'stream') throw new Error(`Objekt ${stmNum} ist kein /ObjStm`);
    const nVal = dictGet(stmVal, 'N');
    const firstVal = dictGet(stmVal, 'First');
    if (!nVal || nVal.kind !== 'int' || !firstVal || firstVal.kind !== 'int') {
      throw new Error(`/ObjStm ${stmNum} ohne /N oder /First`);
    }
    const decoded = await decodePDFStream(stmVal);
    const n = nVal.intVal;
    const first = firstVal.intVal;
    if (first > decoded.length) {
      throw new Error(`/ObjStm ${stmNum} /First (${first}) > Länge (${decoded.length})`);
    }
    const hp = new PDFParser(decoded.subarray(0, first), 0, null);
    const pairs = [];
    for (let i = 0; i < n; i++) {
      const id = hp.readInt();
      const rel = hp.readInt();
      if (id === null || rel === null) throw new Error(`/ObjStm ${stmNum} Header defekt`);
      pairs.push([id, rel]);
    }
    const out = new Map();
    for (let i = 0; i < pairs.length; i++) {
      const [id, relOff] = pairs[i];
      const start = first + relOff;
      const end = i + 1 < pairs.length && first + pairs[i + 1][1] <= decoded.length
        ? first + pairs[i + 1][1]
        : decoded.length;
      if (start >= 0 && start <= end && end <= decoded.length) {
        out.set(id, decoded.subarray(start, end));
      }
    }
    return out;
  }
}

async function parsePDFIndex(data) {
  const startXRef = findLastStartXRef(data);
  const idx = new PDFDocIndex(data, startXRef);
  const visited = new Set();
  let offset = startXRef;
  let first = true;

  while (offset > 0 && !visited.has(offset)) {
    visited.add(offset);
    if (offset >= data.length) {
      throw new Error(`startxref-Offset ${offset} außerhalb der Datei (${data.length} Bytes)`);
    }
    const p = new PDFParser(data, offset, idx);
    p.skipWS();
    let isStreamXRef = false;
    let trailerDict;

    if (hasPrefix(data, p.pos, 'xref')) {
      p.pos += 4;
      p.parseClassicXRef(idx);
      p.skipWS();
      if (!hasPrefix(data, p.pos, 'trailer')) {
        throw new Error("Erwartet 'trailer' nach klassischer xref-Tabelle");
      }
      p.pos += 7;
      trailerDict = p.parseValue();
      if (trailerDict.kind !== 'dict') throw new Error('trailer-Dictionary ungültig');
    } else {
      isStreamXRef = true;
      const { val } = await p.parseIndirectObj();
      if (val.kind !== 'stream') throw new Error(`Objekt bei Offset ${offset} ist kein XRef-Stream`);
      await applyXRefStream(val, idx);
      trailerDict = { kind: 'dict', dict: val.dict };
    }

    if (first) {
      idx.usesXRefStream = isStreamXRef;
      first = false;
    }
    idx.captureTrailer(trailerDict);

    const xstm = dictGet(trailerDict, 'XRefStm');
    if (xstm && xstm.kind === 'int' && xstm.intVal > 0 && !visited.has(xstm.intVal)) {
      visited.add(xstm.intVal);
      try {
        const xp = new PDFParser(data, xstm.intVal, idx);
        const { val: xobj } = await xp.parseIndirectObj();
        if (xobj.kind === 'stream') await applyXRefStream(xobj, idx);
      } catch { /* non-fatal hybrid fallback */ }
    }

    const prev = dictGet(trailerDict, 'Prev');
    if (prev && prev.kind === 'int' && prev.intVal > 0) {
      offset = prev.intVal;
    } else {
      break;
    }
  }
  return idx;
}

/**
 * Returns the integer page count of a PDF (or null if unavailable).
 */
export async function getPdfPageCount(pdfBytes) {
  try {
    const idx = await parsePDFIndex(pdfBytes);
    if (idx.rootObjNum <= 0) return null;
    const cat = await idx.resolveObject(idx.rootObjNum);
    const pagesRaw = dictGet(cat, 'Pages');
    if (!pagesRaw) return null;
    const pages = await idx.resolveValue(pagesRaw);
    const count = dictGet(pages, 'Count');
    return count && count.kind === 'int' ? count.intVal : null;
  } catch {
    return null;
  }
}

async function collectEmbeddedFiles(idx, nodeVal, out, visited) {
  if (!nodeVal) return;
  if (nodeVal.kind === 'ref') {
    if (visited.has(nodeVal.objNum)) return;
    visited.add(nodeVal.objNum);
  }
  const node = await idx.resolveValue(nodeVal);
  if (!node || node.kind !== 'dict') return;

  const namesArr = dictGet(node, 'Names');
  if (namesArr) {
    const resolvedArr = await idx.resolveValue(namesArr);
    if (resolvedArr && resolvedArr.kind === 'array') {
      for (let i = 0; i + 1 < resolvedArr.items.length; i += 2) {
        const keyName = decodePDFStringVal(resolvedArr.items[i]);
        const fsVal = await idx.resolveValue(resolvedArr.items[i + 1]);
        if (!fsVal || fsVal.kind !== 'dict') continue;
        let fileName = keyName;
        const uf = dictGet(fsVal, 'UF');
        const f = dictGet(fsVal, 'F');
        if (uf) {
          const s = decodePDFStringVal(uf);
          if (s) fileName = s;
        } else if (f) {
          const s = decodePDFStringVal(f);
          if (s) fileName = s;
        }
        const efDictRaw = dictGet(fsVal, 'EF');
        if (!efDictRaw) continue;
        const efDict = await idx.resolveValue(efDictRaw);
        if (!efDict || efDict.kind !== 'dict') continue;
        const streamRef = dictGet(efDict, 'UF') || dictGet(efDict, 'F');
        if (!streamRef) continue;
        const streamObj = await idx.resolveValue(streamRef);
        if (!streamObj || streamObj.kind !== 'stream') continue;
        out.set(fileName, await decodePDFStream(streamObj));
      }
    }
  }

  const kidsArr = dictGet(node, 'Kids');
  if (kidsArr) {
    const resolvedKids = await idx.resolveValue(kidsArr);
    if (resolvedKids && resolvedKids.kind === 'array') {
      for (const kid of resolvedKids.items) {
        await collectEmbeddedFiles(idx, kid, out, visited);
      }
    }
  }
}

/**
 * Reads all /EmbeddedFiles attachments from a PDF as a Map<string, Uint8Array>.
 */
export async function readPdfAttachments(pdfBytes) {
  const out = new Map();
  if (!pdfBytes || pdfBytes.length === 0) throw new Error('PDF ist leer');
  const idx = await parsePDFIndex(pdfBytes);
  if (idx.rootObjNum <= 0) return out;
  const catVal = await idx.resolveObject(idx.rootObjNum);
  if (!catVal || catVal.kind !== 'dict') return out;
  const namesRaw = dictGet(catVal, 'Names');
  if (!namesRaw) return out;
  const namesDict = await idx.resolveValue(namesRaw);
  if (!namesDict || namesDict.kind !== 'dict') return out;
  const efRaw = dictGet(namesDict, 'EmbeddedFiles');
  if (!efRaw) return out;
  await collectEmbeddedFiles(idx, efRaw, out, new Set());
  return out;
}

class ByteBuilder {
  constructor() {
    this.parts = [];
    this.length = 0;
  }
  pushBytes(u8) {
    if (!u8 || u8.length === 0) return;
    this.parts.push(u8);
    this.length += u8.length;
  }
  pushAscii(str) {
    if (!str) return;
    this.pushBytes(asciiEncoder.encode(str));
  }
  toUint8Array() {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

function writeXRefRow(buf, idx, typ, f1, f2, offsetBytes) {
  buf[idx] = typ;
  // Write f1 big-endian into offsetBytes bytes (handles >4GB too if needed).
  let v = f1;
  for (let i = offsetBytes - 1; i >= 0; i--) {
    buf[idx + 1 + i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  buf[idx + 1 + offsetBytes] = f2 & 0xff;
}

/**
 * Attaches files via PDF Incremental Update without altering the original PDF prefix bytes.
 * @param {Uint8Array} pdfBytes
 * @param {Array<{name: string, mime?: string, description?: string, data: Uint8Array, compress?: boolean}>} files
 */
export async function attachFilesToPdf(pdfBytes, files) {
  if (!pdfBytes || pdfBytes.length === 0) throw new Error('PDF ist leer');
  const idx = await parsePDFIndex(pdfBytes);
  if (idx.rootObjNum <= 0) throw new Error('PDF hat keinen /Root-Catalog');

  const catVal = await idx.resolveObject(idx.rootObjNum);
  if (!catVal || catVal.kind !== 'dict') {
    throw new Error(`/Catalog (${idx.rootObjNum} 0 obj) ist kein Dictionary`);
  }

  const existingNamesDict = [];
  const namesRaw = dictGet(catVal, 'Names');
  if (namesRaw) {
    try {
      const namesResolved = await idx.resolveValue(namesRaw);
      if (namesResolved && namesResolved.kind === 'dict') {
        for (const kv of namesResolved.dict) {
          if (kv.key !== 'EmbeddedFiles') existingNamesDict.push(kv);
        }
      }
    } catch { /* keep going */ }
  }

  const sortedFiles = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const out = new ByteBuilder();
  out.pushBytes(pdfBytes);
  const lastByte = pdfBytes[pdfBytes.length - 1];
  if (lastByte !== 0x0a && lastByte !== 0x0d) {
    out.pushAscii('\n');
  }

  let nextObj = idx.maxObjNum;
  if (nextObj <= idx.rootObjNum) nextObj = idx.rootObjNum + 1;
  const firstNewObj = nextObj;
  const newOffsets = new Map();
  const attached = [];

  for (const f of sortedFiles) {
    const efObj = nextObj++;
    const fsObj = nextObj++;

    let payload = f.data;
    let compressed = false;
    if (f.compress) {
      try {
        payload = await deflateZlib(f.data);
        compressed = true;
      } catch {
        payload = f.data;
        compressed = false;
      }
    }

    newOffsets.set(efObj, out.length);
    let efHdr = `${efObj} 0 obj\n<< /Type /EmbeddedFile`;
    if (f.mime) efHdr += ` /Subtype /${escapePDFName(f.mime)}`;
    if (compressed) efHdr += ' /Filter /FlateDecode';
    efHdr += ` /Length ${payload.length} /Params << /Size ${f.data.length} >> >>\nstream\n`;
    out.pushAscii(efHdr);
    out.pushBytes(payload);
    out.pushAscii('\nendstream\nendobj\n');

    newOffsets.set(fsObj, out.length);
    const fStr = encodePDFStringASCII(f.name);
    const ufStr = encodePDFStringUnicode(f.name);
    let fsBody = `${fsObj} 0 obj\n<< /Type /Filespec /F ${fStr} /UF ${ufStr} /EF << /F ${efObj} 0 R /UF ${efObj} 0 R >>`;
    if (f.description) fsBody += ` /Desc ${encodePDFStringUnicode(f.description)}`;
    fsBody += ' >>\nendobj\n';
    out.pushAscii(fsBody);

    attached.push({ name: f.name, filespecObj: fsObj });
  }

  const efTreeObj = nextObj++;
  newOffsets.set(efTreeObj, out.length);
  const treeEntries = attached.map((a) => `${encodePDFStringUnicode(a.name)} ${a.filespecObj} 0 R`).join(' ');
  out.pushAscii(`${efTreeObj} 0 obj\n<< /Names [${treeEntries}] >>\nendobj\n`);

  const namesObj = nextObj++;
  newOffsets.set(namesObj, out.length);
  const extraNames = existingNamesDict.map((kv) => ` /${escapePDFName(kv.key)} ${serializePDFVal(kv.val)}`).join('');
  out.pushAscii(`${namesObj} 0 obj\n<<${extraNames} /EmbeddedFiles ${efTreeObj} 0 R >>\nendobj\n`);

  newOffsets.set(idx.rootObjNum, out.length);
  const catEntries = catVal.dict
    .filter((kv) => kv.key !== 'Names')
    .map((kv) => ` /${escapePDFName(kv.key)} ${serializePDFVal(kv.val)}`)
    .join('');
  out.pushAscii(`${idx.rootObjNum} 0 obj\n<<${catEntries} /Names ${namesObj} 0 R >>\nendobj\n`);

  const countNew = nextObj - firstNewObj;

  if (idx.usesXRefStream) {
    const xrefObj = nextObj++;
    const xrefOffset = out.length;
    newOffsets.set(xrefObj, xrefOffset);

    const totalNew = countNew + 1;
    const offsetBytes = xrefOffset > 0xffffffff ? 6 : 4;
    const rowLen = 2 + offsetBytes;
    const xstream = new Uint8Array((1 + totalNew) * rowLen);
    writeXRefRow(xstream, 0, 1, newOffsets.get(idx.rootObjNum), 0, offsetBytes);
    for (let obj = firstNewObj, rowIdx = 1; obj < nextObj; obj++, rowIdx++) {
      writeXRefRow(xstream, rowIdx * rowLen, 1, newOffsets.get(obj), 0, offsetBytes);
    }

    let xHdr = `${xrefObj} 0 obj\n<< /Type /XRef /Size ${nextObj} /W [1 ${offsetBytes} 1] /Index [${idx.rootObjNum} 1 ${firstNewObj} ${totalNew}] /Root ${idx.rootObjNum} 0 R /Prev ${idx.firstXRefOffset}`;
    if (idx.infoRef) xHdr += ` /Info ${serializePDFVal(idx.infoRef)}`;
    if (idx.idVal) xHdr += ` /ID ${serializePDFVal(idx.idVal)}`;
    xHdr += ` /Length ${xstream.length} >>\nstream\n`;
    out.pushAscii(xHdr);
    out.pushBytes(xstream);
    out.pushAscii(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`);
  } else {
    const xrefOffset = out.length;
    let xTxt = 'xref\n';
    xTxt += `${idx.rootObjNum} 1\n`;
    xTxt += `${String(newOffsets.get(idx.rootObjNum)).padStart(10, '0')} 00000 n \n`;
    xTxt += `${firstNewObj} ${countNew}\n`;
    for (let obj = firstNewObj; obj < nextObj; obj++) {
      xTxt += `${String(newOffsets.get(obj)).padStart(10, '0')} 00000 n \n`;
    }
    xTxt += `trailer\n<< /Size ${nextObj} /Root ${idx.rootObjNum} 0 R /Prev ${idx.firstXRefOffset}`;
    if (idx.infoRef) xTxt += ` /Info ${serializePDFVal(idx.infoRef)}`;
    if (idx.idVal) xTxt += ` /ID ${serializePDFVal(idx.idVal)}`;
    xTxt += ` >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    out.pushAscii(xTxt);
  }

  return out.toUint8Array();
}
