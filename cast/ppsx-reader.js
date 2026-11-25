// Streaming OOXML (.ppsx / .pptx) ZIP & deck metadata reader for pdfstage /cast.
// Pure ES module (zero dependencies) — works identically in browsers and Node.js.

const AUDIO_EXT_RE = /\.(m4a|mp3|wav|wma|aac|ogg|opus|flac|webm)$/i;
const HIDDEN_SLIDE_RE = /<p:sld\b[^>]*\bshow="0"/s;
const ADV_TM_RE = /<p:transition\b[^>]*\badvTm="(\d+)"/;
const SP_RE = /<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g;
const PIC_RE = /<p:pic\b[^>]*>[\s\S]*?<\/p:pic>/g;
const AP_RE = /<a:p\b[^>]*>[\s\S]*?<\/a:p>/g;
const AT_RE = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
const BREAK_RE = /<a:(?:br|tab)\b[^>]*\/?>/g;
const AUDIO_LINK_RE = /<a:(?:audioFile|wavAudioFile)\b[^>]*\br:(?:link|embed)="([^"]+)"/;
const EMBED_RE = /<p14:media\b[^>]*\br:embed="([^"]+)"|r:embed="([^"]+)"/;
const SPID_RE = /cNvPr\b[^>]*\bid="(\d+)"/;
const SPTGT_RE = /spid="(\d+)"/;

const textDecoder = new TextDecoder('utf-8');

export function decodeXmlEntities(str) {
  if (!str || !str.includes('&')) return str || '';
  return str.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, ent) => {
    switch (ent) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const cp = ent.startsWith('#x') || ent.startsWith('#X')
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
    }
  });
}

function getAttr(tagText, attrName) {
  const re = new RegExp(`(?:^|\\s)${attrName}=(["'])([\\s\\S]*?)\\1`);
  const m = re.exec(tagText);
  return m ? decodeXmlEntities(m[2]) : '';
}

export function resolveZipPath(baseDir, target) {
  let clean = (target || '').replace(/\\/g, '/').trim();
  if (!clean) return '';
  if (clean.startsWith('/')) {
    clean = clean.slice(1);
  } else if (baseDir) {
    clean = `${baseDir.replace(/\/+$/, '')}/${clean}`;
  }
  const parts = [];
  for (const seg of clean.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

function collapseWs(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

export function truncateWords(str, maxRunes = 80) {
  const clean = (str || '').trim();
  if (!clean) return '';
  const runes = Array.from(clean);
  if (runes.length <= maxRunes) return clean;
  const cut = Math.max(1, maxRunes - 2);
  let sub = runes.slice(0, cut).join('').trim();
  const lastSpace = Math.max(sub.lastIndexOf(' '), sub.lastIndexOf('\t'));
  if (lastSpace > Math.floor(sub.length / 2)) {
    sub = sub.slice(0, lastSpace).trim();
  }
  return `${sub} \u2026`;
}

async function inflateRaw(compressedBytes) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(compressedBytes);
      controller.close();
    },
  }).pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function createSliceReader(source) {
  if (source instanceof Uint8Array) {
    return {
      size: source.byteLength,
      async read(start, end) {
        return source.subarray(start, end);
      },
    };
  }
  if (source && typeof source.slice === 'function' && typeof source.size === 'number') {
    return {
      size: source.size,
      async read(start, end) {
        const buf = await source.slice(start, end).arrayBuffer();
        return new Uint8Array(buf);
      },
    };
  }
  throw new Error('Ungültige ZIP-Quelle (erwartet File/Blob oder Uint8Array)');
}

function u64ToNumber(view, offset) {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  return hi * 4294967296 + lo;
}

/**
 * Opens a ZIP archive for random-access streaming reads via File.slice().
 * Only reads the Central Directory and explicitly requested entries (ignores broken CRCs).
 */
export async function openZip(source) {
  const reader = createSliceReader(source);
  const size = reader.size;
  if (size < 22) {
    throw new Error('Datei ist zu klein für ein gültiges ZIP/OOXML-Paket');
  }

  const tailLen = Math.min(size, 65557);
  const tailOffset = size - tailLen;
  const tail = await reader.read(tailOffset, size);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  let eocdRel = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === 0x06054b50) {
      const commentLen = tailView.getUint16(i + 20, true);
      if (i + 22 + commentLen === tail.byteLength) {
        eocdRel = i;
        break;
      }
    }
  }
  if (eocdRel < 0) {
    throw new Error('Kein ZIP-Inhaltsverzeichnis (EOCD) gefunden — ist das eine .ppsx/.pptx-Datei?');
  }

  let cdSize = tailView.getUint32(eocdRel + 12, true);
  let cdOffset = tailView.getUint32(eocdRel + 16, true);
  let totalEntries = tailView.getUint16(eocdRel + 10, true);

  if (cdSize === 0xffffffff || cdOffset === 0xffffffff || totalEntries === 0xffff) {
    const locPos = eocdRel - 20;
    if (locPos >= 0 && tailView.getUint32(locPos, true) === 0x07064b50) {
      const z64EocdOffset = u64ToNumber(tailView, locPos + 8);
      if (z64EocdOffset >= 0 && z64EocdOffset + 56 <= size) {
        const z64 = await reader.read(z64EocdOffset, z64EocdOffset + 56);
        const z64View = new DataView(z64.buffer, z64.byteOffset, z64.byteLength);
        if (z64View.getUint32(0, true) === 0x06064b50) {
          totalEntries = u64ToNumber(z64View, 32);
          cdSize = u64ToNumber(z64View, 40);
          cdOffset = u64ToNumber(z64View, 48);
        }
      }
    }
  }

  if (cdOffset < 0 || cdOffset + cdSize > size) {
    throw new Error('Ungültiges ZIP Central Directory');
  }

  const cdBytes = await reader.read(cdOffset, cdOffset + cdSize);
  const cdView = new DataView(cdBytes.buffer, cdBytes.byteOffset, cdBytes.byteLength);
  const entries = new Map();

  let pos = 0;
  for (let i = 0; i < totalEntries && pos + 46 <= cdBytes.byteLength; i++) {
    if (cdView.getUint32(pos, true) !== 0x02014b50) break;
    const flags = cdView.getUint16(pos + 8, true);
    const method = cdView.getUint16(pos + 10, true);
    let compSize = cdView.getUint32(pos + 20, true);
    let uncompSize = cdView.getUint32(pos + 24, true);
    const nameLen = cdView.getUint16(pos + 28, true);
    const extraLen = cdView.getUint16(pos + 30, true);
    const commentLen = cdView.getUint16(pos + 32, true);
    let localOffset = cdView.getUint32(pos + 42, true);

    const nameBytes = cdBytes.subarray(pos + 46, pos + 46 + nameLen);
    const name = ((flags & 0x0800) ? textDecoder.decode(nameBytes) : textDecoder.decode(nameBytes))
      .replace(/\\/g, '/');

    if (extraLen > 0 && (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff)) {
      let ep = pos + 46 + nameLen;
      const epEnd = ep + extraLen;
      while (ep + 4 <= epEnd) {
        const headerId = cdView.getUint16(ep, true);
        const fieldSize = cdView.getUint16(ep + 2, true);
        if (headerId === 0x0001) {
          let fp = ep + 4;
          if (uncompSize === 0xffffffff && fp + 8 <= ep + 4 + fieldSize) {
            uncompSize = u64ToNumber(cdView, fp);
            fp += 8;
          }
          if (compSize === 0xffffffff && fp + 8 <= ep + 4 + fieldSize) {
            compSize = u64ToNumber(cdView, fp);
            fp += 8;
          }
          if (localOffset === 0xffffffff && fp + 8 <= ep + 4 + fieldSize) {
            localOffset = u64ToNumber(cdView, fp);
          }
          break;
        }
        ep += 4 + fieldSize;
      }
    }

    entries.set(name, { name, method, compSize, uncompSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  async function readEntry(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    const hdr = await reader.read(entry.localOffset, Math.min(size, entry.localOffset + 30));
    const hdrView = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
    if (hdrView.getUint32(0, true) !== 0x04034b50) {
      throw new Error(`Defekter ZIP-Header bei ${name}`);
    }
    const nameLen = hdrView.getUint16(26, true);
    const extraLen = hdrView.getUint16(28, true);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + entry.compSize;
    if (dataEnd > size) {
      throw new Error(`ZIP-Eintrag ${name} abgeschnitten`);
    }
    const raw = await reader.read(dataStart, dataEnd);
    if (entry.method === 0) {
      return raw.slice();
    }
    if (entry.method === 8) {
      return inflateRaw(raw);
    }
    throw new Error(`Nicht unterstützte ZIP-Kompression (${entry.method}) bei ${name}`);
  }

  async function readText(name) {
    const bytes = await readEntry(name);
    return bytes ? textDecoder.decode(bytes) : null;
  }

  return {
    entries,
    has: (name) => entries.has(name),
    readEntry,
    readText,
  };
}

export function parseRelationshipsXml(xml) {
  const map = new Map();
  if (!xml) return map;
  const relRe = /<Relationship\b([^>]*?)\/?>/g;
  let m;
  while ((m = relRe.exec(xml)) !== null) {
    const id = getAttr(m[1], 'Id');
    const target = getAttr(m[1], 'Target');
    if (id && target) map.set(id, target);
  }
  return map;
}

export function parsePresentationXml(xml) {
  const rids = [];
  if (!xml) return rids;
  const listMatch = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(xml);
  const scope = listMatch ? listMatch[1] : xml;
  const sldRe = /<p:sldId\b([^>]*?)\/?>/g;
  let m;
  while ((m = sldRe.exec(scope)) !== null) {
    const rid = getAttr(m[1], 'r:id');
    if (rid) rids.push(rid);
  }
  return rids;
}

function extractParagraphText(xmlChunk) {
  const paras = [];
  for (const pMatch of xmlChunk.match(AP_RE) || []) {
    const parts = pMatch.split(BREAK_RE);
    const lineParts = [];
    for (const part of parts) {
      let runText = '';
      AT_RE.lastIndex = 0;
      let tm;
      while ((tm = AT_RE.exec(part)) !== null) {
        runText += decodeXmlEntities(tm[1]);
      }
      lineParts.push(runText);
    }
    paras.push(lineParts.join(' '));
  }
  return collapseWs(paras.join(' '));
}

function extractTitle(xml) {
  for (const sp of xml.match(SP_RE) || []) {
    if (!/type="(?:title|ctrTitle)"/.test(sp)) continue;
    const text = extractParagraphText(sp);
    if (text) return text;
    let fallback = '';
    AT_RE.lastIndex = 0;
    let tm;
    while ((tm = AT_RE.exec(sp)) !== null) {
      fallback += (fallback ? ' ' : '') + decodeXmlEntities(tm[1]);
    }
    const clean = collapseWs(fallback);
    if (clean) return clean;
  }
  return '';
}

function extractAudioOrder(xml, rels, slideDir, zipEntries, missingOut) {
  const bySpid = new Map();
  const orderedPics = [];

  for (const pic of xml.match(PIC_RE) || []) {
    const linkMatch = AUDIO_LINK_RE.exec(pic);
    if (!linkMatch) continue;
    let relTarget = rels.get(linkMatch[1]) || '';
    const embMatch = EMBED_RE.exec(pic);
    if (embMatch) {
      const rid = embMatch[1] || embMatch[2];
      const embTarget = rels.get(rid);
      if (embTarget) relTarget = embTarget;
    }
    if (!relTarget) continue;

    let resolved = resolveZipPath(slideDir, relTarget);
    if (!zipEntries.has(resolved)) {
      const base = relTarget.split('/').pop();
      const mediaFallback = `ppt/media/${base}`;
      if (zipEntries.has(mediaFallback)) resolved = mediaFallback;
    }

    if (!AUDIO_EXT_RE.test(resolved)) continue;
    const spidMatch = SPID_RE.exec(pic);
    if (!spidMatch) continue;
    const spid = spidMatch[1];

    if (!zipEntries.has(resolved)) {
      missingOut.push(resolved.split('/').pop() || resolved);
      continue;
    }
    bySpid.set(spid, resolved);
    orderedPics.push(resolved);
  }

  if (bySpid.size === 0) return [];

  const order = [];
  const seen = new Set();

  // Preferred order from <p:timing> playFrom blocks (matches deck.go).
  const playFromBlocks = xml.split('playFrom');
  for (let i = 1; i < playFromBlocks.length; i++) {
    const tgt = SPTGT_RE.exec(playFromBlocks[i]);
    if (tgt) {
      const path = bySpid.get(tgt[1]);
      if (path && !seen.has(path)) {
        seen.add(path);
        order.push(path);
      }
    }
  }

  // Fallback for timing nodes referencing audio without playFrom attribute.
  const audioNodeRe = /<p:audio\b[\s\S]*?<\/p:audio>/g;
  let am;
  while ((am = audioNodeRe.exec(xml)) !== null) {
    const tgt = SPTGT_RE.exec(am[0]);
    if (tgt) {
      const path = bySpid.get(tgt[1]);
      if (path && !seen.has(path)) {
        seen.add(path);
        order.push(path);
      }
    }
  }

  // Append any unreferenced audio shapes in shape order.
  for (const path of orderedPics) {
    if (!seen.has(path)) {
      seen.add(path);
      order.push(path);
    }
  }

  return order;
}

export function parseSlideXml(xml, rels, slidePath, zipEntries, missingOut = []) {
  const hidden = HIDDEN_SLIDE_RE.test(xml);
  const advMatch = ADV_TM_RE.exec(xml);
  const advMs = advMatch ? parseInt(advMatch[1], 10) : 0;
  const advance = Number.isFinite(advMs) && advMs > 0 ? advMs / 1000 : 0;
  const title = extractTitle(xml);
  const text = extractParagraphText(xml);
  const slideDir = slidePath.includes('/') ? slidePath.slice(0, slidePath.lastIndexOf('/')) : '';
  const audio = extractAudioOrder(xml, rels, slideDir, zipEntries, missingOut);
  return {
    name: slidePath.split('/').pop() || slidePath,
    path: slidePath,
    hidden,
    advance,
    title,
    text,
    tooltipTitle: truncateWords(title || text, 80),
    audio,
  };
}

/**
 * Parses a .ppsx / .pptx archive (without reading heavy media payloads into memory).
 */
export async function parsePpsxDeck(source, { includeHidden = false } = {}) {
  const zip = source && source.entries && source.readEntry ? source : await openZip(source);

  const presXml = await zip.readText('ppt/presentation.xml');
  if (!presXml) {
    throw new Error('ppt/presentation.xml fehlt — ist das eine PowerPoint-Datei?');
  }
  const presRelsXml = await zip.readText('ppt/_rels/presentation.xml.rels');
  if (!presRelsXml) {
    throw new Error('ppt/_rels/presentation.xml.rels fehlt');
  }

  const sldRids = parsePresentationXml(presXml);
  const presRels = parseRelationshipsXml(presRelsXml);

  const slides = [];
  const missing = [];
  let hiddenCount = 0;

  for (const rid of sldRids) {
    const target = presRels.get(rid);
    if (!target) continue;
    const slidePath = resolveZipPath('ppt', target);
    const slideXml = await zip.readText(slidePath);
    if (!slideXml) continue;

    if (HIDDEN_SLIDE_RE.test(slideXml)) {
      hiddenCount++;
      if (!includeHidden) continue;
    }

    const lastSlash = slidePath.lastIndexOf('/');
    const slideDir = lastSlash >= 0 ? slidePath.slice(0, lastSlash) : '';
    const slideFile = lastSlash >= 0 ? slidePath.slice(lastSlash + 1) : slidePath;
    const relsPath = slideDir ? `${slideDir}/_rels/${slideFile}.rels` : `_rels/${slideFile}.rels`;
    const slideRelsXml = await zip.readText(relsPath);
    const slideRels = parseRelationshipsXml(slideRelsXml);

    const parsed = parseSlideXml(slideXml, slideRels, slidePath, zip.entries, missing);
    slides.push(parsed);
  }

  if (slides.length === 0) {
    throw new Error('Keine Folien gefunden');
  }

  let audioTrackCount = 0;
  for (const s of slides) {
    audioTrackCount += s.audio.length;
  }

  return {
    zip,
    slides,
    hiddenCount,
    audioTrackCount,
    missing,
  };
}
