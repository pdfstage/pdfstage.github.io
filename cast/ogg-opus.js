// Pure-JS RFC 7845 Ogg Opus muxer + Web Audio / WebCodecs encoder + slide timeline builder.
// Zero FFmpeg, zero external dependencies. Works in modern browsers; framing primitives work in Node.js.

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SAMPLES = 960; // 20 ms at 48 kHz
const DEFAULT_PRE_SKIP = 312; // 6.5 ms (standard libopus 48 kHz encoder lookahead)
const US_PER_SEC = 1_000_000;

const utf8Encoder = new TextEncoder();

// Ogg CRC-32 lookup table (polynomial 0x04C11DB7, MSB-first, init 0, no final XOR).
const OGG_CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    }
    tbl[i] = r >>> 0;
  }
  return tbl;
})();

export function oggCrc32(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

/**
 * Returns the 48 kHz PCM sample count represented by one RFC 6716 Opus packet.
 */
export function opusPacketSamples(packet) {
  if (!packet || packet.length === 0) return FRAME_SAMPLES;
  const toc = packet[0];
  const config = toc >> 3;
  const code = toc & 3;

  let frames = 1;
  if (code === 1 || code === 2) {
    frames = 2;
  } else if (code === 3) {
    frames = packet.length > 1 ? (packet[1] & 0x3f) : 1;
  }

  let samplesPerFrame;
  if (config < 12) {
    // SILK-only: 10, 20, 40, 60 ms
    samplesPerFrame = [480, 960, 1920, 2880][config & 3];
  } else if (config < 16) {
    // Hybrid: 10, 20 ms
    samplesPerFrame = (config & 1) ? 960 : 480;
  } else {
    // CELT-only: 2.5, 5, 10, 20 ms
    samplesPerFrame = [120, 240, 480, 960][config & 3];
  }

  return frames * samplesPerFrame;
}

export function buildOpusHead({ channels = CHANNELS, preSkip = DEFAULT_PRE_SKIP, inputSampleRate = SAMPLE_RATE, outputGain = 0 } = {}) {
  const buf = new Uint8Array(19);
  const view = new DataView(buf.buffer);
  buf.set(utf8Encoder.encode('OpusHead'), 0);
  buf[8] = 1; // version
  buf[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputSampleRate, true);
  view.setInt16(16, outputGain, true);
  buf[18] = 0; // mapping family 0 (mono/stereo)
  return buf;
}

export function buildOpusTags(vendor = 'pdfstage/cast') {
  const vBytes = utf8Encoder.encode(vendor);
  const buf = new Uint8Array(8 + 4 + vBytes.length + 4);
  const view = new DataView(buf.buffer);
  buf.set(utf8Encoder.encode('OpusTags'), 0);
  view.setUint32(8, vBytes.length, true);
  buf.set(vBytes, 12);
  view.setUint32(12 + vBytes.length, 0, true); // user comment list length = 0
  return buf;
}

function writeGranule64(view, offset, value) {
  if (value < 0) {
    view.setUint32(offset, 0xffffffff, true);
    view.setUint32(offset + 4, 0xffffffff, true);
    return;
  }
  const big = BigInt(Math.round(value));
  view.setUint32(offset, Number(big & 0xffffffffn), true);
  view.setUint32(offset + 4, Number((big >> 32n) & 0xffffffffn), true);
}

function buildOggPage({ headerType = 0, granulePos = 0, serial = 1, pageSeq = 0, packets = [] }) {
  const laces = [];
  let bodyLen = 0;
  for (const pkt of packets) {
    let rem = pkt.byteLength;
    bodyLen += rem;
    while (rem >= 255) {
      laces.push(255);
      rem -= 255;
    }
    laces.push(rem);
  }
  if (laces.length > 255) {
    throw new Error(`Ogg-Seite übersteigt 255 Segmente (${laces.length})`);
  }

  const page = new Uint8Array(27 + laces.length + bodyLen);
  const view = new DataView(page.buffer);
  page[0] = 0x4f; // 'O'
  page[1] = 0x67; // 'g'
  page[2] = 0x67; // 'g'
  page[3] = 0x53; // 'S'
  page[4] = 0; // stream_structure_version
  page[5] = headerType;
  writeGranule64(view, 6, granulePos);
  view.setUint32(14, serial >>> 0, true);
  view.setUint32(18, pageSeq >>> 0, true);
  view.setUint32(22, 0, true); // CRC placeholder
  page[26] = laces.length;
  for (let i = 0; i < laces.length; i++) {
    page[27 + i] = laces[i];
  }

  let off = 27 + laces.length;
  for (const pkt of packets) {
    page.set(pkt, off);
    off += pkt.byteLength;
  }

  view.setUint32(22, oggCrc32(page), true);
  return page;
}

/**
 * Stateful RFC 7845 Ogg Opus page muxer.
 */
export class OggOpusMuxer {
  constructor({ serial = 0x50535447, preSkip = DEFAULT_PRE_SKIP, vendor = 'pdfstage/cast' } = {}) {
    this.serial = serial >>> 0;
    this.preSkip = preSkip;
    this.vendor = vendor;
    this.pageSeq = 0;
    this.pages = [];
    this.headersWritten = false;
    this.headBytes = null;
    this.pendingPackets = [];
    this.pendingLaces = 0;
    this.encodedSamples = 0;
  }

  setOpusHead(headBytes) {
    if (this.headersWritten) return;
    if (headBytes && headBytes.length >= 19 &&
        headBytes[0] === 0x4f && headBytes[1] === 0x70 && headBytes[2] === 0x75 && headBytes[3] === 0x73) {
      this.headBytes = new Uint8Array(headBytes);
      const view = new DataView(this.headBytes.buffer, this.headBytes.byteOffset, this.headBytes.byteLength);
      this.preSkip = view.getUint16(10, true);
    }
  }

  _ensureHeaders() {
    if (this.headersWritten) return;
    this.headersWritten = true;
    const head = this.headBytes || buildOpusHead({ channels: CHANNELS, preSkip: this.preSkip, inputSampleRate: SAMPLE_RATE });
    const tags = buildOpusTags(this.vendor);
    this.pages.push(buildOggPage({
      headerType: 0x02, // BOS
      granulePos: 0,
      serial: this.serial,
      pageSeq: this.pageSeq++,
      packets: [head],
    }));
    this.pages.push(buildOggPage({
      headerType: 0x00,
      granulePos: 0,
      serial: this.serial,
      pageSeq: this.pageSeq++,
      packets: [tags],
    }));
  }

  _packetLaceCount(len) {
    return Math.floor(len / 255) + 1;
  }

  addPacket(packetBytes, packetSamples = opusPacketSamples(packetBytes)) {
    this._ensureHeaders();
    const pkt = packetBytes instanceof Uint8Array ? packetBytes : new Uint8Array(packetBytes);
    const needed = this._packetLaceCount(pkt.byteLength);

    if (this.pendingPackets.length > 0 &&
        (this.pendingLaces + needed > 255 || this.pendingPackets.length >= 50)) {
      this._flushPage(0x00, this.encodedSamples);
    }

    // Should a single jumbo packet ever exceed 255 segments (>64 KB, invalid for Opus, guard anyway):
    if (needed > 255) {
      throw new Error(`Opus-Paket zu groß für eine Ogg-Seite (${pkt.byteLength} Bytes)`);
    }

    this.encodedSamples += packetSamples;
    this.pendingPackets.push(pkt);
    this.pendingLaces += needed;
  }

  _flushPage(headerType, granulePos) {
    this._ensureHeaders();
    this.pages.push(buildOggPage({
      headerType,
      granulePos,
      serial: this.serial,
      pageSeq: this.pageSeq++,
      packets: this.pendingPackets,
    }));
    this.pendingPackets = [];
    this.pendingLaces = 0;
  }

  finish(targetEndGranule = this.encodedSamples) {
    this._ensureHeaders();
    const finalGranule = Math.min(this.encodedSamples, Math.max(0, Math.round(targetEndGranule)));
    if (this.pendingPackets.length > 0) {
      this._flushPage(0x04, finalGranule);
    } else {
      this._flushPage(0x04, finalGranule);
    }
    let total = 0;
    for (const p of this.pages) total += p.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of this.pages) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  }
}

export function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function encodeWavFromChunks(int16Chunks, totalSamples, sampleRate = SAMPLE_RATE) {
  const dataBytes = totalSamples * CHANNELS * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  out.set(utf8Encoder.encode('RIFF'), 0);
  view.setUint32(4, 36 + dataBytes, true);
  out.set(utf8Encoder.encode('WAVE'), 8);
  out.set(utf8Encoder.encode('fmt '), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * CHANNELS * 2, true);
  view.setUint16(32, CHANNELS * 2, true);
  view.setUint16(34, 16, true);
  out.set(utf8Encoder.encode('data'), 36);
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (const chunk of int16Chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

async function selectOpusEncoderConfig(bitrate) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
    return null;
  }
  const candidates = [
    {
      codec: 'opus',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate,
      opus: { frameDuration: 20000 },
    },
    {
      codec: 'opus',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate,
    },
  ];
  for (const cfg of candidates) {
    try {
      const res = await AudioEncoder.isConfigSupported(cfg);
      if (res && res.supported) return res.config || cfg;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function extractStereoPlanar(audioBuffer) {
  const len = audioBuffer.length;
  const chCount = audioBuffer.numberOfChannels;
  if (chCount === 1) {
    const ch0 = audioBuffer.getChannelData(0);
    return [ch0, ch0];
  }
  if (chCount === 2) {
    return [audioBuffer.getChannelData(0), audioBuffer.getChannelData(1)];
  }
  // Downmix >2 channels equally into stereo.
  const left = new Float32Array(len);
  const right = new Float32Array(len);
  for (let c = 0; c < chCount; c++) {
    const data = audioBuffer.getChannelData(c);
    const lGain = c % 2 === 0 ? 1 / Math.ceil(chCount / 2) : 0;
    const rGain = c % 2 === 1 ? 1 / Math.floor(chCount / 2) : 0;
    if (lGain > 0) for (let i = 0; i < len; i++) left[i] += data[i] * lGain;
    if (rGain > 0) for (let i = 0; i < len; i++) right[i] += data[i] * rGain;
  }
  return [left, right];
}

function floatToInt16InterleavedBytes(left, right, start, count) {
  const bytes = new Uint8Array(count * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    const l = Math.max(-1, Math.min(1, left[start + i]));
    const r = Math.max(-1, Math.min(1, right[start + i]));
    view.setInt16(i * 4, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    view.setInt16(i * 4 + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
  }
  return bytes;
}

/**
 * Decodes all slide audio tracks in playback order, stitches silence for silent slides
 * and tail padding, and encodes directly to Ogg Opus via WebCodecs (with WAV fallback).
 */
export async function buildDeckAudio(deck, {
  silentSeconds = 5,
  tailSilence = 10,
  bitrate = 32000,
  onProgress = null,
} = {}) {
  const warnings = [];
  if (deck.missing && deck.missing.length > 0) {
    warnings.push(`Fehlende Audiodatei(en) im Paket übersprungen: ${deck.missing.join(', ')}`);
  }

  if (deck.audioTrackCount === 0) {
    return {
      audioBytes: null,
      audioName: '',
      audioMime: '',
      starts: [],
      duration: 0,
      warnings,
    };
  }

  const encoderConfig = await selectOpusEncoderConfig(bitrate);
  const useOpus = encoderConfig !== null;
  if (!useOpus) {
    warnings.push('WebCodecs Opus in diesem Browser nicht verfügbar — unkomprimiertes WAV als Fallback erzeugt.');
  }

  // Headless OfflineAudioContext resamples every decoded track to 48 kHz without requiring an audio device.
  const AudioCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!AudioCtx) {
    throw new Error('Web Audio API (OfflineAudioContext) ist in diesem Browser nicht verfügbar');
  }
  const decodeCtx = new AudioCtx(CHANNELS, 1, SAMPLE_RATE);

  let encoder = null;
  let muxer = null;
  let encoderError = null;
  let wavChunks = [];

  if (useOpus) {
    muxer = new OggOpusMuxer();
    encoder = new AudioEncoder({
      output(chunk, metadata) {
        if (metadata && metadata.decoderConfig && metadata.decoderConfig.description) {
          muxer.setOpusHead(new Uint8Array(metadata.decoderConfig.description));
        }
        const raw = new Uint8Array(chunk.byteLength);
        chunk.copyTo(raw);
        muxer.addPacket(raw);
      },
      error(err) {
        encoderError = err instanceof Error ? err : new Error(String(err));
      },
    });
    encoder.configure(encoderConfig);
  }

  let curSample = 0;
  const zeroPlane = new Float32Array(FRAME_SAMPLES);
  const zeroStereo = new Float32Array(FRAME_SAMPLES * CHANNELS);

  async function pushFrame(leftView, rightView, count) {
    if (encoderError) throw encoderError;
    if (useOpus) {
      while (encoder.encodeQueueSize > 32) {
        await new Promise((r) => setTimeout(r, 0));
        if (encoderError) throw encoderError;
      }
      const planar = new Float32Array(count * CHANNELS);
      planar.set(leftView, 0);
      planar.set(rightView, count);
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate: SAMPLE_RATE,
        numberOfChannels: CHANNELS,
        numberOfFrames: count,
        timestamp: Math.round((curSample * US_PER_SEC) / SAMPLE_RATE),
        data: planar,
      });
      try {
        encoder.encode(audioData);
      } finally {
        audioData.close();
      }
    } else {
      wavChunks.push(floatToInt16InterleavedBytes(leftView, rightView, 0, count));
    }
    curSample += count;
  }

  async function pushStereoArrays(left, right) {
    const total = left.length;
    for (let pos = 0; pos < total; pos += FRAME_SAMPLES) {
      const n = Math.min(FRAME_SAMPLES, total - pos);
      await pushFrame(left.subarray(pos, pos + n), right.subarray(pos, pos + n), n);
    }
  }

  async function pushSilence(sampleCount) {
    let rem = Math.max(0, Math.round(sampleCount));
    while (rem > 0) {
      const n = Math.min(FRAME_SAMPLES, rem);
      if (useOpus) {
        while (encoder.encodeQueueSize > 32) {
          await new Promise((r) => setTimeout(r, 0));
          if (encoderError) throw encoderError;
        }
        const dataView = n === FRAME_SAMPLES ? zeroStereo : new Float32Array(n * CHANNELS);
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: SAMPLE_RATE,
          numberOfChannels: CHANNELS,
          numberOfFrames: n,
          timestamp: Math.round((curSample * US_PER_SEC) / SAMPLE_RATE),
          data: dataView,
        });
        try {
          encoder.encode(audioData);
        } finally {
          audioData.close();
        }
      } else {
        wavChunks.push(new Uint8Array(n * CHANNELS * 2));
      }
      curSample += n;
      rem -= n;
    }
  }

  const starts = [];
  const slideCount = deck.slides.length;

  try {
    for (let i = 0; i < slideCount; i++) {
      const slide = deck.slides[i];
      starts.push(round3(curSample / SAMPLE_RATE));

      if (onProgress) {
        onProgress({ slideIndex: i, slideCount, phase: slide.audio.length > 0 ? 'audio' : 'silence' });
      }

      if (slide.audio.length > 0) {
        let playedAny = false;
        for (const mediaPath of slide.audio) {
          const encodedBytes = await deck.zip.readEntry(mediaPath);
          if (!encodedBytes || encodedBytes.byteLength === 0) {
            warnings.push(`Folie ${i + 1}: ${mediaPath} konnte nicht gelesen werden.`);
            continue;
          }
          let decoded;
          try {
            const copy = new Uint8Array(encodedBytes.byteLength);
            copy.set(encodedBytes);
            decoded = await decodeCtx.decodeAudioData(copy.buffer);
          } catch (err) {
            const fileName = mediaPath.split('/').pop() || mediaPath;
            throw new Error(
              `Folie ${i + 1} (${fileName}): Audio-Codec wird von diesem Browser nicht unterstützt (${err.message || 'decodeAudioData fehlgeschlagen'}).`,
            );
          }
          const [left, right] = extractStereoPlanar(decoded);
          await pushStereoArrays(left, right);
          playedAny = true;
        }
        if (!playedAny) {
          const fallbackDur = slide.advance > 0 ? slide.advance : silentSeconds;
          await pushSilence(fallbackDur * SAMPLE_RATE);
        }
      } else {
        const dur = slide.advance > 0 ? slide.advance : silentSeconds;
        await pushSilence(dur * SAMPLE_RATE);
      }

      // Yield occasionally so UI animations & progress remain responsive.
      if (i % 4 === 3) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (tailSilence > 0) {
      await pushSilence(tailSilence * SAMPLE_RATE);
    }

    const totalInputSamples = curSample;
    const duration = round3(totalInputSamples / SAMPLE_RATE);

    if (useOpus) {
      if (onProgress) {
        onProgress({ slideIndex: slideCount, slideCount, phase: 'finalize' });
      }
      // Feed priming tail zeros equal to preSkip + 1 frame so the encoder flushes every real sample.
      const padSamples = muxer.preSkip + FRAME_SAMPLES;
      await pushSilence(padSamples);
      await encoder.flush();
      if (encoderError) throw encoderError;
      encoder.close();
      encoder = null;

      const opusBytes = muxer.finish(muxer.preSkip + totalInputSamples);
      return {
        audioBytes: opusBytes,
        audioName: 'audio.opus',
        audioMime: 'audio/ogg',
        starts,
        duration,
        warnings,
      };
    }

    const wavBytes = encodeWavFromChunks(wavChunks, totalInputSamples, SAMPLE_RATE);
    return {
      audioBytes: wavBytes,
      audioName: 'audio.wav',
      audioMime: 'audio/wav',
      starts,
      duration,
      warnings,
    };
  } finally {
    if (encoder) {
      try { encoder.close(); } catch { /* ignore */ }
    }
    void zeroPlane;
  }
}
