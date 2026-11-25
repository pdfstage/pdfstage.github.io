// Pure-JS uncompressed ZIP (Method 0 / Store) archive writer for batch .stage.pdf export.
// Standard IEEE CRC-32 + UTF-8 filenames (flag bit 11).

const utf8Encoder = new TextEncoder();

const CRC32_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    tbl[i] = c >>> 0;
  }
  return tbl;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const yr = Math.max(1980, date.getFullYear());
  const dosTime = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((yr - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Builds a standard ZIP archive (compression method 0) from [{ name, data }].
 * @param {Array<{name: string, data: Uint8Array, date?: Date}>} entries
 * @returns {Uint8Array}
 */
export function buildStoreZip(entries) {
  const prepared = [];
  let totalSize = 22; // EOCD

  for (const e of entries) {
    const nameBytes = utf8Encoder.encode(e.name);
    const data = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
    const sum = crc32(data);
    const { dosTime, dosDate } = dosDateTime(e.date);
    totalSize += 30 + nameBytes.length + data.length + 46 + nameBytes.length;
    prepared.push({ nameBytes, data, crc: sum, dosTime, dosDate, offset: 0 });
  }

  if (totalSize > 0xfffffffe || prepared.length > 0xffff) {
    throw new Error('ZIP-Archiv überschreitet das 4-GiB-Standardlimit — bitte in kleineren Paketen herunterladen.');
  }

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let pos = 0;

  for (const item of prepared) {
    item.offset = pos;
    view.setUint32(pos, 0x04034b50, true); // Local file header signature
    view.setUint16(pos + 4, 20, true); // Version needed
    view.setUint16(pos + 6, 0x0800, true); // UTF-8 flag
    view.setUint16(pos + 8, 0, true); // Method 0: Store
    view.setUint16(pos + 10, item.dosTime, true);
    view.setUint16(pos + 12, item.dosDate, true);
    view.setUint32(pos + 14, item.crc, true);
    view.setUint32(pos + 18, item.data.length, true);
    view.setUint32(pos + 22, item.data.length, true);
    view.setUint16(pos + 26, item.nameBytes.length, true);
    view.setUint16(pos + 28, 0, true);
    pos += 30;
    out.set(item.nameBytes, pos);
    pos += item.nameBytes.length;
    out.set(item.data, pos);
    pos += item.data.length;
  }

  const cdOffset = pos;
  for (const item of prepared) {
    view.setUint32(pos, 0x02014b50, true); // Central directory signature
    view.setUint16(pos + 4, 20, true);
    view.setUint16(pos + 6, 20, true);
    view.setUint16(pos + 8, 0x0800, true);
    view.setUint16(pos + 10, 0, true);
    view.setUint16(pos + 12, item.dosTime, true);
    view.setUint16(pos + 14, item.dosDate, true);
    view.setUint32(pos + 16, item.crc, true);
    view.setUint32(pos + 20, item.data.length, true);
    view.setUint32(pos + 24, item.data.length, true);
    view.setUint16(pos + 28, item.nameBytes.length, true);
    view.setUint16(pos + 30, 0, true);
    view.setUint16(pos + 32, 0, true);
    view.setUint16(pos + 34, 0, true);
    view.setUint16(pos + 36, 0, true);
    view.setUint32(pos + 38, 0, true);
    view.setUint32(pos + 42, item.offset, true);
    pos += 46;
    out.set(item.nameBytes, pos);
    pos += item.nameBytes.length;
  }

  const cdSize = pos - cdOffset;
  view.setUint32(pos, 0x06054b50, true); // EOCD
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, prepared.length, true);
  view.setUint16(pos + 10, prepared.length, true);
  view.setUint32(pos + 12, cdSize, true);
  view.setUint32(pos + 16, cdOffset, true);
  view.setUint16(pos + 20, 0, true);

  return out;
}
