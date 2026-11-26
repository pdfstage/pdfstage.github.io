# pdfstage

Slide-synced browser player for self-contained PDFs with embedded audio and timing metadata — uniting playback, chapter markers, and full-text search in a single standard PDF file.

`pdfstage` runs **100% locally in the browser** with no uploads. Any PDF carrying a `pdfstage.json` manifest (and optional embedded audio) opens with synchronized playback and chapters; plain PDFs without metadata open directly in viewer-only mode.

## Features

- **Single-file container:** Audio and timing metadata live inside the PDF via native `/EmbeddedFiles` — the file remains a valid PDF in any standard viewer.
- **Broad browser audio support:** Plays any audio format the browser's `<audio>` element can decode (`.opus`, `.ogg`, `.mp3`, `.m4a`, `.wav`, `.webm`, `.flac`, `.aac`) with automatic MIME detection.
- **Cross-slide native full-text search (`Ctrl+F`):** Renders aligned text layers for every slide using `hidden="until-found"` and `beforematch`, automatically jumping to the matching slide and syncing audio playback.
- **Formatted text copy:** Preserves font family, bold, italic, and underline styling when copying text directly off a slide, with ink-fitted selection highlights.
- **Precision timeline controls:** Chapter ticks on the seekbar, hover/touch zoom lens for dense decks, playback speed (`0.5×`–`3.0×` in `0.05×` steps) with both original and speed-adjusted timers, and up to `300%` volume boost via Web Audio API.
- **Offline-first PWA:** Zero external runtime dependencies (bundles PDF.js and its worker inline), installable via Web App Manifest with OS `.pdf` file-handler integration (`launchQueue`), drag-and-drop, offline caching, and controlled Service Worker updates without progress loss.
- **Zero-install browser packer (`/cast/`):** Create `.stage.pdf` files directly in the browser at [`/cast/`](https://pdfstage.github.io/cast/) by exporting slides as `.pdf` from PowerPoint and dropping `.ppsx`/`.pptx` + `.pdf` together — encodes narration into Ogg Opus via Web Audio + WebCodecs without FFmpeg or uploads, supports hash-based audio reuse / 0-byte no-op idempotency, and cleans up obsolete attachments without losing PDF annotations.

## Keyboard Shortcuts

| Mode | Shortcut | Action |
| :--- | :--- | :--- |
| **Both** | `←` / `→` or `PageUp` / `PageDown` | Previous / next slide |
| **Both** | `Home` / `End` | First / last slide |
| **Both** | `F` | Toggle fullscreen |
| **Audio** | `Space` | Play / Pause |
| **Audio** | `Shift` + `←` / `→` | Seek −10 s / +10 s |
| **Audio** | `↑` / `↓` | Volume ±5% (0%–300%) |
| **Audio** | `M` | Mute / unmute |
| **Audio** | `+` / `-` / `0` | Playback speed ±0.05× / reset to 1× |

---

## Browser Packer (`/cast/`)

[`pdfstage / cast`](https://pdfstage.github.io/cast/) converts `.ppsx` / `.pptx` narration tracks + PowerPoint-exported `.pdf` slides into self-contained `.stage.pdf` files **100% locally in the browser** (zero installation, no FFmpeg, no uploads):

- **Workflow:** Export slides once from PowerPoint as `.pdf` (**PowerPoint → Datei → Öffnen → Exportieren als PDF** — note that double-clicking a `.ppsx` opens slideshow mode rather than the editor), then drag `.ppsx`/`.pptx` and `.pdf` together into `/cast/`. Multiple lecture pairs can be dropped at once; matching runs automatically by filename stem, with optional **All-as-ZIP** download and direct **Im Player öffnen** handoff.
- **Configurable options:** Silent slide duration (`Stille-Folie`), trailing silence (`Endstille`), Opus bitrate (`24`/`32`/`48`/`64 kbps`), hidden-slide inclusion (with per-job auto-mismatch detection), viewer-only mode (`Ohne Audio`), and **Bestehende Anhänge** (`replace` / `ask` / `append`, persisted in `localStorage`).
- **Smart re-packing & dead-attachment cleanup:**
  - **Audio reuse & 0-byte no-op:** Compares `provenance.audioSourceSha256` + `audioSha256` and embedded attachment bytes (ignoring `convertedAt`). Unchanged audio skips WebCodecs re-encoding, and completely unchanged re-packs return the existing PDF byte-for-byte (`0 B` appended).
  - **`replace` (default):** Before writing, inspects whether replacing/removing managed attachments (`audio.opus`, `pdfstage.json`) would leave orphaned dead bytes. When safe, removes old `pdfstage` revisions via **tail-truncation** — or via **revision-replay** (both classic xref and `/ObjStm` XRef streams) so viewer annotations added later to the `.stage.pdf` remain intact. Non-`pdfstage` attachments (e.g. handouts) and `/Catalog` `/Names` entries (e.g. `/Dests`) are preserved automatically.
  - **`ask` & `append` + safe fallbacks:** `ask` shows a pre-run summary and interactive confirmation prompt with exact byte savings; `append` always keeps the previous PDF as an exact byte prefix. Encrypted PDFs, digitally signed PDFs (`/ByteRange` / `/Perms` / `SigFlags`), and single-revision full-save PDFs automatically fall back to `append` with a clear explanation.

---

## Container Format Specification (v1)

Any PDF producer can generate `pdfstage`-compatible files by attaching a manifest named `pdfstage.json` — and optionally an audio track — as standard PDF embedded files (ISO 32000-1, §7.11.4).

No special file extension is required (standard `.pdf` works everywhere). Producers that want to visually distinguish narrated decks may optionally use `.stage.pdf`; `pdfstage` strips `.stage.pdf`, `.pdfstage.pdf`, and `.pdf` when deriving fallback titles from filenames.

### 1. PDF Embedding Requirements

Attachments MUST be registered in the document catalog's `/Names` → `/EmbeddedFiles` name tree:

```text
Catalog
 └── /Names
      └── /EmbeddedFiles (Name Tree)
           ├── "pdfstage.json" ──▶ Filespec (/F, /UF, /EF << /F ... >>) ──▶ EmbeddedFile stream
           └── "audio.opus"    ──▶ Filespec (/F, /UF, /EF << /F ... >>) ──▶ EmbeddedFile stream
```

| Attachment | Required | Stream Compression | Notes |
| :--- | :--- | :--- | :--- |
| `pdfstage.json` | For synced/chapter features | `/FlateDecode` (recommended) | UTF-8 JSON manifest. Must be named `pdfstage.json`. If omitted, `pdfstage` opens in plain viewer-only mode. |
| `<audio>` (e.g. `audio.opus`) | No | **None / raw** (recommended for compressed codecs) | Exact filename referenced by `audio` in `pdfstage.json`. Pre-compressed formats (Opus, MP3, AAC, etc.) gain nothing from `/FlateDecode`; storing them raw avoids wasted CPU and Base64 overhead. |

**Lookup behavior:** The player resolves attachments by matching either the `/EmbeddedFiles` name-tree key or the filespec filename (`/F` / `/UF`).

**Recommended authoring method — PDF Incremental Update:**  
Appending the `/EmbeddedFiles` tree and streams via a standard PDF incremental update leaves all existing page streams, fonts, and text layers untouched, and can be implemented without external PDF libraries. Any standard PDF library or CLI writing valid `/Names` → `/EmbeddedFiles` entries is equally compatible.

---

### 2. Manifest Schema (`pdfstage.json`)

```json
{
  "v": 1,
  "title": "Lecture 1: Introduction",
  "audio": "audio.opus",
  "duration": 1842.65,
  "starts": [0, 48.215, 134.8, 210.05],
  "titles": [
    "Lecture 1: Introduction",
    "Course Overview & Schedule",
    "Core Definitions",
    "Summary & Reading List"
  ],
  "provenance": {
    "sourceUrl": "https://example.edu/courses/101/lecture-01.pptx",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "bytes": 110729625,
    "convertedAt": "2026-11-25T18:30:00Z",
    "hiddenIncluded": false,
    "silentSeconds": 5,
    "tailSilence": 1.5
  }
}
```

#### Top-Level Fields

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `v` | integer | **Yes** (spec) | Schema version (`1`). Reserved for forward compatibility; not strictly enforced by the v1 player. |
| `title` | string | Recommended | Deck title displayed in the header and browser tab. Falls back to the filename (with `.stage.pdf` / `.pdfstage.pdf` / `.pdf` stripped). |
| `audio` | string | No | Attachment filename in `/EmbeddedFiles` (e.g. `"audio.opus"`, `"track.mp3"`). Omit (or leave empty) for **viewer-only** mode. |
| `audioMime` | string | No | Optional explicit MIME type override (e.g. `"audio/ogg"` or `"audio/mpeg"`). When omitted, `pdfstage` infers the MIME type from the filename extension, magic bytes, or browser sniffing. |
| `duration` | number | Recommended with `audio` | Total audio duration in seconds. If omitted or `<= 0`, the player falls back to the decoded `<audio>` element's `duration` once metadata loads. |
| `starts` | number[] | When `audio` is set | Slide start timestamps in seconds. Index `i` maps to 1-based PDF page `i + 1`. |
| `titles` | string[] | Recommended | Chapter label per slide (index `i` maps to PDF page `i + 1`). Labels longer than 68 characters are truncated by the player; missing entries fall back to `"Folie <n>"`. Full slide body text is intentionally omitted since `Ctrl+F` uses the PDF text layer directly. |
| `provenance` | object | No | Optional producer metadata for reproducibility and auditing (ignored at runtime). |

#### `provenance` Object Fields

All fields inside `provenance` are optional (producers may omit them or include additional keys):

| Field | Type | Description |
| :--- | :--- | :--- |
| `sourceUrl` | string | Origin URL of the source presentation, if fetched remotely. |
| `sha256` | string | Lowercase hex SHA-256 digest of the original source file. |
| `bytes` | integer | File size of the original source file in bytes. |
| `convertedAt` | string | Conversion timestamp in RFC 3339 / ISO 8601 UTC format. |
| `hiddenIncluded` | boolean | Whether hidden slides from the source deck were included in the PDF. |
| `silentSeconds` | number | Synthetic duration (in seconds) assigned to slides without recorded narration. |
| `tailSilence` | number | Trailing silence padding (in seconds) appended after narration segments. |
| `audioSha256` | string | Lowercase hex SHA-256 digest of the embedded audio track (enables attachment reuse on re-pack). |
| `audioSourceSha256` | string | Lowercase hex SHA-256 digest of source audio tracks and timing parameters (skips re-encoding when unchanged). |

---

### 3. Audio Format & Synchronization Invariants

- **Audio Formats:** Any audio container/codec supported by the browser's `<audio>` element works. **Ogg Opus** (`.opus`) is recommended for voice recordings due to its small size and broad desktop/mobile browser support (older Safari builds may require `.m4a`/AAC or `.mp3` if Ogg Opus is unavailable).
- **MIME Resolution Order:** Explicit `audioMime` in `pdfstage.json` → filename extension (`.opus`/`.ogg`/`.oga`, `.mp3`, `.m4a`/`.mp4`, `.wav`, `.webm`/`.weba`, `.flac`, `.aac`) → header magic bytes → untyped `Blob` fallback.
- **1:1 Page Mapping:** `starts.length` (when audio is present) and `titles.length` should match the PDF page count. Index `0` corresponds to PDF page `1`.
- **Monotonic Timestamps:** Values in `starts` must be non-decreasing (`starts[0] <= starts[1] <= ... <= duration`), with `starts[0]` typically `0`.
- **Active Slide Resolution:** For playback position `t`, the player selects the highest index `i` where `t >= starts[i] - 0.05` (50 ms boundary tolerance), defaulting to `0`. Jumping to slide `i` seeks to `starts[i] + 0.001`.
- **Viewer-Only Fallback:** If `pdfstage.json` is absent, `audio` is omitted, or the referenced attachment is missing/empty, `pdfstage` switches to viewer-only mode (slide navigation, chapter tooltips if `titles` exist, and full-text search).

### 4. Viewer Hint Overlay (OCG)

When embedding narration audio, both `/cast/` and the `assistant pdfstage` CLI add a non-printable hint pill in the top-right corner of Page 1 (`Enthält Audio für pdfstage.github.io`) for external PDF viewers while hiding it automatically inside `pdfstage` itself:

- Registered as an Optional Content Group (`pdfstage-hint`) under `/Catalog` → `/OCProperties` (`/ViewState /ON`, `/PrintState /OFF`, plus `/PageMode /UseAttachments` when unset or `/UseNone`).
- Positioned relative to Page 1's visible `/CropBox` (fallback `/MediaBox`) taking `/Rotate` into account, backed by a `/Stamp` annotation (`pdfstage-hint-stamp`), a clickable `/URI` link (`pdfstage-hint-link` → `https://pdfstage.github.io/`), and a `/SetOCGState` close button (`pdfstage-hint-close`).
- Idempotent on re-pack: existing user annotations and custom OCGs are merged and preserved without duplicating hint layers.

---

## Building & Inspecting Compatible PDFs

### Option A: Zero-install in the browser (`/cast/`)

Open [`https://pdfstage.github.io/cast/`](https://pdfstage.github.io/cast/) and drop your PowerPoint-exported `.pdf` alongside the `.ppsx`/`.pptx`.

### Option B: `assistant pdfstage` CLI

The companion Go CLI (`tools/assistant/ppsx`) automates PowerPoint PDF export, FFmpeg Opus timeline encoding, SHA-256 audio reuse, viewer hint generation, and clean replacement of orphaned attachments:

```bash
# Export slides (if needed), encode audio, and build <Name>.stage.pdf
assistant pdfstage lecture.ppsx

# Reuse pre-exported PDF or pre-encoded audio, keep orphaned attachments or prompt interactively
assistant pdfstage lecture.ppsx --pdf lecture.pdf --attach-mode replace   # default: tail-truncate / revision-replay
assistant pdfstage lecture.ppsx --pdf lecture.pdf --attach-mode ask       # TTY prompt when old audio would remain
assistant pdfstage lecture.ppsx --pdf lecture.pdf --attach-mode append    # preserve original PDF as exact byte prefix

# Additional CLI options: --audio [path], --viewer, --hidden, --silent-seconds 5, --tail-silence 10, --mp4, --audio-files
```

### Option C: Generic `pdfcpu` prototyping

For quick prototyping or inspection, [`pdfcpu`](https://pdfcpu.io/) can attach and extract embedded files:

```bash
# Attach manifest and audio to an existing PDF
pdfcpu attachments add deck.pdf pdfstage.json audio.opus

# List embedded files
pdfcpu attachments list deck.pdf

# Extract embedded files for inspection
pdfcpu attachments extract deck.pdf ./extracted/
```

*(Note: Generic CLI tools may compress all attachments with `/FlateDecode` by default. Using `/cast/` or `assistant pdfstage` writes minimal incremental updates with `audio.opus` stored raw and `pdfstage.json` compressed with `/FlateDecode`.)*

---

## Conformance Test Suite

Both the browser PDF engine ([`cast/pdf-attach.js`](./cast/pdf-attach.js)) and the Go CLI writer (`tools/assistant/ppsx`) are verified against a shared conformance corpus under [`test/conformance/`](./test/conformance/):

- `test/conformance/fixtures/` — 10 deterministic PDF fixtures covering classic xref, `/Rotate 90` + OCGs, `/ObjStm` + XRef streams, multi-revision viewer annotations, foreign attachments + `/Dests`, synthetic linearized PDFs, single-revision full-save PDFs, and digitally signed PDFs.
- `test/conformance/cases.json` — 11 declarative multi-step specification cases (generated deterministically by `test/conformance/generate-fixtures.mjs`).
- **JS runner:** `node test/conformance/run-js.mjs`
- **Go & cross-interop runner:** `go test -v ./ppsx` (`TestSharedConformanceCorpus` + `TestCrossInteropJSAndGo`, which runs both `run-js.mjs` and Go→JS→Go / JS→Go→JS roundtrips).

---

## License

Licensed under the [Apache License 2.0](./LICENSE).

Bundles [PDF.js](https://mozilla.github.io/pdf.js/) `3.11.174` (Copyright Mozilla Foundation, Apache License 2.0).
