// Pure-JS PDF Incremental Update attachment writer & reader for pdfstage /cast.
// Direct port of tools/assistant/ppsx/pdf_attach.go using native CompressionStream('deflate').

const asciiEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

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

  parseClassicXRef(idx, revMap = null) {
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
        const ent = { typ: flag === 'n' ? 1 : 0, f1: off, f2: gen };
        if (!idx.entries.has(objNum)) {
          idx.entries.set(objNum, ent);
        }
        if (revMap && !revMap.has(objNum)) {
          revMap.set(objNum, ent);
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

async function applyXRefStream(streamObj, idx, revMap = null) {
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
      const ent = { typ, f1, f2 };
      if (!idx.entries.has(objNum)) {
        idx.entries.set(objNum, ent);
      }
      if (revMap && !revMap.has(objNum)) {
        revMap.set(objNum, ent);
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
    this.revisions = [];
    this.hasEncrypt = false;
    this.rootObjNum = 0;
    this.infoRef = null;
    this.idVal = null;
    this.maxObjNum = 0;
    this.firstXRefOffset = firstXRefOffset;
    this.usesXRefStream = false;
  }

  captureTrailer(tr) {
    if (dictGet(tr, 'Encrypt')) {
      this.hasEncrypt = true;
    }
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

function findRevEndOffset(data, afterPos) {
  const eofPos = indexOfAscii(data, '%%EOF', Math.max(0, afterPos));
  if (eofPos < 0) return 0;
  let end = eofPos + 5;
  if (end < data.length && data[end] === 0x0d) end++;
  if (end < data.length && data[end] === 0x0a) end++;
  return end;
}

async function parsePDFIndex(data) {
  const startXRef = findLastStartXRef(data);
  const idx = new PDFDocIndex(data, startXRef);
  const visited = new Set();
  const rawRevs = [];
  let offset = startXRef;
  let first = true;

  while (offset > 0 && !visited.has(offset)) {
    visited.add(offset);
    if (offset >= data.length) {
      throw new Error(`startxref-Offset ${offset} außerhalb der Datei (${data.length} Bytes)`);
    }
    const revMap = new Map();
    const p = new PDFParser(data, offset, idx);
    p.skipWS();
    let isStreamXRef = false;
    let xrefObjNum = 0;
    let trailerDict;

    if (hasPrefix(data, p.pos, 'xref')) {
      p.pos += 4;
      p.parseClassicXRef(idx, revMap);
      p.skipWS();
      if (!hasPrefix(data, p.pos, 'trailer')) {
        throw new Error("Erwartet 'trailer' nach klassischer xref-Tabelle");
      }
      p.pos += 7;
      trailerDict = p.parseValue();
      if (trailerDict.kind !== 'dict') throw new Error('trailer-Dictionary ungültig');
    } else {
      isStreamXRef = true;
      const parsed = await p.parseIndirectObj();
      xrefObjNum = parsed.objNum;
      const val = parsed.val;
      if (val.kind !== 'stream') throw new Error(`Objekt bei Offset ${offset} ist kein XRef-Stream`);
      await applyXRefStream(val, idx, revMap);
      trailerDict = { kind: 'dict', dict: val.dict };
    }
    const endOffset = findRevEndOffset(data, p.pos);

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
        if (xobj.kind === 'stream') await applyXRefStream(xobj, idx, revMap);
      } catch { /* non-fatal hybrid fallback */ }
    }

    const szVal = dictGet(trailerDict, 'Size');
    const prev = dictGet(trailerDict, 'Prev');
    const prevOffset = (prev && prev.kind === 'int' && prev.intVal > 0) ? prev.intVal : 0;

    rawRevs.push({
      xrefOffset: offset,
      endOffset,
      isStreamXRef,
      xrefObjNum,
      prevOffset,
      trailerSize: szVal && szVal.kind === 'int' ? szVal.intVal : 0,
      definedObjs: revMap,
    });

    if (prevOffset > 0) {
      offset = prevOffset;
    } else {
      break;
    }
  }

  // Collapse linearized PDF backwards-/Prev pairs (first-page XRef pointing forward to main XRef)
  // in newest-first order before reversing into oldest -> newest.
  const collapsedNewestFirst = [];
  for (let i = 0; i < rawRevs.length; i++) {
    const curr = rawRevs[i];
    if (i + 1 < rawRevs.length && curr.prevOffset > curr.xrefOffset) {
      const mainRev = rawRevs[++i];
      const mergedObjs = new Map(curr.definedObjs);
      for (const [objNum, ent] of mainRev.definedObjs.entries()) {
        if (!mergedObjs.has(objNum)) mergedObjs.set(objNum, ent);
      }
      collapsedNewestFirst.push({
        xrefOffset: curr.xrefOffset,
        endOffset: Math.max(curr.endOffset, mainRev.endOffset),
        isStreamXRef: curr.isStreamXRef || mainRev.isStreamXRef,
        xrefObjNum: curr.xrefObjNum,
        prevOffset: mainRev.prevOffset,
        trailerSize: Math.max(curr.trailerSize, mainRev.trailerSize),
        definedObjs: mergedObjs,
      });
    } else {
      collapsedNewestFirst.push(curr);
    }
  }
  idx.revisions = collapsedNewestFirst.reverse();
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

/**
 * Inspects page annotation /NM names and /OCProperties /OCGs names in a PDF (for conformance tests).
 */
export async function inspectPdfStructure(pdfBytes) {
  const idx = await parsePDFIndex(pdfBytes);
  const pageAnnotNMs = [];
  const ocgNames = [];
  if (idx.rootObjNum <= 0) return { pageAnnotNMs, ocgNames };

  const cat = await idx.resolveObject(idx.rootObjNum);
  const ocpRaw = dictGet(cat, 'OCProperties');
  if (ocpRaw) {
    const ocp = await idx.resolveValue(ocpRaw);
    const ocgsRaw = ocp && ocp.kind === 'dict' ? dictGet(ocp, 'OCGs') : null;
    const ocgsArr = ocgsRaw ? await idx.resolveValue(ocgsRaw) : null;
    if (ocgsArr && ocgsArr.kind === 'array') {
      for (const item of ocgsArr.items) {
        const ocg = await idx.resolveValue(item);
        const nmVal = ocg && ocg.kind === 'dict' ? dictGet(ocg, 'Name') : null;
        if (nmVal) ocgNames.push(decodePDFStringVal(nmVal));
      }
    }
  }

  const walkPages = async (nodeRef, depth) => {
    if (!nodeRef || depth > 32) return;
    const node = await idx.resolveValue(nodeRef);
    if (!node || node.kind !== 'dict') return;
    const typ = dictGet(node, 'Type');
    if (typ && typ.kind === 'name' && typ.raw === 'Page') {
      const nms = [];
      const annRaw = dictGet(node, 'Annots');
      if (annRaw) {
        const annArr = await idx.resolveValue(annRaw);
        if (annArr && annArr.kind === 'array') {
          for (const it of annArr.items) {
            const ann = await idx.resolveValue(it);
            const nmVal = ann && ann.kind === 'dict' ? dictGet(ann, 'NM') : null;
            nms.push(nmVal ? decodePDFStringVal(nmVal) : '');
          }
        }
      }
      pageAnnotNMs.push(nms);
      return;
    }
    const kidsRaw = dictGet(node, 'Kids');
    const kidsArr = kidsRaw ? await idx.resolveValue(kidsRaw) : null;
    if (kidsArr && kidsArr.kind === 'array') {
      for (const kid of kidsArr.items) {
        await walkPages(kid, depth + 1);
      }
    }
  };
  const pagesRaw = dictGet(cat, 'Pages');
  if (pagesRaw) await walkPages(pagesRaw, 0);
  return { pageAnnotNMs, ocgNames };
}

async function collectEmbeddedFiles(idx, nodeVal, out, visited) {
  const refs = new Map();
  await collectEmbeddedFileRefs(idx, nodeVal, refs, visited);
  for (const [name, entry] of refs.entries()) {
    out.set(name, entry.decodedData);
  }
}

async function collectEmbeddedFileRefs(idx, nodeVal, out, visited, treeObjNums = null) {
  if (!nodeVal) return;
  if (nodeVal.kind === 'ref') {
    if (visited.has(nodeVal.objNum)) return;
    visited.add(nodeVal.objNum);
    if (treeObjNums) treeObjNums.add(nodeVal.objNum);
  }
  const node = await idx.resolveValue(nodeVal);
  if (!node || node.kind !== 'dict') return;

  const namesArr = dictGet(node, 'Names');
  if (namesArr) {
    const resolvedArr = await idx.resolveValue(namesArr);
    if (resolvedArr && resolvedArr.kind === 'array') {
      for (let i = 0; i + 1 < resolvedArr.items.length; i += 2) {
        const keyName = decodePDFStringVal(resolvedArr.items[i]);
        const fsRef = resolvedArr.items[i + 1];
        const fsVal = await idx.resolveValue(fsRef);
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
        out.set(fileName, {
          filespecRef: fsRef.kind === 'ref' ? fsRef : null,
          streamRef: streamRef.kind === 'ref' ? streamRef : null,
          storedBytes: streamObj.stream ? streamObj.stream.length : 0,
          decodedData: await decodePDFStream(streamObj),
        });
      }
    }
  }

  const kidsArr = dictGet(node, 'Kids');
  if (kidsArr) {
    const resolvedKids = await idx.resolveValue(kidsArr);
    if (resolvedKids && resolvedKids.kind === 'array') {
      for (const kid of resolvedKids.items) {
        await collectEmbeddedFileRefs(idx, kid, out, visited, treeObjNums);
      }
    }
  }
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function canonicalJson(val) {
  if (Array.isArray(val)) return '[' + val.map(canonicalJson).join(',') + ']';
  if (val && typeof val === 'object') {
    const keys = Object.keys(val).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(val[k])).join(',') + '}';
  }
  return JSON.stringify(val);
}

function isSamePdfstageMeta(existingBytes, nextBytes) {
  if (bytesEqual(existingBytes, nextBytes)) return true;
  try {
    const a = JSON.parse(utf8Decoder.decode(existingBytes));
    const b = JSON.parse(utf8Decoder.decode(nextBytes));
    if (a && typeof a === 'object' && a.provenance && typeof a.provenance === 'object') {
      delete a.provenance.convertedAt;
    }
    if (b && typeof b === 'object' && b.provenance && typeof b.provenance === 'object') {
      delete b.provenance.convertedAt;
    }
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
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

function writeXRefRow(buf, idx, typ, f1, f2, offsetBytes, f2Bytes = 1) {
  buf[idx] = typ;
  // Write f1 big-endian into offsetBytes bytes (handles >4GB too if needed).
  let v = f1;
  for (let i = offsetBytes - 1; i >= 0; i--) {
    buf[idx + 1 + i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  let g = f2;
  for (let i = f2Bytes - 1; i >= 0; i--) {
    buf[idx + 1 + offsetBytes + i] = g & 0xff;
    g = Math.floor(g / 256);
  }
}

const HINT_PREFIX = 'pdfstage-hint';
const HINT_URI = 'https://pdfstage.github.io/';
// WinAnsiEncoding escapes: \344 = 'ä', \374 = 'ü'
const HINT_TEXT_WINANSI = 'Enth\\344lt Audio f\\374r pdfstage.github.io';

function pdfNumberVal(val) {
  if (!val) return null;
  if (val.kind === 'int') return val.intVal;
  if (val.kind === 'real') {
    const n = Number(val.raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pdfRectNumbers(val) {
  if (!val || val.kind !== 'array' || val.items.length !== 4) return null;
  const nums = val.items.map(pdfNumberVal);
  if (nums.some((n) => n === null)) return null;
  return [
    Math.min(nums[0], nums[2]),
    Math.min(nums[1], nums[3]),
    Math.max(nums[0], nums[2]),
    Math.max(nums[1], nums[3]),
  ];
}

function fmtCoord(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

function fmtRect(rect) {
  return `[${rect.map(fmtCoord).join(' ')}]`;
}

async function resolveFirstPage(idx, catVal) {
  const pagesRef = dictGet(catVal, 'Pages');
  if (!pagesRef) return null;

  async function walk(nodeRef, inhBox, inhCrop, inhRotate, depth) {
    if (depth > 32) return null;
    const node = await idx.resolveValue(nodeRef);
    if (!node || node.kind !== 'dict') return null;

    const media = pdfRectNumbers(dictGet(node, 'MediaBox')) || inhBox;
    const crop = pdfRectNumbers(dictGet(node, 'CropBox')) || inhCrop;
    const rotVal = dictGet(node, 'Rotate');
    const rot = (rotVal && rotVal.kind === 'int') ? rotVal.intVal : inhRotate;

    const typeVal = dictGet(node, 'Type');
    if (typeVal && typeVal.kind === 'name' && typeVal.raw === 'Page') {
      if (nodeRef.kind !== 'ref') return null;
      return {
        objNum: nodeRef.objNum,
        dict: node.dict,
        box: crop || media || [0, 0, 720, 540],
        rotate: rot || 0,
      };
    }

    const kidsRaw = dictGet(node, 'Kids');
    if (!kidsRaw) return null;
    const kids = await idx.resolveValue(kidsRaw);
    if (!kids || kids.kind !== 'array') return null;
    for (const kid of kids.items) {
      const found = await walk(kid, media, crop, rot, depth + 1);
      if (found) return found;
    }
    return null;
  }

  return walk(pagesRef, null, null, 0, 0);
}

function mapVisualRectToPdf(box, rotateDeg, vx0, vy0, vx1, vy1) {
  const [minX, minY, maxX, maxY] = box;
  const rot = ((rotateDeg % 360) + 360) % 360;
  function mapPt(vx, vy) {
    if (rot === 90) return [maxX - vy, minY + vx];
    if (rot === 180) return [maxX - vx, maxY - vy];
    if (rot === 270) return [minX + vy, maxY - vx];
    return [minX + vx, minY + vy];
  }
  const [ax, ay] = mapPt(vx0, vy0);
  const [bx, by] = mapPt(vx1, vy1);
  return [
    Math.min(ax, bx),
    Math.min(ay, by),
    Math.max(ax, bx),
    Math.max(ay, by),
  ];
}

function buildHintAppearanceStream(w, h, closeW) {
  const x0 = 0.375;
  const y0 = 0.375;
  const x1 = w - 0.375;
  const y1 = h - 0.375;
  const r = (y1 - y0) / 2;
  const k = 0.55228475 * r;
  const divX = w - closeW;
  const cx = divX + closeW / 2;
  const cy = h / 2;

  const parts = [
    'q',
    '/GS1 gs',
    '0.09 0.10 0.13 rg',
    '0.38 0.41 0.49 RG',
    '0.75 w',
    // Rounded pill contour (clockwise/CCW cubic Bézier caps)
    `${fmtCoord(x0 + r)} ${fmtCoord(y0)} m`,
    `${fmtCoord(x1 - r)} ${fmtCoord(y0)} l`,
    `${fmtCoord(x1 - r + k)} ${fmtCoord(y0)} ${fmtCoord(x1)} ${fmtCoord(y0 + r - k)} ${fmtCoord(x1)} ${fmtCoord(y0 + r)} c`,
    `${fmtCoord(x1)} ${fmtCoord(y1 - r + k)} ${fmtCoord(x1 - r + k)} ${fmtCoord(y1)} ${fmtCoord(x1 - r)} ${fmtCoord(y1)} c`,
    `${fmtCoord(x0 + r)} ${fmtCoord(y1)} l`,
    `${fmtCoord(x0 + r - k)} ${fmtCoord(y1)} ${fmtCoord(x0)} ${fmtCoord(y1 - r + k)} ${fmtCoord(x0)} ${fmtCoord(y1 - r)} c`,
    `${fmtCoord(x0)} ${fmtCoord(y0 + r - k)} ${fmtCoord(x0 + r - k)} ${fmtCoord(y0)} ${fmtCoord(x0 + r)} ${fmtCoord(y0)} c`,
    'B',
    // Vector speaker body + cone
    '1 1 1 rg 1 1 1 RG',
    '10 9.2 m 12.6 9.2 l 15.8 6.8 l 15.8 15.2 l 12.6 12.8 l 10 12.8 l h f',
    // Sound wave arcs
    '0.9 w 1 J',
    '17.2 8.7 m 18.6 9.9 18.6 12.1 17.2 13.3 c S',
    '18.8 7.5 m 20.9 9.4 20.9 12.6 18.8 14.5 c S',
    // Label in WinAnsi Helvetica
    `BT /F1 9.5 Tf 26 7.5 Td (${HINT_TEXT_WINANSI}) Tj ET`,
    // Divider and close 'x'
    `0.38 0.41 0.49 RG 0.6 w ${fmtCoord(divX)} 4.5 m ${fmtCoord(divX)} ${fmtCoord(h - 4.5)} l S`,
    `0.78 0.80 0.86 RG 1.1 w 1 J ${fmtCoord(cx - 3.2)} ${fmtCoord(cy - 3.2)} m ${fmtCoord(cx + 3.2)} ${fmtCoord(cy + 3.2)} l ${fmtCoord(cx - 3.2)} ${fmtCoord(cy + 3.2)} m ${fmtCoord(cx + 3.2)} ${fmtCoord(cy - 3.2)} l S`,
    'Q',
  ];
  return parts.join('\n') + '\n';
}

function appendUniqueRef(items, objNum) {
  if (!items.some((it) => it.kind === 'ref' && it.objNum === objNum)) {
    items.push({ kind: 'ref', objNum, genNum: 0, raw: `${objNum} 0 R` });
  }
}

function groupContiguousObjNums(objNums) {
  const sorted = [...new Set(objNums)].sort((a, b) => a - b);
  const groups = [];
  for (const n of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.start + last.count === n) {
      last.count++;
    } else {
      groups.push({ start: n, count: 1 });
    }
  }
  return groups;
}

const MANAGED_ATTACHMENT_NAMES = new Set([
  'pdfstage.json',
  'audio.opus',
  'audio.wav',
  'audio.webm',
  'audio.ogg',
]);

function isPdfstageManagedName(name, existingMetaAudioName, requestedNames) {
  if (MANAGED_ATTACHMENT_NAMES.has(name)) return true;
  if (existingMetaAudioName && name === existingMetaAudioName) return true;
  if (requestedNames && requestedNames.has(name)) return true;
  return false;
}

function collectValRefs(val, outSet) {
  if (!val) return;
  if (val.kind === 'ref') {
    outSet.add(val.objNum);
    return;
  }
  if (val.kind === 'array' && Array.isArray(val.items)) {
    for (const it of val.items) collectValRefs(it, outSet);
    return;
  }
  if ((val.kind === 'dict' || val.kind === 'stream') && Array.isArray(val.dict)) {
    for (const kv of val.dict) collectValRefs(kv.val, outSet);
  }
}

function hasSignatureInVal(val) {
  if (!val || (val.kind !== 'dict' && val.kind !== 'stream')) return false;
  const typ = dictGet(val, 'Type');
  if (typ && typ.kind === 'name' && typ.raw === 'Sig') return true;
  if (dictGet(val, 'ByteRange')) return true;
  return false;
}

async function hasDigitalSignature(idx, catVal, extraVals = []) {
  if (dictGet(catVal, 'Perms')) return true;
  const acroRaw = dictGet(catVal, 'AcroForm');
  if (acroRaw) {
    try {
      const acro = await idx.resolveValue(acroRaw);
      if (acro && acro.kind === 'dict') {
        const sigFlags = dictGet(acro, 'SigFlags');
        if (sigFlags && sigFlags.kind === 'int' && (sigFlags.intVal & 1) !== 0) {
          return true;
        }
      }
    } catch { /* ignore */ }
  }
  for (const v of extraVals) {
    if (hasSignatureInVal(v)) return true;
  }
  return false;
}

async function extractRawIndirectObj(data, offset, expectedObjNum, idx) {
  const p = new PDFParser(data, offset, idx);
  p.skipWS();
  const start = p.pos;
  const objNum = p.readInt();
  const gen = p.readInt();
  const kw = p.readWord();
  if (objNum === null || gen === null || kw !== 'obj' || objNum !== expectedObjNum) {
    throw new Error(`Objekt ${expectedObjNum} bei Offset ${offset} nicht eindeutig lesbar`);
  }
  let val = p.parseValue();
  if (val.kind === 'dict') {
    const saved = p.pos;
    if (p.readWord() === 'stream') {
      if (p.pos < data.length && data[p.pos] === 0x0d) p.pos++;
      if (p.pos < data.length && data[p.pos] === 0x0a) p.pos++;
      const streamBytes = await p.readStreamBytes(val);
      val = { kind: 'stream', dict: val.dict, stream: streamBytes };
      let nextW = p.readWord();
      if (nextW === 'endstream') nextW = p.readWord();
      if (nextW !== 'endobj') {
        throw new Error(`Objekt ${expectedObjNum}: endobj nach Stream erwartet, bekam ${nextW}`);
      }
    } else {
      p.pos = saved;
      if (p.readWord() !== 'endobj') {
        throw new Error(`Objekt ${expectedObjNum}: endobj erwartet`);
      }
    }
  } else {
    if (p.readWord() !== 'endobj') {
      throw new Error(`Objekt ${expectedObjNum}: endobj erwartet`);
    }
  }
  return { raw: data.subarray(start, p.pos), val, objNum, gen };
}

async function resolveOcPropertiesRefs(idx, ocpVal, dropOcgNum, neededRefs) {
  if (!ocpVal || ocpVal.kind !== 'dict') return;
  for (const kv of ocpVal.dict) {
    if (kv.key !== 'OCGs' && kv.key !== 'D') {
      collectValRefs(kv.val, neededRefs);
    }
  }
  const ocgsRaw = dictGet(ocpVal, 'OCGs');
  if (ocgsRaw) {
    const ocgsArr = await idx.resolveValue(ocgsRaw).catch(() => null);
    if (ocgsArr && ocgsArr.kind === 'array') {
      for (const it of ocgsArr.items) {
        if (it.kind === 'ref' && it.objNum === dropOcgNum) continue;
        collectValRefs(it, neededRefs);
      }
    }
  }
  const dRaw = dictGet(ocpVal, 'D');
  if (dRaw) {
    const dRes = await idx.resolveValue(dRaw).catch(() => null);
    if (dRes && dRes.kind === 'dict') {
      for (const kv of dRes.dict) {
        if (kv.key === 'ON' || kv.key === 'OFF') {
          const arr = await idx.resolveValue(kv.val).catch(() => null);
          if (arr && arr.kind === 'array') {
            for (const it of arr.items) {
              if (it.kind === 'ref' && it.objNum === dropOcgNum) continue;
              collectValRefs(it, neededRefs);
            }
          }
        } else if (kv.key === 'AS') {
          const arr = await idx.resolveValue(kv.val).catch(() => null);
          if (arr && arr.kind === 'array') {
            for (const item of arr.items) {
              if (item.kind !== 'dict') {
                collectValRefs(item, neededRefs);
                continue;
              }
              const ocgs = dictGet(item, 'OCGs');
              if (ocgs && ocgs.kind === 'array') {
                for (const r of ocgs.items) {
                  if (r.kind === 'ref' && r.objNum === dropOcgNum) continue;
                  collectValRefs(r, neededRefs);
                }
              }
            }
          }
        } else {
          collectValRefs(kv.val, neededRefs);
        }
      }
    }
  }
}

async function buildAttachPlan(pdfBytes, files, options = {}) {
  if (!pdfBytes || pdfBytes.length === 0) throw new Error('PDF ist leer');
  const idx = await parsePDFIndex(pdfBytes);
  if (idx.rootObjNum <= 0) throw new Error('PDF hat keinen /Root-Catalog');

  const catVal = await idx.resolveObject(idx.rootObjNum);
  if (!catVal || catVal.kind !== 'dict') {
    throw new Error(`/Catalog (${idx.rootObjNum} 0 obj) ist kein Dictionary`);
  }

  const existingNamesDict = [];
  const existingEFMap = new Map();
  const existingEfTreeObjNums = new Set();
  const namesRaw = dictGet(catVal, 'Names');
  const existingNamesObjNum = namesRaw && namesRaw.kind === 'ref' ? namesRaw.objNum : 0;
  if (namesRaw) {
    try {
      const namesResolved = await idx.resolveValue(namesRaw);
      if (namesResolved && namesResolved.kind === 'dict') {
        for (const kv of namesResolved.dict) {
          if (kv.key === 'EmbeddedFiles') {
            await collectEmbeddedFileRefs(idx, kv.val, existingEFMap, new Set(), existingEfTreeObjNums).catch(() => {});
          } else {
            existingNamesDict.push(kv);
          }
        }
      }
    } catch { /* keep going */ }
  }

  let existingMetaAudioName = '';
  const prevMetaEntry = existingEFMap.get('pdfstage.json');
  if (prevMetaEntry && prevMetaEntry.decodedData) {
    try {
      const prevMeta = JSON.parse(utf8Decoder.decode(prevMetaEntry.decodedData));
      if (prevMeta && typeof prevMeta.audio === 'string') {
        existingMetaAudioName = prevMeta.audio;
      }
    } catch { /* ignore */ }
  }

  const wantHint = Boolean(options && options.viewerHint);
  let page1 = null;
  const existingPage1Annots = [];
  const existingHintAnnotObjs = new Set();
  const existingHintApObjs = new Set();
  let existingOcProps = null;
  let existingOcgNum = 0;
  let hintAlreadyCurrent = !wantHint;

  if (wantHint) {
    page1 = await resolveFirstPage(idx, catVal);
    if (page1) {
      let hasHintStamp = false;
      let hasHintLink = false;
      let hasHintClose = false;
      let stampContentsMatches = false;
      const expectedStampText = 'Enth\u00e4lt Audio f\u00fcr pdfstage.github.io';

      const annotsRaw = dictGet({ kind: 'dict', dict: page1.dict }, 'Annots');
      if (annotsRaw) {
        try {
          const annotsArr = await idx.resolveValue(annotsRaw);
          if (annotsArr && annotsArr.kind === 'array') {
            for (const item of annotsArr.items) {
              let nm = '';
              let contents = '';
              let resolved = null;
              try {
                resolved = await idx.resolveValue(item);
                if (resolved && resolved.kind === 'dict') {
                  const nmVal = dictGet(resolved, 'NM');
                  if (nmVal) nm = decodePDFStringVal(nmVal);
                  const cVal = dictGet(resolved, 'Contents');
                  if (cVal) contents = decodePDFStringVal(cVal);
                }
              } catch { /* keep unknown annot */ }
              if (nm === `${HINT_PREFIX}-stamp`) {
                hasHintStamp = true;
                stampContentsMatches = contents === expectedStampText;
              } else if (nm === `${HINT_PREFIX}-link`) {
                hasHintLink = true;
              } else if (nm === `${HINT_PREFIX}-close`) {
                hasHintClose = true;
              }
              if (nm.startsWith(HINT_PREFIX)) {
                if (item.kind === 'ref') existingHintAnnotObjs.add(item.objNum);
                if (resolved && resolved.kind === 'dict') {
                  const apVal = dictGet(resolved, 'AP');
                  if (apVal) collectValRefs(apVal, existingHintApObjs);
                }
                continue;
              }
              existingPage1Annots.push(item);
            }
          }
        } catch { /* keep empty */ }
      }

      const ocpRaw = dictGet(catVal, 'OCProperties');
      if (ocpRaw) {
        try {
          const resolvedOcp = await idx.resolveValue(ocpRaw);
          if (resolvedOcp && resolvedOcp.kind === 'dict') {
            existingOcProps = resolvedOcp;
            const ocgsRaw = dictGet(resolvedOcp, 'OCGs');
            const ocgsArr = ocgsRaw ? await idx.resolveValue(ocgsRaw) : null;
            if (ocgsArr && ocgsArr.kind === 'array') {
              for (const ocgItem of ocgsArr.items) {
                if (ocgItem.kind !== 'ref') continue;
                try {
                  const ocgDict = await idx.resolveValue(ocgItem);
                  const nmVal = ocgDict && ocgDict.kind === 'dict' ? dictGet(ocgDict, 'Name') : null;
                  if (nmVal && decodePDFStringVal(nmVal) === HINT_PREFIX) {
                    existingOcgNum = ocgItem.objNum;
                    break;
                  }
                } catch { /* ignore */ }
              }
            }
          }
        } catch { /* ignore */ }
      }
      hintAlreadyCurrent = existingOcgNum > 0 && hasHintStamp && stampContentsMatches && hasHintLink && hasHintClose;
    } else {
      hintAlreadyCurrent = true;
    }
  }

  const sortedFiles = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const requestedNames = new Set(sortedFiles.map((f) => f.name));

  const matchedEntries = sortedFiles.map((f) => {
    const prev = existingEFMap.get(f.name);
    if (!prev || !prev.filespecRef) return null;
    if (f.name === 'pdfstage.json') {
      return isSamePdfstageMeta(prev.decodedData, f.data) ? prev.filespecRef : null;
    }
    return bytesEqual(prev.decodedData, f.data) ? prev.filespecRef : null;
  });
  const reusedNames = new Set();
  for (let i = 0; i < sortedFiles.length; i++) {
    if (matchedEntries[i]) reusedNames.add(sortedFiles[i].name);
  }

  const preservedForeignFiles = [];
  const deadFiles = [];
  for (const [name, entry] of existingEFMap.entries()) {
    if (!isPdfstageManagedName(name, existingMetaAudioName, requestedNames)) {
      if (entry.filespecRef) {
        preservedForeignFiles.push({
          name,
          filespecRef: entry.filespecRef,
          streamRef: entry.streamRef,
          storedBytes: entry.storedBytes,
          decodedBytes: entry.decodedData.length,
        });
      }
      continue;
    }
    if (!reusedNames.has(name)) {
      deadFiles.push({
        name,
        bytes: entry.storedBytes,
        decodedBytes: entry.decodedData.length,
        filespecObjNum: entry.filespecRef ? entry.filespecRef.objNum : 0,
        streamObjNum: entry.streamRef ? entry.streamRef.objNum : 0,
      });
    }
  }
  deadFiles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const deadBytes = deadFiles.reduce((acc, df) => acc + df.bytes, 0);

  const allReused = matchedEntries.every(Boolean);
  const noOp = allReused && deadFiles.length === 0 && hintAlreadyCurrent;

  let canReplace = false;
  let replaceStrategy = 'none';
  let replaceBlockedReason = '';
  let reclaimableBytes = 0;
  let revisionsAfterDead = 0;
  let internalReplace = null;

  if (!noOp && deadFiles.length > 0) {
    if (idx.hasEncrypt) {
      replaceBlockedReason = 'PDF ist verschlüsselt';
    } else if (idx.revisions.length < 2) {
      replaceBlockedReason = 'Alte Anhänge liegen in der Basis-Revision (z. B. nach Full-Save eines PDF-Viewers)';
    } else {
      // Find the earliest incremental revision >= 1 that holds a live dead stream/filespec object.
      let cutRevIdx = -1;
      for (let ri = 1; ri < idx.revisions.length; ri++) {
        const prevEnd = idx.revisions[ri - 1].endOffset;
        if (prevEnd <= 0 || prevEnd >= pdfBytes.length) continue;
        const revObjs = idx.revisions[ri].definedObjs;
        const hitsDead = deadFiles.some((df) => {
          for (const targetObj of [df.streamObjNum, df.filespecObjNum]) {
            if (targetObj <= 0 || !revObjs.has(targetObj)) continue;
            const active = idx.entries.get(targetObj);
            if (active && active.typ === 1 && active.f1 >= prevEnd) return true;
          }
          return false;
        });
        if (hitsDead) {
          cutRevIdx = ri;
          break;
        }
      }

      if (cutRevIdx < 1) {
        replaceBlockedReason = 'Alte Anhänge liegen in der Basis-Revision (z. B. nach Full-Save eines PDF-Viewers)';
      } else {
        const baseRev = idx.revisions[cutRevIdx - 1];
        const baseEndOffset = baseRev.endOffset;
        const baseXRefOffset = baseRev.xrefOffset;

        const baseEntries = new Map();
        let baseMaxObjNum = 0;
        for (let ri = 0; ri < cutRevIdx; ri++) {
          const rev = idx.revisions[ri];
          if (rev.trailerSize > baseMaxObjNum) baseMaxObjNum = rev.trailerSize;
          for (const [objNum, ent] of rev.definedObjs.entries()) {
            baseEntries.set(objNum, ent);
            if (objNum + 1 > baseMaxObjNum) baseMaxObjNum = objNum + 1;
          }
        }

        let baseLayoutValid = baseEndOffset > 0 && baseEndOffset < pdfBytes.length
          && baseXRefOffset > 0 && baseXRefOffset < baseEndOffset;
        if (baseLayoutValid) {
          for (const ent of baseEntries.values()) {
            if (ent.typ === 1 && ent.f1 >= baseEndOffset) {
              baseLayoutValid = false;
              break;
            }
          }
        }

        if (!baseLayoutValid) {
          replaceBlockedReason = 'Revisionsgrenzen im PDF erlauben keine sichere Ersetzung';
        } else {
          // Determine all currently active objects written after baseEndOffset.
          const tailType1 = new Map();
          const tailType2 = new Map();
          const tailFreed = new Map();

          for (const [objNum, ent] of idx.entries.entries()) {
            if (ent.typ === 1 && ent.f1 >= baseEndOffset) {
              tailType1.set(objNum, ent);
            } else if (ent.typ === 0) {
              const baseEnt = baseEntries.get(objNum);
              if (baseEnt && baseEnt.typ !== 0) {
                tailFreed.set(objNum, ent);
              }
            }
          }
          for (const [objNum, ent] of idx.entries.entries()) {
            if (ent.typ === 2 && tailType1.has(ent.f1)) {
              tailType2.set(objNum, ent);
            }
          }

          const rewrittenObjs = new Set([idx.rootObjNum]);
          if (wantHint && page1) rewrittenObjs.add(page1.objNum);

          const candidateDropSet = new Set();
          const considerDrop = (objNum) => {
            if (!objNum || objNum <= 0) return;
            if (baseEntries.has(objNum) || rewrittenObjs.has(objNum)) return;
            if (tailType1.has(objNum)) candidateDropSet.add(objNum);
          };

          for (const df of deadFiles) {
            considerDrop(df.streamObjNum);
            considerDrop(df.filespecObjNum);
          }
          for (let ri = cutRevIdx; ri < idx.revisions.length; ri++) {
            if (idx.revisions[ri].xrefObjNum > 0) considerDrop(idx.revisions[ri].xrefObjNum);
          }
          considerDrop(existingNamesObjNum);
          for (const objNum of existingEfTreeObjNums) considerDrop(objNum);
          if (wantHint && page1) {
            for (const objNum of existingHintAnnotObjs) considerDrop(objNum);
            for (const objNum of existingHintApObjs) considerDrop(objNum);
            considerDrop(existingOcgNum);
          }

          const keptMap = new Map();
          let extractOk = true;
          for (const [objNum, ent] of tailType1.entries()) {
            if (rewrittenObjs.has(objNum) || candidateDropSet.has(objNum)) continue;
            try {
              const extracted = await extractRawIndirectObj(pdfBytes, ent.f1, objNum, idx);
              keptMap.set(objNum, extracted);
            } catch {
              extractOk = false;
              break;
            }
          }

          if (!extractOk) {
            replaceBlockedReason = 'Objektstruktur für Ersetzung nicht eindeutig lesbar';
          } else {
            const neededRefs = new Set();
            const collectFromVal = async (val, objNumHint = 0) => {
              collectValRefs(val, neededRefs);
              if (val && val.kind === 'stream') {
                const typ = dictGet(val, 'Type');
                if (typ && typ.kind === 'name' && typ.raw === 'ObjStm' && objNumHint > 0) {
                  try {
                    const subObjs = await idx.loadObjStm(objNumHint);
                    for (const slice of subObjs.values()) {
                      const subVal = new PDFParser(slice, 0, idx).parseValue();
                      collectValRefs(subVal, neededRefs);
                      if (hasSignatureInVal(subVal)) return true;
                    }
                  } catch {
                    throw new Error('/ObjStm nicht lesbar');
                  }
                }
              }
              return false;
            };

            let subObjSigFound = false;
            let objStmReadErr = false;
            try {
              for (const [objNum, rec] of keptMap.entries()) {
                if (await collectFromVal(rec.val, objNum)) subObjSigFound = true;
              }
              for (const it of existingPage1Annots) collectValRefs(it, neededRefs);
              for (const kv of existingNamesDict) collectValRefs(kv.val, neededRefs);
              if (existingOcProps) {
                const dropOcg = candidateDropSet.has(existingOcgNum) ? existingOcgNum : 0;
                await resolveOcPropertiesRefs(idx, existingOcProps, dropOcg, neededRefs);
              }
              const existingPM = dictGet(catVal, 'PageMode');
              const willSetPM = wantHint && (!existingPM || (existingPM.kind === 'name' && existingPM.raw === 'UseNone'));
              for (const kv of catVal.dict) {
                if (kv.key === 'Names') continue;
                if (wantHint && page1 && kv.key === 'OCProperties') continue;
                if (willSetPM && kv.key === 'PageMode') continue;
                collectValRefs(kv.val, neededRefs);
              }
              if (idx.infoRef) collectValRefs(idx.infoRef, neededRefs);
              for (const ref of matchedEntries) {
                if (ref) collectValRefs(ref, neededRefs);
              }
              for (const pf of preservedForeignFiles) {
                if (pf.filespecRef) collectValRefs(pf.filespecRef, neededRefs);
              }

              // Fixpoint closure: any candidate-dropped object still referenced must be kept & replayed.
              let changed = true;
              while (changed) {
                changed = false;
                for (const r of Array.from(neededRefs)) {
                  if (!candidateDropSet.has(r)) continue;
                  candidateDropSet.delete(r);
                  const ent = tailType1.get(r);
                  if (ent) {
                    const extracted = await extractRawIndirectObj(pdfBytes, ent.f1, r, idx);
                    keptMap.set(r, extracted);
                    if (await collectFromVal(extracted.val, r)) subObjSigFound = true;
                    changed = true;
                  }
                }
              }
            } catch {
              objStmReadErr = true;
            }

            if (objStmReadErr) {
              replaceBlockedReason = 'Objektstruktur für Ersetzung nicht eindeutig lesbar';
            } else {
              const tailVals = Array.from(keptMap.values()).map((r) => r.val);
              const signed = subObjSigFound || await hasDigitalSignature(idx, catVal, tailVals);
              if (signed) {
                replaceBlockedReason = 'PDF enthält digitale Signatur';
              } else {
                for (const df of deadFiles) {
                  if (df.streamObjNum > 0 && candidateDropSet.has(df.streamObjNum)) {
                    reclaimableBytes += df.bytes;
                  }
                }
                if (reclaimableBytes > 0) {
                  canReplace = true;
                  revisionsAfterDead = idx.revisions.length - 1 - cutRevIdx;
                  replaceStrategy = keptMap.size === 0 ? 'tail-truncate' : 'revision-replay';
                  internalReplace = {
                    baseEndOffset,
                    baseXRefOffset,
                    baseMaxObjNum,
                    keptMap,
                    tailType2,
                    tailFreed,
                    droppedOcg: existingOcgNum > 0 && candidateDropSet.has(existingOcgNum),
                  };
                } else {
                  replaceBlockedReason = 'Verweis auf altes Objekt in späterer Revision gefunden';
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    noOp,
    deadFiles,
    deadBytes,
    reclaimableBytes,
    canReplace,
    replaceStrategy,
    replaceBlockedReason,
    revisionsAfterDead,
    preservedForeignFiles: preservedForeignFiles.map((f) => ({
      name: f.name,
      bytes: f.storedBytes,
      decodedBytes: f.decodedBytes,
    })),
    _internal: {
      idx,
      catVal,
      existingNamesDict,
      wantHint,
      page1,
      existingPage1Annots,
      existingOcProps,
      existingOcgNum,
      sortedFiles,
      matchedEntries,
      preservedForeignRaw: preservedForeignFiles,
      replace: internalReplace,
    },
  };
}

function publicPlanReport(plan) {
  return {
    noOp: plan.noOp,
    deadFiles: plan.deadFiles,
    deadBytes: plan.deadBytes,
    reclaimableBytes: plan.reclaimableBytes,
    canReplace: plan.canReplace,
    replaceStrategy: plan.replaceStrategy,
    replaceBlockedReason: plan.replaceBlockedReason,
    revisionsAfterDead: plan.revisionsAfterDead,
    preservedForeignFiles: plan.preservedForeignFiles,
  };
}

/**
 * Inspects how attaching `files` would update `pdfBytes`, reporting any orphaned dead files
 * and whether clean removal (`replace`) via tail-truncation or revision-replay is possible.
 */
export async function analyzePdfAttachmentUpdate(pdfBytes, files, options = {}) {
  const plan = await buildAttachPlan(pdfBytes, files, options);
  return publicPlanReport(plan);
}

/**
 * Attaches files to `pdfBytes` and returns `{ bytes, plan, appliedMode }`.
 * Default `options.mode` is `'replace'` (cleans dead tail/replay objects safely when possible,
 * falling back to `'append'`); `'append'` always keeps all original PDF bytes as a prefix.
 */
export async function attachFilesToPdfWithReport(pdfBytes, files, options = {}) {
  const plan = await buildAttachPlan(pdfBytes, files, options);
  const report = publicPlanReport(plan);
  if (plan.noOp) {
    return { bytes: pdfBytes, plan: report, appliedMode: 'noop' };
  }

  const reqMode = options && options.mode ? options.mode : 'replace';
  const useReplace = reqMode === 'replace' && plan.canReplace && plan.reclaimableBytes > 0 && plan._internal.replace;
  const appliedMode = useReplace ? 'replace' : 'append';

  const st = plan._internal;
  const { idx, catVal, existingNamesDict, wantHint, page1, existingPage1Annots, existingOcProps, sortedFiles, matchedEntries, preservedForeignRaw } = st;
  let { existingOcgNum } = st;

  const out = new ByteBuilder();
  const newXRefEntries = new Map(); // objNum -> { typ, f1, f2 }
  let nextObj;
  let prevXRefOffset;

  if (useReplace) {
    const rp = st.replace;
    const prefix = pdfBytes.subarray(0, rp.baseEndOffset);
    out.pushBytes(prefix);
    if (prefix.length > 0 && prefix[prefix.length - 1] !== 0x0a && prefix[prefix.length - 1] !== 0x0d) {
      out.pushAscii('\n');
    }

    let maxKept = 0;
    const keptNums = Array.from(rp.keptMap.keys()).sort((a, b) => a - b);
    for (const objNum of keptNums) {
      const rec = rp.keptMap.get(objNum);
      newXRefEntries.set(objNum, { typ: 1, f1: out.length, f2: rec.gen });
      out.pushBytes(rec.raw);
      out.pushAscii('\n');
      if (objNum >= maxKept) maxKept = objNum + 1;
    }
    for (const [objNum, ent] of rp.tailType2.entries()) {
      if (rp.keptMap.has(ent.f1) && !newXRefEntries.has(objNum)) {
        newXRefEntries.set(objNum, ent);
        if (objNum >= maxKept) maxKept = objNum + 1;
      }
    }
    for (const [objNum, ent] of rp.tailFreed.entries()) {
      if (!newXRefEntries.has(objNum)) {
        newXRefEntries.set(objNum, ent);
        if (objNum >= maxKept) maxKept = objNum + 1;
      }
    }
    if (rp.droppedOcg) {
      existingOcgNum = 0;
    }
    nextObj = Math.max(rp.baseMaxObjNum, maxKept, idx.rootObjNum + 1, page1 ? page1.objNum + 1 : 0);
    prevXRefOffset = rp.baseXRefOffset;
  } else {
    out.pushBytes(pdfBytes);
    const lastByte = pdfBytes[pdfBytes.length - 1];
    if (lastByte !== 0x0a && lastByte !== 0x0d) {
      out.pushAscii('\n');
    }
    nextObj = idx.maxObjNum;
    if (nextObj <= idx.rootObjNum) nextObj = idx.rootObjNum + 1;
    if (page1 && nextObj <= page1.objNum) nextObj = page1.objNum + 1;
    prevXRefOffset = idx.firstXRefOffset;
  }

  const attached = [];

  for (let fi = 0; fi < sortedFiles.length; fi++) {
    const f = sortedFiles[fi];
    const reusedRef = matchedEntries[fi];
    if (reusedRef) {
      attached.push({ name: f.name, filespecObj: reusedRef.objNum });
      continue;
    }

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

    newXRefEntries.set(efObj, { typ: 1, f1: out.length, f2: 0 });
    let efHdr = `${efObj} 0 obj\n<< /Type /EmbeddedFile`;
    if (f.mime) efHdr += ` /Subtype /${escapePDFName(f.mime)}`;
    if (compressed) efHdr += ' /Filter /FlateDecode';
    efHdr += ` /Length ${payload.length} /Params << /Size ${f.data.length} >> >>\nstream\n`;
    out.pushAscii(efHdr);
    out.pushBytes(payload);
    out.pushAscii('\nendstream\nendobj\n');

    newXRefEntries.set(fsObj, { typ: 1, f1: out.length, f2: 0 });
    const fStr = encodePDFStringASCII(f.name);
    const ufStr = encodePDFStringUnicode(f.name);
    let fsBody = `${fsObj} 0 obj\n<< /Type /Filespec /F ${fStr} /UF ${ufStr} /EF << /F ${efObj} 0 R /UF ${efObj} 0 R >>`;
    if (f.description) fsBody += ` /Desc ${encodePDFStringUnicode(f.description)}`;
    fsBody += ' >>\nendobj\n';
    out.pushAscii(fsBody);

    attached.push({ name: f.name, filespecObj: fsObj });
  }

  for (const pf of preservedForeignRaw) {
    attached.push({ name: pf.name, filespecObj: pf.filespecRef.objNum });
  }
  attached.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const efTreeObj = nextObj++;
  newXRefEntries.set(efTreeObj, { typ: 1, f1: out.length, f2: 0 });
  const treeEntries = attached.map((a) => `${encodePDFStringUnicode(a.name)} ${a.filespecObj} 0 R`).join(' ');
  out.pushAscii(`${efTreeObj} 0 obj\n<< /Names [${treeEntries}] >>\nendobj\n`);

  const namesObj = nextObj++;
  newXRefEntries.set(namesObj, { typ: 1, f1: out.length, f2: 0 });
  const extraNames = existingNamesDict.map((kv) => ` /${escapePDFName(kv.key)} ${serializePDFVal(kv.val)}`).join('');
  out.pushAscii(`${namesObj} 0 obj\n<<${extraNames} /EmbeddedFiles ${efTreeObj} 0 R >>\nendobj\n`);

  let ocPropsVal = null;
  if (wantHint && page1) {
    let ocgObjNum = existingOcgNum;
    if (!ocgObjNum) {
      ocgObjNum = nextObj++;
      newXRefEntries.set(ocgObjNum, { typ: 1, f1: out.length, f2: 0 });
      out.pushAscii(
        `${ocgObjNum} 0 obj\n<< /Type /OCG /Name (${HINT_PREFIX}) /Usage << /Print << /PrintState /OFF >> /View << /ViewState /ON >> >> >>\nendobj\n`,
      );
    }
    const ocgRef = { kind: 'ref', objNum: ocgObjNum, genNum: 0, raw: `${ocgObjNum} 0 R` };

    const rot = ((page1.rotate % 360) + 360) % 360;
    const boxW = page1.box[2] - page1.box[0];
    const boxH = page1.box[3] - page1.box[1];
    const visW = (rot === 90 || rot === 270) ? boxH : boxW;
    const visH = (rot === 90 || rot === 270) ? boxW : boxH;
    const margin = 14;
    const h = 22;
    const w = Math.min(232, Math.max(120, visW - 2 * margin));
    const closeW = 22;
    const vx0 = visW - margin - w;
    const vy0 = visH - margin - h;
    const vx1 = visW - margin;
    const vy1 = visH - margin;

    const stampRect = mapVisualRectToPdf(page1.box, rot, vx0, vy0, vx1, vy1);
    const uriRect = mapVisualRectToPdf(page1.box, rot, vx0, vy0, vx1 - closeW, vy1);
    const closeRect = mapVisualRectToPdf(page1.box, rot, vx1 - closeW, vy0, vx1, vy1);

    let apMatrix = '[1 0 0 1 0 0]';
    if (rot === 90) apMatrix = `[0 1 -1 0 ${fmtCoord(h)} 0]`;
    else if (rot === 180) apMatrix = `[-1 0 0 -1 ${fmtCoord(w)} ${fmtCoord(h)}]`;
    else if (rot === 270) apMatrix = `[0 -1 1 0 0 ${fmtCoord(w)}]`;

    const apStreamStr = buildHintAppearanceStream(w, h, closeW);
    const apBytes = toAsciiBytes(apStreamStr);
    const apObj = nextObj++;
    newXRefEntries.set(apObj, { typ: 1, f1: out.length, f2: 0 });
    out.pushAscii(
      `${apObj} 0 obj\n<< /Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 ${fmtCoord(w)} ${fmtCoord(h)}] /Matrix ${apMatrix} /Resources << /ExtGState << /GS1 << /Type /ExtGState /ca 0.88 /CA 0.95 >> >> /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> >> >> /Length ${apBytes.length} >>\nstream\n`,
    );
    out.pushBytes(apBytes);
    out.pushAscii('endstream\nendobj\n');

    const stampObj = nextObj++;
    newXRefEntries.set(stampObj, { typ: 1, f1: out.length, f2: 0 });
    out.pushAscii(
      `${stampObj} 0 obj\n<< /Type /Annot /Subtype /Stamp /Rect ${fmtRect(stampRect)} /F 0 /Border [0 0 0] /NM (${HINT_PREFIX}-stamp) /Contents (${HINT_TEXT_WINANSI}) /AP << /N ${apObj} 0 R >> /OC ${ocgObjNum} 0 R >>\nendobj\n`,
    );

    const uriObj = nextObj++;
    newXRefEntries.set(uriObj, { typ: 1, f1: out.length, f2: 0 });
    out.pushAscii(
      `${uriObj} 0 obj\n<< /Type /Annot /Subtype /Link /Rect ${fmtRect(uriRect)} /F 0 /Border [0 0 0] /H /I /NM (${HINT_PREFIX}-link) /A << /S /URI /URI (${HINT_URI}) >> /OC ${ocgObjNum} 0 R >>\nendobj\n`,
    );

    const closeObj = nextObj++;
    newXRefEntries.set(closeObj, { typ: 1, f1: out.length, f2: 0 });
    out.pushAscii(
      `${closeObj} 0 obj\n<< /Type /Annot /Subtype /Link /Rect ${fmtRect(closeRect)} /F 0 /Border [0 0 0] /H /I /NM (${HINT_PREFIX}-close) /A << /S /SetOCGState /State [/OFF ${ocgObjNum} 0 R] >> /OC ${ocgObjNum} 0 R >>\nendobj\n`,
    );

    const mergedAnnots = [
      ...existingPage1Annots.map(serializePDFVal),
      `${stampObj} 0 R`,
      `${uriObj} 0 R`,
      `${closeObj} 0 R`,
    ];
    newXRefEntries.set(page1.objNum, { typ: 1, f1: out.length, f2: 0 });
    const page1Entries = page1.dict
      .filter((kv) => kv.key !== 'Annots')
      .map((kv) => ` /${escapePDFName(kv.key)} ${serializePDFVal(kv.val)}`)
      .join('');
    out.pushAscii(`${page1.objNum} 0 obj\n<<${page1Entries} /Annots [${mergedAnnots.join(' ')}] >>\nendobj\n`);

    const staleOcgNum = st.existingOcgNum && st.existingOcgNum !== ocgObjNum ? st.existingOcgNum : 0;
    let ocgItems = [];
    let dDictEntries = [];
    let onItems = [];
    let offItems = [];
    let asItems = [];
    let extraOcpEntries = [];

    if (existingOcProps) {
      for (const kv of existingOcProps.dict) {
        if (kv.key !== 'OCGs' && kv.key !== 'D') extraOcpEntries.push(kv);
      }
      const ocgsArr = dictGet(existingOcProps, 'OCGs');
      const resolvedOcgs = ocgsArr ? await idx.resolveValue(ocgsArr).catch(() => null) : null;
      if (resolvedOcgs && resolvedOcgs.kind === 'array') {
        ocgItems = resolvedOcgs.items.filter((it) => !(staleOcgNum && it.kind === 'ref' && it.objNum === staleOcgNum));
      }

      const dRaw = dictGet(existingOcProps, 'D');
      const dResolved = dRaw ? await idx.resolveValue(dRaw).catch(() => null) : null;
      if (dResolved && dResolved.kind === 'dict') {
        for (const kv of dResolved.dict) {
          if (kv.key === 'ON') {
            const r = await idx.resolveValue(kv.val).catch(() => null);
            if (r && r.kind === 'array') {
              onItems = r.items.filter((it) => !(staleOcgNum && it.kind === 'ref' && it.objNum === staleOcgNum));
            }
          } else if (kv.key === 'OFF') {
            const r = await idx.resolveValue(kv.val).catch(() => null);
            if (r && r.kind === 'array') {
              offItems = r.items.filter((it) => !(it.kind === 'ref' && (it.objNum === ocgObjNum || (staleOcgNum && it.objNum === staleOcgNum))));
            }
          } else if (kv.key === 'AS') {
            const r = await idx.resolveValue(kv.val).catch(() => null);
            if (r && r.kind === 'array') {
              for (const item of r.items) {
                if (!staleOcgNum || item.kind !== 'dict') {
                  asItems.push(item);
                  continue;
                }
                const ocgs = dictGet(item, 'OCGs');
                if (!ocgs || ocgs.kind !== 'array') {
                  asItems.push(item);
                  continue;
                }
                const filtered = ocgs.items.filter((it) => !(it.kind === 'ref' && it.objNum === staleOcgNum));
                if (filtered.length === 0) continue;
                asItems.push({
                  kind: 'dict',
                  dict: item.dict.map((dkv) => (dkv.key === 'OCGs' ? { key: 'OCGs', val: { kind: 'array', items: filtered } } : dkv)),
                });
              }
            }
          } else {
            dDictEntries.push(kv);
          }
        }
      }
    }

    appendUniqueRef(ocgItems, ocgObjNum);
    appendUniqueRef(onItems, ocgObjNum);

    const hasAsEvent = (evtName) => asItems.some((item) => {
      if (item.kind !== 'dict') return false;
      const ev = dictGet(item, 'Event');
      const ocgs = dictGet(item, 'OCGs');
      if (!ev || ev.kind !== 'name' || ev.raw !== evtName || !ocgs || ocgs.kind !== 'array') return false;
      return ocgs.items.some((r) => r.kind === 'ref' && r.objNum === ocgObjNum);
    });
    if (!hasAsEvent('Print')) {
      asItems.push({
        kind: 'dict',
        dict: [
          { key: 'Event', val: { kind: 'name', raw: 'Print' } },
          { key: 'OCGs', val: { kind: 'array', items: [ocgRef] } },
          { key: 'Category', val: { kind: 'array', items: [{ kind: 'name', raw: 'Print' }] } },
        ],
      });
    }
    if (!hasAsEvent('View')) {
      asItems.push({
        kind: 'dict',
        dict: [
          { key: 'Event', val: { kind: 'name', raw: 'View' } },
          { key: 'OCGs', val: { kind: 'array', items: [ocgRef] } },
          { key: 'Category', val: { kind: 'array', items: [{ kind: 'name', raw: 'View' }] } },
        ],
      });
    }

    const dFinal = [
      ...dDictEntries,
      { key: 'ON', val: { kind: 'array', items: onItems } },
      ...(offItems.length ? [{ key: 'OFF', val: { kind: 'array', items: offItems } }] : []),
      { key: 'AS', val: { kind: 'array', items: asItems } },
    ];
    ocPropsVal = {
      kind: 'dict',
      dict: [
        ...extraOcpEntries,
        { key: 'OCGs', val: { kind: 'array', items: ocgItems } },
        { key: 'D', val: { kind: 'dict', dict: dFinal } },
      ],
    };
  }

  newXRefEntries.set(idx.rootObjNum, { typ: 1, f1: out.length, f2: 0 });
  const existingPageMode = dictGet(catVal, 'PageMode');
  const shouldSetPageMode = wantHint && (!existingPageMode || (existingPageMode.kind === 'name' && existingPageMode.raw === 'UseNone'));
  const catEntries = catVal.dict
    .filter((kv) => {
      if (kv.key === 'Names') return false;
      if (ocPropsVal && kv.key === 'OCProperties') return false;
      if (shouldSetPageMode && kv.key === 'PageMode') return false;
      return true;
    })
    .map((kv) => ` /${escapePDFName(kv.key)} ${serializePDFVal(kv.val)}`)
    .join('');
  let catExtra = ` /Names ${namesObj} 0 R`;
  if (ocPropsVal) catExtra += ` /OCProperties ${serializePDFVal(ocPropsVal)}`;
  if (shouldSetPageMode) catExtra += ' /PageMode /UseAttachments';
  out.pushAscii(`${idx.rootObjNum} 0 obj\n<<${catEntries}${catExtra} >>\nendobj\n`);

  let hasType2Entries = false;
  let maxF2 = 0;
  for (const ent of newXRefEntries.values()) {
    if (ent.typ === 2) hasType2Entries = true;
    if (ent.f2 > maxF2) maxF2 = ent.f2;
  }

  if (idx.usesXRefStream || hasType2Entries) {
    const xrefObj = nextObj++;
    const xrefOffset = out.length;
    newXRefEntries.set(xrefObj, { typ: 1, f1: xrefOffset, f2: 0 });

    const writtenNums = Array.from(newXRefEntries.keys()).sort((a, b) => a - b);
    const groups = groupContiguousObjNums(writtenNums);
    const offsetBytes = xrefOffset > 0xffffffff ? 6 : 4;
    const f2Bytes = maxF2 > 255 ? 2 : 1;
    const rowLen = 1 + offsetBytes + f2Bytes;
    const xstream = new Uint8Array(writtenNums.length * rowLen);
    for (let i = 0; i < writtenNums.length; i++) {
      const ent = newXRefEntries.get(writtenNums[i]);
      writeXRefRow(xstream, i * rowLen, ent.typ, ent.f1, ent.f2, offsetBytes, f2Bytes);
    }
    const indexStr = groups.map((g) => `${g.start} ${g.count}`).join(' ');
    let xHdr = `${xrefObj} 0 obj\n<< /Type /XRef /Size ${nextObj} /W [1 ${offsetBytes} ${f2Bytes}] /Index [${indexStr}] /Root ${idx.rootObjNum} 0 R /Prev ${prevXRefOffset}`;
    if (idx.infoRef) xHdr += ` /Info ${serializePDFVal(idx.infoRef)}`;
    if (idx.idVal) xHdr += ` /ID ${serializePDFVal(idx.idVal)}`;
    xHdr += ` /Length ${xstream.length} >>\nstream\n`;
    out.pushAscii(xHdr);
    out.pushBytes(xstream);
    out.pushAscii(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`);
  } else {
    const xrefOffset = out.length;
    const writtenNums = Array.from(newXRefEntries.keys()).sort((a, b) => a - b);
    const groups = groupContiguousObjNums(writtenNums);
    let xTxt = 'xref\n';
    for (const g of groups) {
      xTxt += `${g.start} ${g.count}\n`;
      for (let obj = g.start; obj < g.start + g.count; obj++) {
        const ent = newXRefEntries.get(obj);
        const flag = ent.typ === 0 ? 'f' : 'n';
        xTxt += `${String(ent.f1).padStart(10, '0')} ${String(ent.f2).padStart(5, '0')} ${flag} \n`;
      }
    }
    xTxt += `trailer\n<< /Size ${nextObj} /Root ${idx.rootObjNum} 0 R /Prev ${prevXRefOffset}`;
    if (idx.infoRef) xTxt += ` /Info ${serializePDFVal(idx.infoRef)}`;
    if (idx.idVal) xTxt += ` /ID ${serializePDFVal(idx.idVal)}`;
    xTxt += ` >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    out.pushAscii(xTxt);
  }

  return { bytes: out.toUint8Array(), plan: report, appliedMode };
}

/**
 * Attaches files to a PDF (`options.mode`: `'replace'` default or `'append'`).
 * Optionally attaches a non-printable OCG viewer-hint pill (`pdfstage-hint`) on page 1.
 * @param {Uint8Array} pdfBytes
 * @param {Array<{name: string, mime?: string, description?: string, data: Uint8Array, compress?: boolean}>} files
 * @param {{ viewerHint?: boolean, mode?: 'replace'|'append' }} [options]
 */
export async function attachFilesToPdf(pdfBytes, files, options = {}) {
  const { bytes } = await attachFilesToPdfWithReport(pdfBytes, files, options);
  return bytes;
}
