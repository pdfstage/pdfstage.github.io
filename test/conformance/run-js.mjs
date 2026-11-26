// Shared conformance test runner (and cross-interop helper) for /cast/pdf-attach.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzePdfAttachmentUpdate,
  attachFilesToPdfWithReport,
  inspectPdfStructure,
  readPdfAttachments,
} from '../../cast/pdf-attach.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder();

function countSubBytes(hay, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  for (let i = 0; i <= hay.length - needle.length;) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      count++;
      i += needle.length;
    } else {
      i++;
    }
  }
  return count;
}

function hasPrefixBytes(hay, prefix) {
  if (hay.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (hay[i] !== prefix[i]) return false;
  }
  return true;
}

function toAttachmentList(rawFiles) {
  return rawFiles.map((f) => ({
    name: f.name,
    mime: f.mime || '',
    description: f.description || '',
    data: f.dataBase64 ? new Uint8Array(Buffer.from(f.dataBase64, 'base64')) : utf8Enc.encode(f.dataUtf8 || ''),
    compress: Boolean(f.compress),
  }));
}

// Optional CLI helper mode for Go's TestCrossInteropJSAndGo:
// node run-js.mjs --interop-step <inPdf> <outPdf> <mode> <viewerHint> <filesJson>
if (process.argv[2] === '--interop-step') {
  const [, , , inPdf, outPdf, mode, viewerHintArg, filesJsonPath] = process.argv;
  const pdfBytes = new Uint8Array(fs.readFileSync(inPdf));
  const rawFiles = JSON.parse(fs.readFileSync(filesJsonPath, 'utf8'));
  const files = toAttachmentList(rawFiles);
  const res = await attachFilesToPdfWithReport(pdfBytes, files, {
    mode: mode || 'replace',
    viewerHint: viewerHintArg === 'true' || viewerHintArg === '1',
  });
  const struct = await inspectPdfStructure(res.bytes);
  const atts = await readPdfAttachments(res.bytes);
  const attBase64 = {};
  for (const [k, v] of atts.entries()) {
    attBase64[k] = Buffer.from(v).toString('base64');
  }
  fs.writeFileSync(outPdf, res.bytes);
  console.log(JSON.stringify({
    appliedMode: res.appliedMode,
    plan: res.plan,
    structure: struct,
    attachmentsBase64: attBase64,
  }));
  process.exit(0);
}

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
let passed = 0;

for (const tc of corpus.cases) {
  const fixtureBytes = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', tc.fixture)));
  let current = fixtureBytes;

  for (let si = 0; si < tc.steps.length; si++) {
    const step = tc.steps[si];
    const files = toAttachmentList(step.files);
    const opts = { viewerHint: Boolean(step.viewerHint), mode: step.mode || 'replace' };
    const ctx = `${tc.id} [step ${si}]`;

    const prePlan = await analyzePdfAttachmentUpdate(current, files, opts);
    const { bytes: next, plan, appliedMode } = await attachFilesToPdfWithReport(current, files, opts);
    assert.deepEqual(prePlan, plan, `${ctx}: analyzePdfAttachmentUpdate must match report plan`);

    const exp = step.expect || {};
    if (exp.noOp !== undefined) assert.equal(plan.noOp, exp.noOp, `${ctx}: noOp`);
    if (exp.canReplace !== undefined) assert.equal(plan.canReplace, exp.canReplace, `${ctx}: canReplace`);
    if (exp.replaceStrategy !== undefined) assert.equal(plan.replaceStrategy, exp.replaceStrategy, `${ctx}: replaceStrategy`);
    if (exp.hasBlockedReason) assert.ok(plan.replaceBlockedReason.length > 0, `${ctx}: replaceBlockedReason non-empty`);
    if (exp.revisionsAfterDead !== undefined) assert.equal(plan.revisionsAfterDead, exp.revisionsAfterDead, `${ctx}: revisionsAfterDead`);
    if (exp.appliedMode !== undefined) assert.equal(appliedMode, exp.appliedMode, `${ctx}: appliedMode`);
    if (exp.byteEqualToPrev) {
      assert.equal(Buffer.compare(Buffer.from(next), Buffer.from(current)), 0, `${ctx}: byteEqualToPrev`);
    }
    if (exp.prefixPreserved) {
      assert.ok(hasPrefixBytes(next, current), `${ctx}: prefixPreserved`);
    }
    if (exp.prefixMatchesFixture) {
      assert.ok(hasPrefixBytes(next, fixtureBytes), `${ctx}: prefixMatchesFixture`);
    }
    if (exp.preservedForeignNames) {
      assert.deepEqual(
        plan.preservedForeignFiles.map((f) => f.name).sort(),
        [...exp.preservedForeignNames].sort(),
        `${ctx}: preservedForeignNames`,
      );
    }
    for (const needle of exp.mustContainRaw || []) {
      assert.ok(countSubBytes(next, utf8Enc.encode(needle)) > 0, `${ctx}: mustContainRaw ${needle}`);
    }
    for (const needle of exp.mustNotContainRaw || []) {
      assert.equal(countSubBytes(next, utf8Enc.encode(needle)), 0, `${ctx}: mustNotContainRaw ${needle}`);
    }
    for (const [needle, expectedCnt] of Object.entries(exp.rawOccurrences || {})) {
      assert.equal(countSubBytes(next, utf8Enc.encode(needle)), expectedCnt, `${ctx}: rawOccurrences ${needle}`);
    }

    const gotAtts = await readPdfAttachments(next);
    for (const [name, wantUtf8] of Object.entries(exp.expectAttachments || {})) {
      assert.ok(gotAtts.has(name), `${ctx}: missing attachment ${name}`);
      assert.equal(utf8Dec.decode(gotAtts.get(name)), wantUtf8, `${ctx}: attachment ${name}`);
    }
    for (const absent of exp.expectAbsentAttachments || []) {
      assert.ok(!gotAtts.has(absent), `${ctx}: unexpected attachment ${absent}`);
    }

    if (exp.expectPageAnnotNMs || exp.expectOcgNames) {
      const st = await inspectPdfStructure(next);
      if (exp.expectPageAnnotNMs) {
        assert.equal(st.pageAnnotNMs.length, exp.expectPageAnnotNMs.length, `${ctx}: page count`);
        for (let pi = 0; pi < exp.expectPageAnnotNMs.length; pi++) {
          assert.deepEqual(
            [...st.pageAnnotNMs[pi]].sort(),
            [...exp.expectPageAnnotNMs[pi]].sort(),
            `${ctx}: page ${pi + 1} annot NMs`,
          );
        }
      }
      if (exp.expectOcgNames) {
        assert.deepEqual(
          [...st.ocgNames].sort(),
          [...exp.expectOcgNames].sort(),
          `${ctx}: OCG names`,
        );
      }
    }
    current = next;
  }

  console.log(`PASS JS  ${tc.id}`);
  passed++;
}

console.log(`All ${passed}/${corpus.cases.length} shared conformance cases passed in JS.`);
