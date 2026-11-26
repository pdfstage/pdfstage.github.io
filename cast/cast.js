// Zero-install browser packer controller for /cast/ — pairs .ppsx/.pptx + .pdf and produces .stage.pdf locally.
import { parsePpsxDeck } from './ppsx-reader.js';
import { buildDeckAudio } from './ogg-opus.js';
import {
  analyzePdfAttachmentUpdate,
  attachFilesToPdf,
  attachFilesToPdfWithReport,
  getPdfPageCount,
  readPdfAttachments,
} from './pdf-attach.js';
import { buildStoreZip } from './zip-store.js';

export const PDFSTAGE_VERSION = '0.8.7';

export function toPdfstageSpecVersion(semver) {
  const m = String(semver || '').match(/^(\d+\.\d+)/);
  return m ? m[1] : String(semver || '');
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
const ATTACH_MODE_STORAGE_KEY = 'pdfstage:cast:attachMode';

function normalizeAttachMode(val, fallback = 'replace') {
  return (val === 'replace' || val === 'ask' || val === 'append') ? val : fallback;
}

function loadSavedAttachMode() {
  try {
    return normalizeAttachMode(localStorage.getItem(ATTACH_MODE_STORAGE_KEY), 'replace');
  } catch {
    return 'replace';
  }
}

function saveAttachMode(mode) {
  try {
    localStorage.setItem(ATTACH_MODE_STORAGE_KEY, normalizeAttachMode(mode, 'replace'));
  } catch { /* ignore storage errors */ }
}

async function sha256Hex(u8) {
  if (!u8 || !globalThis.crypto || !crypto.subtle) return '';
  const digest = await crypto.subtle.digest('SHA-256', u8);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function computeAudioSourceSha256(deck, { includeHidden, silentSeconds, tailSilence, bitrate }) {
  if (!globalThis.crypto || !crypto.subtle) return '';
  const chunks = [];
  let totalLen = 0;
  const pushStr = (s) => {
    const b = utf8Encoder.encode(s);
    chunks.push(b);
    totalLen += b.length;
  };
  pushStr(`pdfstage-audio-v1\nhidden=${includeHidden ? 1 : 0};silent=${silentSeconds};tail=${tailSilence};bitrate=${bitrate}\n`);
  for (const s of deck.slides) {
    pushStr(`slide:${s.advance || 0}:${s.audio.length}\n`);
    for (const mediaPath of s.audio) {
      const base = mediaPath.split('/').pop() || mediaPath;
      const entryBytes = await deck.zip.readEntry(mediaPath);
      const u8 = entryBytes || new Uint8Array(0);
      pushStr(`${base}:${u8.byteLength}\n`);
      if (u8.byteLength > 0) {
        chunks.push(u8);
        totalLen += u8.byteLength;
      }
      pushStr('\n');
    }
  }
  const combined = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    combined.set(c, off);
    off += c.byteLength;
  }
  return sha256Hex(combined);
}

export function stripDeckExtension(name) {
  return (name || '')
    .split(/[/\\]/)
    .pop()
    .replace(/\.(pdfstage|stage)\.pdf$/i, '')
    .replace(/\.(pdf|ppsx|pptx)$/i, '')
    .trim();
}

export function pairKey(name) {
  return stripDeckExtension(name).normalize('NFC').toLowerCase();
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = bytes / 1024;
  let u = 0;
  while (val >= 1024 && u < units.length - 1) {
    val /= 1024;
    u++;
  }
  return `${val.toFixed(val >= 100 ? 0 : 1)} ${units[u]}`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * End-to-end local cast pipeline for one (.ppsx/.pptx, .pdf) pair.
 */
export async function castPair({
  deckFile,
  pdfFile,
  silentSeconds = 5,
  tailSilence = 10,
  bitrate = 32000,
  includeHidden = false,
  viewerOnly = false,
  attachMode = 'replace',
  onDeadFilesDecision = null,
  onProgress = null,
}) {
  if (!deckFile) throw new Error('Keine .ppsx/.pptx-Datei ausgewählt');
  if (!pdfFile) throw new Error('Keine .pdf-Datei ausgewählt');

  if (onProgress) onProgress({ phase: 'parse', slideIndex: 0, slideCount: 1, pct: 5, text: 'Präsentationsstruktur lesen …' });
  const deck = await parsePpsxDeck(deckFile, { includeHidden });
  const deckSha256 = await sha256Hex(new Uint8Array(await deckFile.arrayBuffer()));

  const baseName = stripDeckExtension(pdfFile.name) || stripDeckExtension(deckFile.name) || 'Praesentation';
  const pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());
  const pdfPages = await getPdfPageCount(pdfBytes);

  let existingAtts = null;
  let existingMeta = null;
  try {
    existingAtts = await readPdfAttachments(pdfBytes);
    const rawExistingMeta = existingAtts.get('pdfstage.json');
    if (rawExistingMeta) {
      existingMeta = JSON.parse(utf8Decoder.decode(rawExistingMeta));
    }
  } catch { /* ignore invalid existing metadata */ }

  let audioResult = {
    audioBytes: null,
    audioName: '',
    audioMime: '',
    starts: [],
    duration: 0,
    warnings: [],
  };
  let audioSha256 = '';
  let audioSourceSha256 = '';

  let reusedAudio = false;
  if (!viewerOnly) {
    audioSourceSha256 = await computeAudioSourceSha256(deck, { includeHidden, silentSeconds, tailSilence, bitrate });
    if (audioSourceSha256 && existingAtts && existingMeta) {
      try {
        const prevSrcHash = existingMeta?.provenance?.audioSourceSha256;
        const prevAudioName = typeof existingMeta?.audio === 'string' ? existingMeta.audio : '';
        const prevAudioBytes = prevAudioName ? existingAtts.get(prevAudioName) : null;
        if (prevSrcHash && prevSrcHash === audioSourceSha256 && prevAudioBytes && prevAudioBytes.length > 0) {
          const actualHash = await sha256Hex(prevAudioBytes);
          const expectedHash = existingMeta?.provenance?.audioSha256;
          if (!expectedHash || expectedHash === actualHash) {
            audioResult = {
              audioBytes: prevAudioBytes,
              audioName: prevAudioName,
              audioMime: existingMeta.audioMime || (prevAudioName.endsWith('.wav') ? 'audio/wav' : 'audio/ogg'),
              starts: Array.isArray(existingMeta.starts) ? existingMeta.starts : [],
              duration: typeof existingMeta.duration === 'number' ? existingMeta.duration : 0,
              warnings: [],
            };
            audioSha256 = actualHash;
            reusedAudio = true;
          }
        }
      } catch { /* ignore invalid existing metadata */ }
    }

    if (!reusedAudio) {
      audioResult = await buildDeckAudio(deck, {
        silentSeconds,
        tailSilence,
        bitrate,
        onProgress(ev) {
          if (!onProgress) return;
          const pct = ev.phase === 'finalize'
            ? 84
            : Math.min(82, 10 + Math.round(((ev.slideIndex + 1) / Math.max(1, ev.slideCount)) * 72));
          const label = ev.phase === 'finalize'
            ? 'Opus-Container abschließen …'
            : `Folie ${ev.slideIndex + 1} von ${ev.slideCount} kodieren …`;
          onProgress({ ...ev, pct, text: label });
        },
      });
      if (audioResult.audioBytes && audioResult.audioBytes.length > 0) {
        audioSha256 = await sha256Hex(audioResult.audioBytes);
      }
    }
  } else if (deck.missing && deck.missing.length > 0) {
    audioResult.warnings.push(`Fehlende Audiodatei(en) im Paket: ${deck.missing.join(', ')}`);
  }

  if (onProgress) onProgress({ phase: 'attach', slideIndex: deck.slides.length, slideCount: deck.slides.length, pct: 90, text: 'In PDF einbetten …' });

  const warnings = [...audioResult.warnings];
  if (pdfPages !== null && pdfPages !== deck.slides.length) {
    warnings.push(`Seitenzahl weicht ab: ${deck.slides.length} Folien vs. ${pdfPages} PDF-Seiten.`);
  }
  const prevDeckSha = typeof existingMeta?.provenance?.sha256 === 'string' ? existingMeta.provenance.sha256 : '';
  if (prevDeckSha && deckSha256 && prevDeckSha !== deckSha256) {
    const prevTitleNote = existingMeta.title ? ` (bisher: „${existingMeta.title}“)` : '';
    const audioNote = reusedAudio
      ? ' Tonspur unverändert, aber PDF-Folien prüfen.'
      : ' PDF-Folien prüfen, ob sie zur neuen Präsentation passen.';
    warnings.push(`Andere Quell-Präsentation als im bestehenden Stage-PDF (SHA-256 weicht ab${prevTitleNote}).${audioNote}`);
  }

  const hasAudio = Boolean(audioResult.audioBytes && audioResult.audioBytes.length > 0);
  const provenance = {};
  const prevProv = existingMeta && typeof existingMeta === 'object' ? existingMeta.provenance : null;
  if (prevProv && typeof prevProv.sourceUrl === 'string' && prevProv.sourceUrl && prevProv.sourceUrl !== '-') {
    if (!prevProv.sha256 || !deckSha256 || prevProv.sha256 === deckSha256) {
      provenance.sourceUrl = prevProv.sourceUrl;
    }
  }
  if (deckSha256) provenance.sha256 = deckSha256;
  if (deckFile.size > 0) provenance.bytes = deckFile.size;
  provenance.convertedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const pdfstageVersion = toPdfstageSpecVersion(
    (globalThis.pdfstagePwa && globalThis.pdfstagePwa.APP_VERSION) || PDFSTAGE_VERSION,
  );
  if (pdfstageVersion) provenance.pdfstageVersion = pdfstageVersion;
  if (includeHidden) provenance.hiddenIncluded = true;
  if (silentSeconds > 0) provenance.silentSeconds = silentSeconds;
  if (tailSilence > 0) provenance.tailSilence = tailSilence;
  if (audioSha256) provenance.audioSha256 = audioSha256;
  if (audioSourceSha256) provenance.audioSourceSha256 = audioSourceSha256;

  const meta = { v: 1 };
  if (baseName) meta.title = baseName;
  if (hasAudio) {
    meta.audio = audioResult.audioName;
    if (audioResult.audioMime && audioResult.audioMime !== 'audio/ogg') {
      meta.audioMime = audioResult.audioMime;
    }
    const roundedDur = Math.round((audioResult.duration || 0) * 1000) / 1000;
    if (roundedDur > 0) meta.duration = roundedDur;
    if (Array.isArray(audioResult.starts) && audioResult.starts.length > 0) {
      meta.starts = audioResult.starts;
    }
  }
  meta.titles = deck.slides.map((s) => s.tooltipTitle || '');
  meta.provenance = provenance;

  const attachments = [
    {
      name: 'pdfstage.json',
      mime: 'application/json',
      description: 'pdfstage Deck-Metadaten',
      data: utf8Encoder.encode(JSON.stringify(meta)),
      compress: true,
    },
  ];
  if (hasAudio) {
    attachments.push({
      name: audioResult.audioName,
      mime: audioResult.audioMime || 'audio/ogg',
      description: 'Erzählton',
      data: audioResult.audioBytes,
      compress: false,
    });
  }

  const plan = await analyzePdfAttachmentUpdate(pdfBytes, attachments, { viewerHint: hasAudio });
  let effectiveMode = 'replace';
  const isSignificantDead = plan.deadBytes >= 32768 || plan.deadFiles.some((f) => f.name !== 'pdfstage.json');

  if (!plan.noOp && plan.deadFiles.length > 0) {
    if (plan.canReplace) {
      if (attachMode === 'ask' && isSignificantDead && typeof onDeadFilesDecision === 'function') {
        const chosen = await onDeadFilesDecision(plan);
        effectiveMode = chosen === 'append' ? 'append' : 'replace';
      } else {
        effectiveMode = attachMode === 'append' ? 'append' : 'replace';
      }
    } else {
      effectiveMode = 'append';
      if (isSignificantDead) {
        const deadNames = plan.deadFiles.filter((f) => f.name !== 'pdfstage.json' || plan.deadFiles.length === 1).map((f) => f.name).join(', ');
        warnings.push(`Altes ${deadNames} (${formatBytes(plan.deadBytes)}) konnte nicht entfernt werden (${plan.replaceBlockedReason}) — wurde angehängt.`);
      }
    }
  }

  const { bytes: outputBytes, appliedMode } = await attachFilesToPdfWithReport(pdfBytes, attachments, {
    viewerHint: hasAudio,
    mode: effectiveMode,
  });
  if (onProgress) onProgress({ phase: 'done', slideIndex: deck.slides.length, slideCount: deck.slides.length, pct: 100, text: 'Fertig' });

  return {
    outputBytes,
    outputName: `${baseName}.stage.pdf`,
    meta,
    deck,
    pdfPages,
    warnings,
    attachReport: { plan, appliedMode, reusedAudio },
  };
}

// Expose API for headless verification and devtools inspection.
if (typeof window !== 'undefined') {
  window.__pdfstageCast = {
    castPair,
    parsePpsxDeck,
    analyzePdfAttachmentUpdate,
    attachFilesToPdf,
    attachFilesToPdfWithReport,
    readPdfAttachments,
    getPdfPageCount,
    buildStoreZip,
  };
}

function classifyFile(file) {
  const n = (file && file.name ? file.name : '').toLowerCase();
  if (n.endsWith('.ppsx') || n.endsWith('.pptx')) return 'deck';
  if (n.endsWith('.pdf')) return 'pdf';
  return null;
}

async function collectDroppedFiles(dataTransfer) {
  const files = [];
  const items = dataTransfer && dataTransfer.items ? Array.from(dataTransfer.items) : [];
  if (items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
    const readEntry = async (entry, depth) => {
      if (!entry) return;
      if (entry.isFile) {
        await new Promise((resolve) => {
          entry.file((f) => { files.push(f); resolve(); }, () => resolve());
        });
      } else if (entry.isDirectory && depth < 2) {
        const reader = entry.createReader();
        const readAllBatch = () => new Promise((resolve) => {
          reader.readEntries((batch) => resolve(batch), () => resolve([]));
        });
        for (;;) {
          const batch = await readAllBatch();
          if (!batch || batch.length === 0) break;
          for (const child of batch) {
            await readEntry(child, depth + 1);
          }
        }
      }
    };
    const entries = items.map((it) => it.webkitGetAsEntry()).filter(Boolean);
    if (entries.length > 0) {
      for (const e of entries) await readEntry(e, 0);
      return files;
    }
  }
  return Array.from((dataTransfer && dataTransfer.files) || []);
}

function initUI() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const pickBtn = document.getElementById('pickBtn');
  const silentInput = document.getElementById('optSilent');
  const tailInput = document.getElementById('optTail');
  const bitrateInput = document.getElementById('optBitrate');
  const attachModeInput = document.getElementById('optAttachMode');
  const hiddenInput = document.getElementById('optHidden');
  const viewerOnlyInput = document.getElementById('optViewerOnly');
  const actionsBar = document.getElementById('batchBar');
  const runAllBtn = document.getElementById('runAllBtn');
  const zipAllBtn = document.getElementById('zipAllBtn');
  const clearBtn = document.getElementById('clearBtn');
  const jobList = document.getElementById('jobList');
  const statusBanner = document.getElementById('statusBanner');

  if (!dropzone || !fileInput || !jobList) return;

  if (attachModeInput) {
    attachModeInput.value = loadSavedAttachMode();
  }

  let nextId = 1;
  /** @type {Array<any>} */
  const jobs = [];
  let runningBatch = false;

  function readAttachMode(job = null) {
    if (job && job.overrideAttachMode) {
      return normalizeAttachMode(job.overrideAttachMode, 'replace');
    }
    return attachModeInput ? normalizeAttachMode(attachModeInput.value, 'replace') : loadSavedAttachMode();
  }

  function readGlobalOptions(job = null) {
    const silent = Math.max(0.5, Number(silentInput.value) || 5);
    const tail = Math.max(0, Number(tailInput.value) ?? 10);
    const bitrate = Math.max(12000, (Number(bitrateInput.value) || 32) * 1000);
    const includeHidden = job && typeof job.overrideHidden === 'boolean'
      ? job.overrideHidden
      : Boolean(hiddenInput.checked);
    const viewerOnly = Boolean(viewerOnlyInput.checked);
    const attachMode = readAttachMode(job);
    return { silentSeconds: silent, tailSilence: tail, bitrate, includeHidden, viewerOnly, attachMode };
  }

  function revokeJobUrl(job) {
    if (job.outputUrl) {
      URL.revokeObjectURL(job.outputUrl);
      job.outputUrl = '';
    }
  }

  async function inspectJob(job) {
    if (!job.deckFile || !job.pdfFile) return;
    const token = ++job.inspectToken;
    job.confirmedMismatch = false;
    job.inspecting = true;
    render();
    try {
      const opts = readGlobalOptions(job);
      const [deck, pdfBuf] = await Promise.all([
        parsePpsxDeck(job.deckFile, { includeHidden: opts.includeHidden }),
        job.pdfFile.arrayBuffer(),
      ]);
      const pdfBytes = new Uint8Array(pdfBuf);
      const pdfPages = await getPdfPageCount(pdfBytes);

      let attachmentInfo = null;
      let attachmentPlan = null;
      let sourceMismatch = '';
      let sourceHashMatch = null;
      try {
        const existingAtts = await readPdfAttachments(pdfBytes);
        const rawMeta = existingAtts.get('pdfstage.json');
        if (rawMeta) {
          const existingMeta = JSON.parse(utf8Decoder.decode(rawMeta));
          const prevAudioName = typeof existingMeta?.audio === 'string' ? existingMeta.audio : '';
          const prevAudioBytes = prevAudioName ? existingAtts.get(prevAudioName) : null;
          let audioUnchanged = false;
          if (!opts.viewerOnly && prevAudioBytes && prevAudioBytes.length > 0) {
            const audioSourceSha256 = await computeAudioSourceSha256(deck, opts);
            const prevSrcHash = existingMeta?.provenance?.audioSourceSha256;
            if (audioSourceSha256 && prevSrcHash === audioSourceSha256) {
              const actualHash = await sha256Hex(prevAudioBytes);
              const expectedHash = existingMeta?.provenance?.audioSha256;
              if (!expectedHash || expectedHash === actualHash) {
                audioUnchanged = true;
              }
            }
          }
          const prevDeckSha = typeof existingMeta?.provenance?.sha256 === 'string' ? existingMeta.provenance.sha256 : '';
          if (prevDeckSha) {
            const deckSha256 = await sha256Hex(new Uint8Array(await job.deckFile.arrayBuffer()));
            sourceHashMatch = prevDeckSha === deckSha256;
            if (!sourceHashMatch) {
              const prevTitleNote = existingMeta.title ? ` (bisher: „${existingMeta.title}“)` : '';
              sourceMismatch = audioUnchanged
                ? `Andere Quell-Präsentation als im bestehenden Stage-PDF (SHA-256 weicht ab${prevTitleNote}) — Tonspur unverändert, aber PDF-Folien prüfen!`
                : `Andere Quell-Präsentation als im bestehenden Stage-PDF (SHA-256 weicht ab${prevTitleNote}) — PDF-Folien prüfen!`;
            }
          }
          if (audioUnchanged) {
            attachmentInfo = {
              kind: 'unchanged-audio',
              text: sourceHashMatch === true
                ? 'Bestehendes Stage-PDF · Identische Präsentation & Tonspur (0 B Änderung)'
                : 'Bestehendes Stage-PDF · Tonspur unverändert (wird wiederverwendet)',
            };
          } else if ((prevAudioBytes && prevAudioBytes.length > 0) || opts.viewerOnly) {
            const previewAtts = [
              {
                name: 'pdfstage.json',
                mime: 'application/json',
                data: utf8Encoder.encode(JSON.stringify({ v: 1, previewToken: Date.now() })),
                compress: true,
              },
            ];
            const willHaveAudio = !opts.viewerOnly && deck.audioTrackCount > 0;
            if (willHaveAudio) {
              previewAtts.push({
                name: prevAudioName || 'audio.opus',
                mime: existingMeta.audioMime || 'audio/ogg',
                data: new Uint8Array([0x4f, 0x67, 0x67, 0x53]),
                compress: false,
              });
            }
            attachmentPlan = await analyzePdfAttachmentUpdate(pdfBytes, previewAtts, { viewerHint: willHaveAudio });
          }
        }
      } catch { /* non-fatal preview inspection */ }

      if (token !== job.inspectToken) return;
      job.inspect = {
        slideCount: deck.slides.length,
        audioTracks: deck.audioTrackCount,
        hiddenCount: deck.hiddenCount,
        missing: deck.missing,
        pdfPages,
        includeHiddenUsed: opts.includeHidden,
        attachmentInfo,
        attachmentPlan,
        sourceMismatch,
        sourceHashMatch,
      };
    } catch (err) {
      if (token !== job.inspectToken) return;
      job.inspectError = err.message || String(err);
    } finally {
      if (token === job.inspectToken) {
        job.inspecting = false;
        render();
      }
    }
  }

  function addFiles(rawFiles) {
    const valid = [];
    let ignored = 0;
    for (const f of rawFiles) {
      const kind = classifyFile(f);
      if (kind) valid.push({ file: f, kind });
      else ignored++;
    }

    if (ignored > 0) {
      statusBanner.hidden = false;
      statusBanner.textContent = `${ignored} nicht unterstützte Datei(en) ignoriert — erwartet werden .ppsx, .pptx und .pdf.`;
    } else if (valid.length > 0) {
      statusBanner.hidden = true;
    }

    const touched = new Set();

    for (const { file, kind } of valid) {
      const k = pairKey(file.name);
      let target = jobs.find((j) =>
        j.key === k && ((kind === 'deck' && !j.deckFile) || (kind === 'pdf' && !j.pdfFile)),
      );
      if (!target) {
        // Also replace same-key existing slot if dropped again and idle.
        target = jobs.find((j) => j.key === k && j.status !== 'running');
      }
      if (!target) {
        target = {
          id: nextId++,
          key: k,
          title: stripDeckExtension(file.name) || file.name,
          deckFile: null,
          pdfFile: null,
          soloPaired: false,
          overrideHidden: null,
          overrideAttachMode: null,
          confirmedMismatch: false,
          inspect: null,
          inspectError: '',
          inspecting: false,
          inspectToken: 0,
          pendingDecision: null,
          attachReport: null,
          status: 'waiting',
          pct: 0,
          progressText: '',
          outputBytes: null,
          outputName: '',
          outputUrl: '',
          meta: null,
          warnings: [],
          error: '',
        };
        jobs.push(target);
      }

      if (kind === 'deck') target.deckFile = file;
      else target.pdfFile = file;

      target.title = stripDeckExtension((target.pdfFile && target.pdfFile.name) || target.deckFile.name) || target.title;
      revokeJobUrl(target);
      target.outputBytes = null;
      target.meta = null;
      target.error = '';
      target.warnings = [];
      target.inspect = null;
      target.inspectError = '';
      target.overrideAttachMode = null;
      target.confirmedMismatch = false;
      target.pendingDecision = null;
      target.attachReport = null;
      target.soloPaired = false;
      target.status = target.deckFile && target.pdfFile ? 'ready' : 'waiting';
      touched.add(target);
    }

    // Convenient single-pair fallback: if exactly 1 deck-only and 1 pdf-only waiting job remain, pair them.
    const deckOnly = jobs.filter((j) => j.deckFile && !j.pdfFile);
    const pdfOnly = jobs.filter((j) => j.pdfFile && !j.deckFile);
    if (deckOnly.length === 1 && pdfOnly.length === 1) {
      const dJob = deckOnly[0];
      const pJob = pdfOnly[0];
      dJob.pdfFile = pJob.pdfFile;
      dJob.title = stripDeckExtension(pJob.pdfFile.name) || dJob.title;
      dJob.soloPaired = true;
      dJob.status = 'ready';
      const idx = jobs.indexOf(pJob);
      if (idx >= 0) jobs.splice(idx, 1);
      touched.add(dJob);
    }

    render();
    for (const j of touched) {
      if (j.deckFile && j.pdfFile && jobs.includes(j)) {
        inspectJob(j);
      }
    }
  }

  function hasPageMismatch(job) {
    return Boolean(job.inspect && job.inspect.pdfPages !== null && job.inspect.pdfPages !== job.inspect.slideCount);
  }

  function needsMismatchConfirm(job) {
    return hasPageMismatch(job) && !job.confirmedMismatch;
  }

  async function runJob(job) {
    if (!job.deckFile || !job.pdfFile || job.status === 'running' || needsMismatchConfirm(job)) return;
    revokeJobUrl(job);
    job.status = 'running';
    job.error = '';
    job.warnings = [];
    job.pendingDecision = null;
    job.attachReport = null;
    job.pct = 2;
    job.progressText = 'Starte …';
    render();

    try {
      const opts = readGlobalOptions(job);
      const res = await castPair({
        deckFile: job.deckFile,
        pdfFile: job.pdfFile,
        ...opts,
        onDeadFilesDecision(plan) {
          return new Promise((resolve) => {
            job.pendingDecision = { plan, resolve };
            render();
          });
        },
        onProgress(ev) {
          job.pct = ev.pct;
          job.progressText = ev.text;
          updateJobProgressDom(job);
        },
      });
      job.pendingDecision = null;
      job.outputBytes = res.outputBytes;
      job.outputName = res.outputName;
      job.meta = res.meta;
      job.warnings = res.warnings;
      job.attachReport = res.attachReport || null;
      job.outputUrl = URL.createObjectURL(new Blob([res.outputBytes], { type: 'application/pdf' }));
      job.status = 'done';
      job.pct = 100;
      job.progressText = 'Fertig';
    } catch (err) {
      job.pendingDecision = null;
      job.status = 'error';
      job.error = err.message || String(err);
    }
    render();
  }

  async function runAllReady() {
    if (runningBatch) return;
    runningBatch = true;
    render();
    let skippedMismatch = 0;
    try {
      for (const job of jobs) {
        if (job.deckFile && job.pdfFile && (job.status === 'ready' || job.status === 'error')) {
          if (needsMismatchConfirm(job)) {
            skippedMismatch++;
            continue;
          }
          await runJob(job);
        }
      }
    } finally {
      runningBatch = false;
      if (skippedMismatch > 0) {
        statusBanner.hidden = false;
        statusBanner.textContent = `${skippedMismatch} Paar(e) wegen abweichender Folien-/PDF-Seitenzahl übersprungen — bitte einzeln prüfen oder über „Trotzdem erstellen“ starten.`;
      }
      render();
    }
  }

  function openInPlayer(job) {
    if (!job.outputBytes) return;
    const playerWin = window.open('../#cast', '_blank');
    if (!playerWin) {
      statusBanner.hidden = false;
      statusBanner.textContent = 'Popup blockiert — bitte Datei herunterladen und im Player öffnen.';
      return;
    }
    const payloadBytes = job.outputBytes.slice();
    const title = (job.meta && job.meta.title) || job.title;
    let sent = false;

    const sendPayload = () => {
      if (sent) return;
      sent = true;
      window.removeEventListener('message', onMsg);
      clearInterval(retryTimer);
      clearTimeout(timeoutTimer);
      try {
        playerWin.postMessage({ type: 'pdfstage:load', title, bytes: payloadBytes }, location.origin, [payloadBytes.buffer]);
      } catch {
        // Ignore if transfer not possible; user still has Download button.
      }
    };

    const onMsg = (ev) => {
      if (ev.origin !== location.origin || ev.source !== playerWin) return;
      if (ev.data && ev.data.type === 'pdfstage:ready') {
        sendPayload();
      }
    };
    window.addEventListener('message', onMsg);

    // Fallback ping in case the child listener finished before ready message arrived.
    const retryTimer = setInterval(() => {
      try {
        if (playerWin.closed) {
          clearInterval(retryTimer);
          window.removeEventListener('message', onMsg);
          return;
        }
        playerWin.postMessage({ type: 'pdfstage:ping' }, location.origin);
      } catch { /* ignore */ }
    }, 180);

    const timeoutTimer = setTimeout(() => {
      clearInterval(retryTimer);
      window.removeEventListener('message', onMsg);
    }, 8000);
  }

  function downloadAllZip() {
    const doneJobs = jobs.filter((j) => j.status === 'done' && j.outputBytes);
    if (doneJobs.length < 2) return;
    const zipBytes = buildStoreZip(doneJobs.map((j) => ({
      name: j.outputName,
      data: j.outputBytes,
    })));
    const url = URL.createObjectURL(new Blob([zipBytes], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pdfstage-batch.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function updateJobProgressDom(job) {
    const card = jobList.querySelector(`[data-job-id="${job.id}"]`);
    if (!card) return;
    const fill = card.querySelector('.progress-fill');
    const lbl = card.querySelector('.progress-label');
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, job.pct))}%`;
    if (lbl) lbl.textContent = `${job.progressText} (${job.pct}%)`;
  }

  function makeTag(text, cls = 'pill') {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function render() {
    const hasJobs = jobs.length > 0;
    actionsBar.hidden = !hasJobs;

    const runnableCount = jobs.filter((j) =>
      j.deckFile && j.pdfFile && (j.status === 'ready' || j.status === 'error') && !needsMismatchConfirm(j),
    ).length;
    const doneCount = jobs.filter((j) => j.status === 'done').length;
    runAllBtn.disabled = runningBatch || runnableCount === 0;
    runAllBtn.textContent = runningBatch ? 'Konvertierung läuft …' : (runnableCount > 1 ? `Alle erstellen (${runnableCount})` : 'Erstellen');
    zipAllBtn.hidden = doneCount < 2;
    zipAllBtn.disabled = runningBatch;
    zipAllBtn.textContent = `Alle als ZIP herunterladen (${doneCount})`;
    clearBtn.disabled = runningBatch;

    jobList.innerHTML = '';
    for (const job of jobs) {
      const card = document.createElement('article');
      card.className = `job-card status-${job.status}`;
      card.dataset.jobId = String(job.id);

      const top = document.createElement('div');
      top.className = 'job-top';

      const info = document.createElement('div');
      info.className = 'job-info';

      const titleRow = document.createElement('div');
      titleRow.className = 'job-title-row';
      const titleEl = document.createElement('div');
      titleEl.className = 'job-title';
      titleEl.textContent = job.title;
      titleRow.appendChild(titleEl);
      if (job.soloPaired) {
        titleRow.appendChild(makeTag('Einzelpaar', 'pill pill-info'));
      }
      info.appendChild(titleRow);

      const filesRow = document.createElement('div');
      filesRow.className = 'job-files';
      if (job.deckFile) {
        filesRow.appendChild(makeTag(`${job.deckFile.name} (${formatBytes(job.deckFile.size)})`, 'pill'));
      } else {
        filesRow.appendChild(makeTag('Wartet auf passende .ppsx/.pptx', 'pill pill-warn'));
      }
      if (job.pdfFile) {
        filesRow.appendChild(makeTag(`${job.pdfFile.name} (${formatBytes(job.pdfFile.size)})`, 'pill'));
      } else {
        filesRow.appendChild(makeTag('Wartet auf passende .pdf', 'pill pill-warn'));
      }
      info.appendChild(filesRow);

      if (job.inspecting) {
        const metaLine = document.createElement('div');
        metaLine.className = 'job-meta';
        metaLine.textContent = 'Prüfe Folien & PDF-Seiten …';
        info.appendChild(metaLine);
      } else if (job.inspectError) {
        const errLine = document.createElement('div');
        errLine.className = 'job-warn';
        errLine.textContent = `Prüfung fehlgeschlagen: ${job.inspectError}`;
        info.appendChild(errLine);
      } else if (job.inspect) {
        const metaLine = document.createElement('div');
        metaLine.className = 'job-meta';
        const pagesTxt = job.inspect.pdfPages !== null ? `${job.inspect.pdfPages}` : '?';
        metaLine.textContent = `${job.inspect.slideCount} Folien · ${job.inspect.audioTracks} Tonspuren · ${pagesTxt} PDF-Seiten`;
        info.appendChild(metaLine);

        if (hasPageMismatch(job)) {
          const warnBox = document.createElement('div');
          warnBox.className = 'job-warn';
          warnBox.append(`${job.inspect.slideCount} Folien vs. ${job.inspect.pdfPages} PDF-Seiten. `);
          let hasInlineBtn = false;
          if (!job.inspect.includeHiddenUsed &&
              job.inspect.hiddenCount > 0 &&
              job.inspect.pdfPages === job.inspect.slideCount + job.inspect.hiddenCount) {
            const fixBtn = document.createElement('button');
            fixBtn.type = 'button';
            fixBtn.className = 'btn-inline';
            fixBtn.textContent = `Ausgeblendete Folien (${job.inspect.hiddenCount}) einschließen`;
            fixBtn.addEventListener('click', () => {
              job.overrideHidden = true;
              inspectJob(job);
            });
            warnBox.appendChild(fixBtn);
            hasInlineBtn = true;
          } else if (job.inspect.includeHiddenUsed &&
              job.inspect.hiddenCount > 0 &&
              job.inspect.pdfPages === job.inspect.slideCount - job.inspect.hiddenCount) {
            const fixBtn = document.createElement('button');
            fixBtn.type = 'button';
            fixBtn.className = 'btn-inline';
            fixBtn.textContent = 'Ausgeblendete Folien auslassen';
            fixBtn.addEventListener('click', () => {
              job.overrideHidden = false;
              inspectJob(job);
            });
            warnBox.appendChild(fixBtn);
            hasInlineBtn = true;
          }
          if (needsMismatchConfirm(job) && job.status !== 'running') {
            if (hasInlineBtn) warnBox.append(' ');
            const confirmBtn = document.createElement('button');
            confirmBtn.type = 'button';
            confirmBtn.className = 'btn-inline';
            confirmBtn.textContent = 'Trotzdem erstellen';
            confirmBtn.addEventListener('click', () => {
              job.confirmedMismatch = true;
              runJob(job);
            });
            warnBox.appendChild(confirmBtn);
          } else if (job.confirmedMismatch) {
            warnBox.append(' (bestätigt)');
          }
          info.appendChild(warnBox);
        }

        if (job.inspect.sourceMismatch) {
          const srcWarn = document.createElement('div');
          srcWarn.className = 'job-warn';
          srcWarn.textContent = job.inspect.sourceMismatch;
          info.appendChild(srcWarn);
        }

        if (job.inspect.attachmentInfo && job.inspect.attachmentInfo.text) {
          const attLine = document.createElement('div');
          attLine.className = 'job-info-line';
          attLine.textContent = job.inspect.attachmentInfo.text;
          info.appendChild(attLine);
        } else if (job.inspect.attachmentPlan && job.inspect.attachmentPlan.deadFiles.length > 0) {
          const p = job.inspect.attachmentPlan;
          const sigDead = p.deadBytes >= 32768 || p.deadFiles.some((f) => f.name !== 'pdfstage.json');
          if (sigDead) {
            const deadNames = p.deadFiles
              .filter((f) => f.name !== 'pdfstage.json' || p.deadFiles.length === 1)
              .map((f) => `${f.name} (${formatBytes(f.bytes)})`)
              .join(', ');
            const attLine = document.createElement('div');
            attLine.className = p.canReplace ? 'job-info-line' : 'job-warn';
            if (p.canReplace) {
              const effMode = readAttachMode(job);
              const extraNote = p.revisionsAfterDead > 0 ? ', spätere PDF-Annotationen bleiben erhalten' : '';
              const modeTxt = effMode === 'append'
                ? `Modus: Anhängen (+${formatBytes(p.deadBytes)} Altlast)`
                : effMode === 'ask'
                  ? `Ersetzen möglich (–${formatBytes(p.reclaimableBytes)}${extraNote}) · Fragt beim Erstellen`
                  : `Altlast wird sauber entfernt (–${formatBytes(p.reclaimableBytes)}${extraNote})`;
              attLine.append(`Bestehende Anhänge (${deadNames}) · ${modeTxt} `);
              const toggleBtn = document.createElement('button');
              toggleBtn.type = 'button';
              toggleBtn.className = 'btn-inline';
              toggleBtn.disabled = job.status === 'running';
              toggleBtn.textContent = effMode === 'append' ? 'Auf Ersetzen umstellen' : 'Auf Anhängen umstellen';
              toggleBtn.addEventListener('click', () => {
                job.overrideAttachMode = effMode === 'append' ? 'replace' : 'append';
                render();
              });
              attLine.appendChild(toggleBtn);
            } else {
              attLine.textContent = `Bestehende Anhänge (${deadNames}) · Entstehen ${formatBytes(p.deadBytes)} Altlast beim Anhängen (${p.replaceBlockedReason}).`;
            }
            info.appendChild(attLine);
          }
        }
      }

      const actions = document.createElement('div');
      actions.className = 'job-actions';

      if (job.status === 'ready' || job.status === 'error') {
        const goBtn = document.createElement('button');
        goBtn.type = 'button';
        goBtn.className = 'btn-primary';
        const mismatchBlocked = needsMismatchConfirm(job);
        goBtn.disabled = runningBatch || job.inspecting || mismatchBlocked;
        if (mismatchBlocked) {
          goBtn.title = 'Seitenzahl weicht ab — bitte über „Trotzdem erstellen“ bestätigen oder Folien-Option anpassen.';
        }
        goBtn.textContent = job.status === 'error' ? 'Erneut' : 'Erstellen';
        goBtn.addEventListener('click', () => runJob(job));
        actions.appendChild(goBtn);
      } else if (job.status === 'done') {
        const dl = document.createElement('a');
        dl.className = 'btn-primary';
        dl.href = job.outputUrl;
        dl.download = job.outputName;
        dl.textContent = `Herunterladen (${formatBytes(job.outputBytes.length)})`;
        actions.appendChild(dl);

        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'btn-secondary';
        playBtn.textContent = 'Im Player öffnen';
        playBtn.addEventListener('click', () => openInPlayer(job));
        actions.appendChild(playBtn);
      }

      if (job.status !== 'running') {
        const rmBtn = document.createElement('button');
        rmBtn.type = 'button';
        rmBtn.className = 'btn-icon';
        rmBtn.title = 'Eintrag entfernen';
        rmBtn.textContent = '×';
        rmBtn.addEventListener('click', () => {
          revokeJobUrl(job);
          const idx = jobs.indexOf(job);
          if (idx >= 0) jobs.splice(idx, 1);
          render();
        });
        actions.appendChild(rmBtn);
      }

      top.appendChild(info);
      top.appendChild(actions);
      card.appendChild(top);

      if (job.status === 'running') {
        const prog = document.createElement('div');
        prog.className = 'progress-wrap';
        const track = document.createElement('div');
        track.className = 'progress-track';
        const fill = document.createElement('div');
        fill.className = 'progress-fill';
        fill.style.width = `${job.pct}%`;
        track.appendChild(fill);
        const lbl = document.createElement('div');
        lbl.className = 'progress-label';
        lbl.textContent = `${job.progressText} (${job.pct}%)`;
        prog.appendChild(track);
        prog.appendChild(lbl);
        card.appendChild(prog);

        if (job.pendingDecision && job.pendingDecision.plan) {
          const dp = job.pendingDecision.plan;
          const dec = job.pendingDecision;
          const deadNames = dp.deadFiles
            .filter((f) => f.name !== 'pdfstage.json' || dp.deadFiles.length === 1)
            .map((f) => `${f.name} (${formatBytes(f.bytes)})`)
            .join(', ');
          const box = document.createElement('div');
          box.className = 'job-confirm';
          const msg = document.createElement('div');
          const annotNote = dp.revisionsAfterDead > 0
            ? ' Spätere PDF-Annotationen bleiben dabei erhalten.'
            : '';
          msg.textContent = `Im PDF liegt bereits ${deadNames}. Ohne Entfernen würden ${formatBytes(dp.deadBytes)} verwaiste Daten im PDF verbleiben.${annotNote}`;
          const btnRow = document.createElement('div');
          btnRow.className = 'job-confirm-actions';

          const replaceBtn = document.createElement('button');
          replaceBtn.type = 'button';
          replaceBtn.className = 'btn-primary';
          replaceBtn.textContent = `Alte Anhänge ersetzen (–${formatBytes(dp.reclaimableBytes)})`;
          replaceBtn.addEventListener('click', () => {
            job.pendingDecision = null;
            dec.resolve('replace');
            render();
          });

          const appendBtn = document.createElement('button');
          appendBtn.type = 'button';
          appendBtn.className = 'btn-secondary';
          appendBtn.textContent = `Anhängen (+${formatBytes(dp.deadBytes)})`;
          appendBtn.addEventListener('click', () => {
            job.pendingDecision = null;
            dec.resolve('append');
            render();
          });

          btnRow.appendChild(replaceBtn);
          btnRow.appendChild(appendBtn);
          box.appendChild(msg);
          box.appendChild(btnRow);
          card.appendChild(box);
        }
      }

      if (job.status === 'done' && job.meta) {
        const summary = document.createElement('div');
        summary.className = 'job-summary';
        const dur = job.meta.audio ? `Dauer ${formatDuration(job.meta.duration)} · ` : 'Nur Folien & Kapitel · ';
        let attachNote = '';
        if (job.attachReport) {
          const { appliedMode, plan } = job.attachReport;
          if (appliedMode === 'noop') {
            attachNote = ' · Unverändert (0 B)';
          } else if (appliedMode === 'replace' && plan && plan.reclaimableBytes > 0) {
            const onlyMetaDead = plan.deadFiles.length > 0 && plan.deadFiles.every((f) => f.name === 'pdfstage.json');
            const baseTxt = onlyMetaDead
              ? ' · Metadaten aktualisiert'
              : ` · Altlast entfernt (–${formatBytes(plan.reclaimableBytes)})`;
            attachNote = plan.revisionsAfterDead > 0
              ? `${baseTxt}, PDF-Annotationen erhalten`
              : baseTxt;
          } else if (appliedMode === 'append' && plan && plan.deadBytes > 0) {
            attachNote = ` · Angehängt (+${formatBytes(plan.deadBytes)} Altlast)`;
          }
        }
        summary.textContent = `${dur}${job.outputName} · Quelldatei ${formatBytes(job.deckFile.size)} → ${formatBytes(job.outputBytes.length)}${attachNote}`;
        card.appendChild(summary);
      }

      if (job.status === 'error' && job.error) {
        const errBox = document.createElement('div');
        errBox.className = 'job-error';
        errBox.textContent = job.error;
        card.appendChild(errBox);
      }

      if (job.warnings && job.warnings.length > 0) {
        for (const w of job.warnings) {
          const wBox = document.createElement('div');
          wBox.className = 'job-warn';
          wBox.textContent = w;
          card.appendChild(wBox);
        }
      }

      jobList.appendChild(card);
    }
  }

  pickBtn.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      addFiles(Array.from(fileInput.files));
    }
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null || !dropzone.contains(e.relatedTarget)) {
      dropzone.classList.remove('dragover');
    }
  });

  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const files = await collectDroppedFiles(e.dataTransfer);
    if (files.length > 0) addFiles(files);
  });

  const reinspectAllReady = () => {
    for (const job of jobs) {
      if (job.deckFile && job.pdfFile && job.status !== 'running') {
        inspectJob(job);
      }
    }
  };
  hiddenInput.addEventListener('change', () => {
    for (const job of jobs) {
      if (job.overrideHidden === null && job.deckFile && job.pdfFile && job.status !== 'running') {
        inspectJob(job);
      }
    }
  });
  silentInput.addEventListener('change', reinspectAllReady);
  tailInput.addEventListener('change', reinspectAllReady);
  bitrateInput.addEventListener('change', reinspectAllReady);
  viewerOnlyInput.addEventListener('change', reinspectAllReady);
  if (attachModeInput) {
    attachModeInput.addEventListener('change', () => {
      saveAttachMode(attachModeInput.value);
      render();
    });
  }

  runAllBtn.addEventListener('click', runAllReady);
  zipAllBtn.addEventListener('click', downloadAllZip);
  clearBtn.addEventListener('click', () => {
    if (runningBatch) return;
    for (const j of jobs) revokeJobUrl(j);
    jobs.length = 0;
    statusBanner.hidden = true;
    render();
  });

  const updateBtn = document.getElementById('updateBtn');
  if (window.pdfstagePwa && updateBtn) {
    const pwa = window.pdfstagePwa.initPwa({
      onUpdateAvailable() {
        updateBtn.hidden = false;
        updateBtn.disabled = false;
        updateBtn.textContent = 'Update verfügbar – neu laden';
      },
      onUpdateUnavailable() {
        updateBtn.hidden = true;
        updateBtn.disabled = false;
      },
      onBusyChange(busy) {
        updateBtn.disabled = busy;
        updateBtn.textContent = busy ? 'Aktualisiere …' : 'Update verfügbar – neu laden';
      },
      onBeforeReload() {
        if (runningBatch) {
          statusBanner.hidden = false;
          statusBanner.textContent = 'Konvertierung läuft — Update bitte erst nach Abschluss neu laden.';
          return false;
        }
        return true;
      },
    });
    updateBtn.addEventListener('click', () => { pwa.triggerUpdate(); });
    window.__pdfstageCastPwa = pwa;
  }

  render();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
  } else {
    initUI();
  }
}
