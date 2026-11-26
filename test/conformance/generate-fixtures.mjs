// Generates the deterministic shared PDF conformance fixtures and specification cases.json
// used by both JS (/cast/pdf-attach.js) and Go CLI (tools/assistant/ppsx).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { attachFilesToPdf } from '../../cast/pdf-attach.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');
fs.mkdirSync(fixturesDir, { recursive: true });

const enc = (s) => Buffer.from(s, 'latin1');

function buildClassicPDF(objs) {
  const chunks = [enc('%PDF-1.4\n')];
  let len = chunks[0].length;
  const offs = [0];
  for (let i = 0; i < objs.length; i++) {
    offs.push(len);
    const chunk = enc(`${i + 1} 0 obj\n${objs[i]}\nendobj\n`);
    chunks.push(chunk);
    len += chunk.length;
  }
  const xref = len;
  let xr = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    xr += `${String(offs[i]).padStart(10, '0')} 00000 n \n`;
  }
  xr += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  chunks.push(enc(xr));
  return new Uint8Array(Buffer.concat(chunks));
}

function buildTiny1P(w = 720, h = 405) {
  return buildClassicPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << >> /Contents 4 0 R >>`,
    '<< /Length 0 >>\nstream\n\nendstream',
  ]);
}

function buildTiny2P(w = 720, h = 405) {
  return buildClassicPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << >> /Contents 5 0 R >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << >> /Contents 5 0 R >>`,
    '<< /Length 0 >>\nstream\n\nendstream',
  ]);
}

function buildClassicDests() {
  return buildClassicPDF([
    '<< /Type /Catalog /Pages 2 0 R /Names 4 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150] /Resources << >> >>',
    '<< /Dests 5 0 R >>',
    '<< /Names [] >>',
  ]);
}

function buildRotate90OCG() {
  return buildClassicPDF([
    '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R] /D << /ON [6 0 R] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 540 720] /CropBox [10 10 530 710] /Rotate 90 /Resources << >> /Annots [5 0 R] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Type /Annot /Subtype /Highlight /Rect [20 20 120 40] /F 4 /NM (user-mark-1) >>',
    '<< /Type /OCG /Name (UserLayer) >>',
  ]);
}

function buildXRefStreamObjStm() {
  const chunks = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let curLen = chunks[0].length;
  const off = new Array(7).fill(0);

  const pushStr = (s) => {
    const b = enc(s);
    chunks.push(b);
    curLen += b.length;
  };
  const pushBuf = (b) => {
    chunks.push(b);
    curLen += b.length;
  };

  off[3] = curLen;
  pushStr('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150] /Resources << >> /Contents 4 0 R >>\nendobj\n');

  const stream4 = '0 0 1 rg 10 10 80 60 re f\n';
  off[4] = curLen;
  pushStr(`4 0 obj\n<< /Length ${stream4.length} >>\nstream\n${stream4}endstream\nendobj\n`);

  const obj1Body = '<< /Type /Catalog /Pages 2 0 R /Names << /Dests 99 0 R >> >>';
  const obj2Body = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  const header = `1 0 2 ${obj1Body.length + 1} `;
  const compObjStm = zlib.deflateSync(enc(`${header}${obj1Body} ${obj2Body}`));

  off[5] = curLen;
  pushStr(`5 0 obj\n<< /Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode /Length ${compObjStm.length} >>\nstream\n`);
  pushBuf(compObjStm);
  pushStr('\nendstream\nendobj\n');

  off[6] = curLen;
  const entries = [
    [0, 0, 255],
    [2, 5, 0],
    [2, 5, 1],
    [1, off[3], 0],
    [1, off[4], 0],
    [1, off[5], 0],
    [1, off[6], 0],
  ];
  const rows = entries.map(([typ, f1, f2]) => [
    typ & 0xff,
    (f1 >> 16) & 0xff,
    (f1 >> 8) & 0xff,
    f1 & 0xff,
    f2 & 0xff,
  ]);
  const pngBytes = [];
  let prev = [0, 0, 0, 0, 0];
  for (const row of rows) {
    pngBytes.push(2); // PNG Up predictor
    for (let c = 0; c < 5; c++) pngBytes.push((row[c] - prev[c]) & 0xff);
    prev = row;
  }
  const compXRef = zlib.deflateSync(Buffer.from(pngBytes));
  pushStr(`6 0 obj\n<< /Type /XRef /Size 7 /Root 1 0 R /W [1 3 1] /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 5 >> /Length ${compXRef.length} >>\nstream\n`);
  pushBuf(compXRef);
  pushStr(`\nendstream\nendobj\nstartxref\n${off[6]}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(chunks));
}

function buildFlatSingleRevAudio() {
  const audioData = 'FLAT-SINGLE-REV-AUDIO';
  return buildClassicPDF([
    '<< /Type /Catalog /Pages 2 0 R /Names 5 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150] >>',
    `<< /Type /EmbeddedFile /Length ${audioData.length} >>\nstream\n${audioData}\nendstream`,
    '<< /EmbeddedFiles 6 0 R >>',
    '<< /Names [(audio.opus) 7 0 R] >>',
    '<< /Type /Filespec /F (audio.opus) /UF (audio.opus) /EF << /F 4 0 R /UF 4 0 R >> >>',
  ]);
}

function buildLinearizedLike() {
  // Deterministic 2-pass layout so first-page xref's backwards /Prev points forward to main xref
  // using fixed 10-digit offsets.
  const layout = (mainXRefGuess) => {
    const hdr = '%PDF-1.4\n';
    const obj1 = `1 0 obj\n<< /Linearized 1 /L 0000000000 /O 4 /N 1 /T ${String(mainXRefGuess).padStart(10, '0')} >>\nendobj\n`;
    const firstXRefOff = hdr.length + obj1.length;
    const p1XRefPlaceholder = (o2, o3) =>
      `xref\n2 2\n${String(o2).padStart(10, '0')} 00000 n \n${String(o3).padStart(10, '0')} 00000 n \n` +
      `trailer\n<< /Size 6 /Root 2 0 R /Prev ${String(mainXRefGuess).padStart(10, '0')} >>\nstartxref\n0\n%%EOF\n`;
    const sampleP1XRef = p1XRefPlaceholder(0, 0);
    const bodyStart = firstXRefOff + sampleP1XRef.length;
    const obj2 = '2 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n';
    const obj3 = '3 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n';
    const obj4 = '4 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 720 405] /Resources << >> /Contents 5 0 R >>\nendobj\n';
    const obj5 = '5 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n';
    const off1 = hdr.length;
    const off2 = bodyStart;
    const off3 = off2 + obj2.length;
    const off4 = off3 + obj3.length;
    const off5 = off4 + obj4.length;
    const mainXRefOff = off5 + obj5.length;
    const p1XRef = p1XRefPlaceholder(off2, off3);
    const mainXRef =
      `xref\n0 2\n0000000000 65535 f \n${String(off1).padStart(10, '0')} 00000 n \n` +
      `4 2\n${String(off4).padStart(10, '0')} 00000 n \n${String(off5).padStart(10, '0')} 00000 n \n` +
      `trailer\n<< /Size 6 >>\nstartxref\n${firstXRefOff}\n%%EOF\n`;
    return { mainXRefOff, text: hdr + obj1 + p1XRef + obj2 + obj3 + obj4 + obj5 + mainXRef };
  };
  const pass1 = layout(0);
  const pass2 = layout(pass1.mainXRefOff);
  return enc(pass2.text);
}

function writeXRefRow4_1(buf, off, typ, f1, f2) {
  buf[off] = typ & 0xff;
  buf[off + 1] = (f1 >>> 24) & 0xff;
  buf[off + 2] = (f1 >>> 16) & 0xff;
  buf[off + 3] = (f1 >>> 8) & 0xff;
  buf[off + 4] = f1 & 0xff;
  buf[off + 5] = f2 & 0xff;
}

async function buildViewerAnnotClassic() {
  const base = buildTiny2P();
  const staged = await attachFilesToPdf(base, [
    { name: 'pdfstage.json', mime: 'application/json', data: enc('{"v":1,"title":"Vorlesung","audio":"audio.opus"}'), compress: true },
    { name: 'audio.opus', mime: 'audio/ogg', data: enc('VIEWER-OLD-AUDIO-V1-'.repeat(80)), compress: false },
  ], { viewerHint: true });

  const txt = Buffer.from(staged).toString('latin1');
  const prevXRef = Number([...txt.matchAll(/startxref\s+(\d+)/g)].pop()[1]);
  const p1Annots = [...txt.matchAll(/3 0 obj\s+<<(.*?)\/Annots \[(.*?)\]\s*>>/gs)].pop()[2].trim();
  const baseSize = Number([...txt.matchAll(/\/Size\s+(\d+)/g)].pop()[1]);
  const a1Obj = baseSize;
  const a2Obj = baseSize + 1;

  const chunks = [Buffer.from(staged)];
  let cur = staged.length;
  const appendObj = (num, body) => {
    const o = cur;
    const b = enc(`${num} 0 obj\n${body}\nendobj\n`);
    chunks.push(b);
    cur += b.length;
    return o;
  };
  const offA1 = appendObj(a1Obj, '<< /Type /Annot /Subtype /Ink /Rect [10 10 80 80] /NM (viewer-p1) >>');
  const offA2 = appendObj(a2Obj, '<< /Type /Annot /Subtype /Highlight /Rect [20 20 90 50] /NM (viewer-p2) >>');
  const offP1 = appendObj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 405] /Resources << >> /Contents 5 0 R /Annots [${p1Annots} ${a1Obj} 0 R] >>`);
  const offP2 = appendObj(4, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 405] /Resources << >> /Contents 5 0 R /Annots [${a2Obj} 0 R] >>`);
  const xrOff = cur;
  const xr =
    `xref\n3 2\n${String(offP1).padStart(10, '0')} 00000 n \n${String(offP2).padStart(10, '0')} 00000 n \n` +
    `${a1Obj} 2\n${String(offA1).padStart(10, '0')} 00000 n \n${String(offA2).padStart(10, '0')} 00000 n \n` +
    `trailer\n<< /Size ${a2Obj + 1} /Root 1 0 R /Prev ${prevXRef} >>\nstartxref\n${xrOff}\n%%EOF\n`;
  chunks.push(enc(xr));
  return new Uint8Array(Buffer.concat(chunks));
}

async function buildViewerAnnotObjStm() {
  const base = buildXRefStreamObjStm();
  const staged = await attachFilesToPdf(base, [
    { name: 'pdfstage.json', mime: 'application/json', data: enc('{"v":1,"title":"S","audio":"audio.opus"}'), compress: true },
    { name: 'audio.opus', mime: 'audio/ogg', data: enc('OBJSTM-OLD-AUDIO-V1-'.repeat(40)), compress: false },
  ], { viewerHint: false });

  const txt = Buffer.from(staged).toString('latin1');
  const prevXRef = Number([...txt.matchAll(/startxref\s+(\d+)/g)].pop()[1]);
  const baseSize = Number([...txt.matchAll(/\/Size\s+(\d+)/g)].pop()[1]);
  const annot1Obj = baseSize;
  const objStmObj = baseSize + 1;
  const xrefObj = baseSize + 2;

  const chunks = [Buffer.from(staged)];
  let cur = staged.length;
  const pushStr = (s) => { const b = enc(s); chunks.push(b); cur += b.length; };
  const pushBuf = (b) => { chunks.push(b); cur += b.length; };

  const body1 = '<< /Type /Annot /Subtype /Highlight /Rect [15 15 95 45] /NM (viewer-objstm-p1) >>';
  const header = `${annot1Obj} 0 `;
  const compStm = zlib.deflateSync(enc(header + body1));

  const offObjStm = cur;
  pushStr(`${objStmObj} 0 obj\n<< /Type /ObjStm /N 1 /First ${header.length} /Filter /FlateDecode /Length ${compStm.length} >>\nstream\n`);
  pushBuf(compStm);
  pushStr('\nendstream\nendobj\n');

  const offP1 = cur;
  pushStr(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150] /Resources << >> /Contents 4 0 R /Annots [${annot1Obj} 0 R] >>\nendobj\n`);

  const xrefOff = cur;
  const rows = [
    [3, 1, offP1, 0],
    [annot1Obj, 2, objStmObj, 0],
    [objStmObj, 1, offObjStm, 0],
    [xrefObj, 1, xrefOff, 0],
  ].sort((a, b) => a[0] - b[0]);

  const xstream = Buffer.alloc(rows.length * 6);
  const idxParts = [];
  for (let i = 0; i < rows.length; i++) {
    writeXRefRow4_1(xstream, i * 6, rows[i][1], rows[i][2], rows[i][3]);
    idxParts.push(`${rows[i][0]} 1`);
  }
  pushStr(`${xrefObj} 0 obj\n<< /Type /XRef /Size ${xrefObj + 1} /W [1 4 1] /Index [${idxParts.join(' ')}] /Root 1 0 R /Prev ${prevXRef} /Length ${xstream.length} >>\nstream\n`);
  pushBuf(xstream);
  pushStr(`\nendstream\nendobj\nstartxref\n${xrefOff}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(chunks));
}

async function buildSignedAfterStage() {
  const base = buildTiny1P();
  const staged = await attachFilesToPdf(base, [
    { name: 'pdfstage.json', mime: 'application/json', data: enc('{"v":1,"audio":"audio.opus"}'), compress: true },
    { name: 'audio.opus', mime: 'audio/ogg', data: enc('SIGNED-OLD-AUDIO-V1'), compress: false },
  ], { viewerHint: false });

  const txt = Buffer.from(staged).toString('latin1');
  const prevXRef = Number([...txt.matchAll(/startxref\s+(\d+)/g)].pop()[1]);
  const baseSize = Number([...txt.matchAll(/\/Size\s+(\d+)/g)].pop()[1]);
  const catMatch = [...txt.matchAll(/1 0 obj\s+<<(.*?)>>/gs)].pop();
  const catInner = catMatch[1].trim();
  const sigObj = baseSize;

  const chunks = [Buffer.from(staged)];
  let cur = staged.length;
  const appendStr = (s) => { const b = enc(s); chunks.push(b); cur += b.length; };
  const sigOff = cur;
  appendStr(`${sigObj} 0 obj\n<< /Type /Sig /ByteRange [0 10 20 30] >>\nendobj\n`);
  const catOff = cur;
  appendStr(`1 0 obj\n<< ${catInner} /Perms << /DocMDP ${sigObj} 0 R >> >>\nendobj\n`);
  const xrOff = cur;
  appendStr(
    `xref\n1 1\n${String(catOff).padStart(10, '0')} 00000 n \n` +
    `${sigObj} 1\n${String(sigOff).padStart(10, '0')} 00000 n \n` +
    `trailer\n<< /Size ${sigObj + 1} /Root 1 0 R /Prev ${prevXRef} >>\nstartxref\n${xrOff}\n%%EOF\n`,
  );
  return new Uint8Array(Buffer.concat(chunks));
}

const fixtures = {
  'classic-1p.pdf': buildTiny1P(),
  'classic-2p.pdf': buildTiny2P(),
  'classic-dests.pdf': buildClassicDests(),
  'classic-rotate90-ocg.pdf': buildRotate90OCG(),
  'xref-objstm.pdf': buildXRefStreamObjStm(),
  'flat-single-rev-audio.pdf': buildFlatSingleRevAudio(),
  'linearized-like.pdf': buildLinearizedLike(),
  'viewer-annot-classic.pdf': await buildViewerAnnotClassic(),
  'viewer-annot-objstm.pdf': await buildViewerAnnotObjStm(),
  'signed-after-stage.pdf': await buildSignedAfterStage(),
};

for (const [name, bytes] of Object.entries(fixtures)) {
  fs.writeFileSync(path.join(fixturesDir, name), bytes);
}

const jsonAtt = (name, dataUtf8, compress = true, description = '') => ({
  name,
  mime: name.endsWith('.json') ? 'application/json' : name.endsWith('.txt') ? 'text/plain' : 'audio/ogg',
  description,
  dataUtf8,
  compress,
});

const cases = [
  {
    id: 'classic-attach-and-zero-byte-noop',
    fixture: 'classic-1p.pdf',
    steps: [
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"Deck1","audio":"audio.opus","provenance":{"convertedAt":"2026-11-26T08:00:00Z"}}', true),
          jsonAtt('audio.opus', 'CLASSIC-AUDIO-V1', false),
        ],
        viewerHint: false,
        mode: 'replace',
        expect: {
          noOp: false,
          appliedMode: 'append',
          prefixMatchesFixture: true,
          expectAttachments: {
            'pdfstage.json': '{"v":1,"title":"Deck1","audio":"audio.opus","provenance":{"convertedAt":"2026-11-26T08:00:00Z"}}',
            'audio.opus': 'CLASSIC-AUDIO-V1',
          },
        },
      },
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"Deck1","audio":"audio.opus","provenance":{"convertedAt":"2026-11-26T09:15:00Z"}}', true),
          jsonAtt('audio.opus', 'CLASSIC-AUDIO-V1', false),
        ],
        viewerHint: false,
        mode: 'replace',
        expect: {
          noOp: true,
          appliedMode: 'noop',
          byteEqualToPrev: true,
        },
      },
    ],
  },
  {
    id: 'metadata-and-hint-upgrade-reuses-audio',
    fixture: 'classic-1p.pdf',
    steps: [
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"Alt","audio":"audio.opus","duration":3,"starts":[0],"titles":["A"]}', true),
          jsonAtt('audio.opus', 'UNIQUE-LARGE-AUDIO-PAYLOAD-DO-NOT-DUPLICATE', false),
        ],
        viewerHint: false,
        mode: 'replace',
        expect: { noOp: false, prefixMatchesFixture: true },
      },
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"Neu","audio":"audio.opus","duration":3,"starts":[0],"titles":["A"],"provenance":{"convertedAt":"2026-11-26T08:00:00Z"}}', true),
          jsonAtt('audio.opus', 'UNIQUE-LARGE-AUDIO-PAYLOAD-DO-NOT-DUPLICATE', false),
        ],
        viewerHint: true,
        mode: 'replace',
        expect: {
          noOp: false,
          canReplace: true,
          appliedMode: 'replace',
          rawOccurrences: { 'UNIQUE-LARGE-AUDIO-PAYLOAD-DO-NOT-DUPLICATE': 1 },
          mustContainRaw: ['/PrintState /OFF', 'Enth\\344lt Audio f\\374r pdfstage.github.io'],
          expectAttachments: {
            'pdfstage.json': '{"v":1,"title":"Neu","audio":"audio.opus","duration":3,"starts":[0],"titles":["A"],"provenance":{"convertedAt":"2026-11-26T08:00:00Z"}}',
            'audio.opus': 'UNIQUE-LARGE-AUDIO-PAYLOAD-DO-NOT-DUPLICATE',
          },
        },
      },
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"Neu","audio":"audio.opus","duration":3,"starts":[0],"titles":["A"],"provenance":{"convertedAt":"2026-11-26T09:50:00Z"}}', true),
          jsonAtt('audio.opus', 'UNIQUE-LARGE-AUDIO-PAYLOAD-DO-NOT-DUPLICATE', false),
        ],
        viewerHint: true,
        mode: 'replace',
        expect: {
          noOp: true,
          appliedMode: 'noop',
          byteEqualToPrev: true,
        },
      },
    ],
  },
  {
    id: 'replace-tail-truncate-removes-dead-audio',
    fixture: 'classic-1p.pdf',
    steps: [
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"D","audio":"audio.opus","duration":2,"starts":[0]}', true),
          jsonAtt('audio.opus', 'OLD-AUDIO-V1-BLOCK-'.repeat(80), false),
        ],
        viewerHint: true,
        mode: 'replace',
        expect: { noOp: false, prefixMatchesFixture: true },
      },
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"D","audio":"audio.opus","duration":3,"starts":[0]}', true),
          jsonAtt('audio.opus', 'NEW-AUDIO-V2-BLOCK-'.repeat(60), false),
        ],
        viewerHint: true,
        mode: 'replace',
        expect: {
          noOp: false,
          canReplace: true,
          replaceStrategy: 'tail-truncate',
          appliedMode: 'replace',
          mustNotContainRaw: ['OLD-AUDIO-V1-BLOCK-'],
          rawOccurrences: { ['NEW-AUDIO-V2-BLOCK-'.repeat(60)]: 1 },
          expectAttachments: {
            'audio.opus': 'NEW-AUDIO-V2-BLOCK-'.repeat(60),
            'pdfstage.json': '{"v":1,"title":"D","audio":"audio.opus","duration":3,"starts":[0]}',
          },
        },
      },
    ],
  },
  {
    id: 'append-mode-preserves-prefix',
    fixture: 'classic-1p.pdf',
    steps: [
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"Deck","audio":"audio.opus"}', true),
          jsonAtt('audio.opus', 'AUDIO-V1-KEEP-PREFIX', false),
        ],
        viewerHint: false,
        mode: 'replace',
        expect: { noOp: false },
      },
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"Deck Neu","audio":"audio.opus"}', true),
          jsonAtt('audio.opus', 'AUDIO-V2-APPENDED', false),
        ],
        viewerHint: false,
        mode: 'append',
        expect: {
          noOp: false,
          canReplace: true,
          appliedMode: 'append',
          prefixPreserved: true,
          mustContainRaw: ['AUDIO-V1-KEEP-PREFIX', 'AUDIO-V2-APPENDED'],
          expectAttachments: { 'audio.opus': 'AUDIO-V2-APPENDED' },
        },
      },
    ],
  },
  {
    id: 'replace-revision-replay-preserves-viewer-annotations',
    fixture: 'viewer-annot-classic.pdf',
    steps: [
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"Vorlesung Neu","audio":"audio.opus"}', true),
          jsonAtt('audio.opus', 'NEW-VIEWER-AUDIO-V2-'.repeat(60), false),
        ],
        viewerHint: true,
        mode: 'replace',
        expect: {
          noOp: false,
          canReplace: true,
          replaceStrategy: 'revision-replay',
          revisionsAfterDead: 1,
          appliedMode: 'replace',
          mustNotContainRaw: ['VIEWER-OLD-AUDIO-V1-'],
          expectAttachments: {
            'audio.opus': 'NEW-VIEWER-AUDIO-V2-'.repeat(60),
            'pdfstage.json': '{"v":1,"title":"Vorlesung Neu","audio":"audio.opus"}',
          },
          expectPageAnnotNMs: [
            ['viewer-p1', 'pdfstage-hint-stamp', 'pdfstage-hint-link', 'pdfstage-hint-close'],
            ['viewer-p2'],
          ],
        },
      },
    ],
  },
  {
    id: 'replace-revision-replay-with-objstm',
    fixture: 'viewer-annot-objstm.pdf',
    steps: [
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"S2","audio":"audio.opus"}', true),
          jsonAtt('audio.opus', 'OBJSTM-NEW-AUDIO-V2-'.repeat(30), false),
        ],
        viewerHint: false,
        mode: 'replace',
        expect: {
          noOp: false,
          canReplace: true,
          replaceStrategy: 'revision-replay',
          revisionsAfterDead: 1,
          appliedMode: 'replace',
          mustNotContainRaw: ['OBJSTM-OLD-AUDIO-V1-'],
          expectAttachments: { 'audio.opus': 'OBJSTM-NEW-AUDIO-V2-'.repeat(30) },
          expectPageAnnotNMs: [['viewer-objstm-p1']],
        },
      },
    ],
  },
  {
    id: 'preserve-foreign-attachments-and-existing-names',
    fixture: 'classic-dests.pdf',
    steps: [
      {
        files: [
          jsonAtt('handout.txt', 'HANDOUT-CONTENT-KEEP-ME', false),
          jsonAtt('pdfstage.json', '{"v":1,"audio":"audio.opus"}', true),
          jsonAtt('audio.opus', 'FOREIGN-AUDIO-V1', false),
        ],
        viewerHint: false,
        mode: 'replace',
        expect: { noOp: false, prefixMatchesFixture: true },
      },
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"Neu","audio":"audio.opus"}', true),
          jsonAtt('audio.opus', 'FOREIGN-AUDIO-V2', false),
        ],
        viewerHint: false,
        mode: 'replace',
        expect: {
          noOp: false,
          canReplace: true,
          appliedMode: 'replace',
          preservedForeignNames: ['handout.txt'],
          mustContainRaw: ['/Dests 5 0 R'],
          mustNotContainRaw: ['FOREIGN-AUDIO-V1'],
          expectAttachments: {
            'handout.txt': 'HANDOUT-CONTENT-KEEP-ME',
            'audio.opus': 'FOREIGN-AUDIO-V2',
          },
        },
      },
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"ViewerOnly"}', true),
        ],
        viewerHint: false,
        mode: 'replace',
        expect: {
          noOp: false,
          canReplace: true,
          appliedMode: 'replace',
          preservedForeignNames: ['handout.txt'],
          mustContainRaw: ['/Dests 5 0 R'],
          mustNotContainRaw: ['FOREIGN-AUDIO-V2'],
          expectAttachments: {
            'handout.txt': 'HANDOUT-CONTENT-KEEP-ME',
            'pdfstage.json': '{"v":1,"title":"ViewerOnly"}',
          },
          expectAbsentAttachments: ['audio.opus'],
        },
      },
    ],
  },
  {
    id: 'rotate90-cropbox-ocg-merge-and-idempotency',
    fixture: 'classic-rotate90-ocg.pdf',
    steps: [
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"HintDeck","audio":"audio.opus","duration":4,"starts":[0],"titles":["Eins"],"provenance":{"convertedAt":"2026-11-26T08:00:00Z"}}', true),
          jsonAtt('audio.opus', 'OggS-HINT-AUDIO-V1', false),
        ],
        viewerHint: true,
        mode: 'replace',
        expect: {
          noOp: false,
          prefixMatchesFixture: true,
          expectOcgNames: ['UserLayer', 'pdfstage-hint'],
          expectPageAnnotNMs: [['user-mark-1', 'pdfstage-hint-stamp', 'pdfstage-hint-link', 'pdfstage-hint-close']],
        },
      },
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"HintDeck","audio":"audio.opus","duration":4,"starts":[0],"titles":["Eins"],"provenance":{"convertedAt":"2026-11-26T09:15:00Z"}}', true),
          jsonAtt('audio.opus', 'OggS-HINT-AUDIO-V1', false),
        ],
        viewerHint: true,
        mode: 'replace',
        expect: {
          noOp: true,
          appliedMode: 'noop',
          byteEqualToPrev: true,
        },
      },
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"HintDeck2","audio":"audio.opus","duration":5,"starts":[0],"titles":["Eins"]}', true),
          jsonAtt('audio.opus', 'OggS-HINT-AUDIO-V2', false),
        ],
        viewerHint: true,
        mode: 'replace',
        expect: {
          noOp: false,
          canReplace: true,
          replaceStrategy: 'tail-truncate',
          appliedMode: 'replace',
          prefixMatchesFixture: true,
          mustNotContainRaw: ['OggS-HINT-AUDIO-V1'],
          expectOcgNames: ['UserLayer', 'pdfstage-hint'],
          expectPageAnnotNMs: [['user-mark-1', 'pdfstage-hint-stamp', 'pdfstage-hint-link', 'pdfstage-hint-close']],
        },
      },
    ],
  },
  {
    id: 'linearized-backwards-prev-replace',
    fixture: 'linearized-like.pdf',
    steps: [
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"L1","audio":"audio.opus"}', true),
          jsonAtt('audio.opus', 'LINEAR-AUDIO-V1-'.repeat(40), false),
        ],
        viewerHint: true,
        mode: 'replace',
        expect: { noOp: false, prefixMatchesFixture: true },
      },
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"L2","audio":"audio.opus"}', true),
          jsonAtt('audio.opus', 'LINEAR-AUDIO-V2-'.repeat(30), false),
        ],
        viewerHint: true,
        mode: 'replace',
        expect: {
          noOp: false,
          canReplace: true,
          replaceStrategy: 'tail-truncate',
          appliedMode: 'replace',
          prefixMatchesFixture: true,
          mustNotContainRaw: ['LINEAR-AUDIO-V1-'],
          expectAttachments: { 'audio.opus': 'LINEAR-AUDIO-V2-'.repeat(30) },
        },
      },
    ],
  },
  {
    id: 'blocked-on-single-rev-full-save',
    fixture: 'flat-single-rev-audio.pdf',
    steps: [
      {
        files: [jsonAtt('audio.opus', 'NEW-FLAT-AUDIO', false)],
        viewerHint: false,
        mode: 'replace',
        expect: {
          noOp: false,
          canReplace: false,
          hasBlockedReason: true,
          appliedMode: 'append',
          prefixMatchesFixture: true,
          expectAttachments: { 'audio.opus': 'NEW-FLAT-AUDIO' },
        },
      },
    ],
  },
  {
    id: 'blocked-on-signed-pdf',
    fixture: 'signed-after-stage.pdf',
    steps: [
      {
        files: [
          jsonAtt('pdfstage.json', '{"v":1,"title":"S2","audio":"audio.opus"}', true),
          jsonAtt('audio.opus', 'SIGNED-NEW-AUDIO-V2', false),
        ],
        viewerHint: false,
        mode: 'replace',
        expect: {
          noOp: false,
          canReplace: false,
          hasBlockedReason: true,
          appliedMode: 'append',
          prefixMatchesFixture: true,
          expectAttachments: { 'audio.opus': 'SIGNED-NEW-AUDIO-V2' },
        },
      },
    ],
  },
];

fs.writeFileSync(path.join(__dirname, 'cases.json'), `${JSON.stringify({ version: 1, cases }, null, 2)}\n`, 'utf8');
console.log(`Generated ${Object.keys(fixtures).length} fixtures and ${cases.length} conformance cases.`);
