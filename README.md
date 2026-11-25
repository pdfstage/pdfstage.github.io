# pdfstage

Slide-synced browser player for self-contained PDFs with embedded audio and timing metadata — uniting playback, chapter markers, and full-text search in a single standard PDF file.

`pdfstage` runs **100% locally in the browser** with no uploads. Any PDF carrying a conforming `ppsx.json` manifest (and optional embedded audio) opens with synchronized playback and chapters; plain PDFs without metadata open directly in viewer-only mode.

## Features

- **Single-file container:** Audio and timing metadata live inside the PDF via native `/EmbeddedFiles` — the file remains a standard PDF in any viewer.
- **Broad browser audio support:** Plays any audio format the browser's `<audio>` element can decode (`.opus`, `.ogg`, `.mp3`, `.m4a`, `.wav`, `.webm`, `.flac`, `.aac`) with automatic MIME detection.
- **Cross-slide native full-text search (`Ctrl+F`):** Renders aligned text layers for every slide using `hidden="until-found"` and `beforematch`, automatically jumping to the matching slide and syncing audio playback.
- **Formatted text copy:** Preserves font family, bold, italic, and underline styling when copying text directly off a slide, with ink-fitted selection highlights.
- **Precision timeline controls:** Chapter ticks on the seekbar, hover/touch zoom lens for dense decks, playback speed (`0.5×`–`3.0×` in `0.05×` steps) with both original and speed-adjusted timers, and up to `300%` volume boost via Web Audio API.
- **Offline-first PWA:** Zero external runtime dependencies (bundles PDF.js and its worker inline), installable via Web App Manifest with OS `.pdf` file-handler integration (`launchQueue`), drag-and-drop, and offline caching.

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

## Container Format Specification (v1)

Any PDF producer can generate `pdfstage`-compatible files by attaching a manifest named `ppsx.json` — and optionally an audio track — as standard PDF embedded files (ISO 32000-1, §7.11.4).

### 1. PDF Embedding Requirements

Attachments MUST be registered in the document catalog's `/Names` → `/EmbeddedFiles` name tree:

```text
Catalog
 └── /Names
      └── /EmbeddedFiles (Name Tree)
           ├── "ppsx.json"  ──▶ Filespec (/F, /UF, /EF << /F ... >>) ──▶ EmbeddedFile stream
           └── "audio.opus" ──▶ Filespec (/F, /UF, /EF << /F ... >>) ──▶ EmbeddedFile stream
```

| Attachment | Required | Stream Compression | Notes |
| :--- | :--- | :--- | :--- |
| `ppsx.json` | For synced/chapter features | `/FlateDecode` (recommended) | UTF-8 JSON manifest. Must be named `ppsx.json` (kept for compatibility with existing PPSX export pipelines). If omitted, `pdfstage` opens in plain viewer-only mode. |
| `<audio>` (e.g. `audio.opus`) | No | **None / raw** (recommended for compressed codecs) | Exact filename referenced by `audio` in `ppsx.json`. Pre-compressed formats (Opus, MP3, AAC, etc.) gain nothing from `/FlateDecode`; storing them raw avoids wasted CPU and Base64 overhead. |

**Lookup behavior:** The player resolves attachments by matching either the `/EmbeddedFiles` name-tree key or the filespec filename (`/F` / `/UF`).

**Recommended authoring method — PDF Incremental Update:**  
Appending the `/EmbeddedFiles` tree and streams via a standard PDF incremental update leaves all existing page streams, fonts, and text layers untouched, and can be implemented without external PDF manipulation dependencies. Any standard PDF library or CLI writing valid `/Names` → `/EmbeddedFiles` entries is equally compatible.

---

### 2. Manifest Schema (`ppsx.json`)

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
    "sourceUrl": "[https://example.edu/courses/101/lecture-01.ppsx](https://example.edu/courses/101/lecture-01.ppsx)",
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
| `title` | string | Recommended | Deck title displayed in the header and browser tab. Falls back to the filename (with `.ppsx.pdf` / `.pptx.pdf` / `.pdf` stripped). |
| `audio` | string | No | Attachment filename in `/EmbeddedFiles` (e.g. `"audio.opus"`, `"track.mp3"`). Omit (or leave empty) for **viewer-only** mode. |
| `audioMime` | string | No | Optional explicit MIME type override (e.g. `"audio/ogg"` or `"audio/mpeg"`). When omitted, `pdfstage` infers the MIME type from the filename extension, magic bytes, or browser sniffing. |
| `duration` | number | Recommended with `audio` | Total audio duration in seconds. If omitted or `<= 0`, the player falls back to the decoded `<audio>` element's `duration` once metadata loads. |
| `starts` | number[] | When `audio` is set | Slide start timestamps in seconds. Index `i` maps to 1-based PDF page `i + 1`. |
| `titles` | string[] | Recommended | Chapter label per slide (index `i` maps to PDF page `i + 1`). Labels longer than 68 characters are truncated by the player; missing entries fall back to `"Folie <n>"`. Full slide body text is intentionally omitted since `Ctrl+F` uses the PDF text layer directly. |
| `provenance` | object | No | Optional source and conversion metadata for reproducibility and auditing (ignored at runtime). |

#### `provenance` Object Fields

All fields inside `provenance` are optional:

| Field | Type | Description |
| :--- | :--- | :--- |
| `sourceUrl` | string | Origin URL of the source presentation, if fetched remotely. |
| `sha256` | string | Lowercase hex SHA-256 digest of the original source file. |
| `bytes` | integer | File size of the original source file in bytes. |
| `convertedAt` | string | Conversion timestamp in RFC 3339 / ISO 8601 UTC format. |
| `hiddenIncluded` | boolean | Whether hidden slides from the source deck were included in the PDF. |
| `silentSeconds` | number | Synthetic duration (in seconds) assigned to slides without recorded narration. |
| `tailSilence` | number | Trailing silence padding (in seconds) appended after narration segments. |

---

### 3. Audio Format & Synchronization Invariants

- **Audio Formats:** Any audio container/codec supported by the browser's `<audio>` element works. **Ogg Opus** (`.opus`) is recommended for voice recordings due to its small size and broad desktop/mobile browser support (note that older Safari builds may require `.m4a`/AAC or `.mp3` if Ogg Opus is unavailable).
- **MIME Resolution Order:** Explicit `audioMime` in `ppsx.json` → filename extension (`.opus`/`.ogg`/`.oga`, `.mp3`, `.m4a`/`.mp4`, `.wav`, `.webm`/`.weba`, `.flac`, `.aac`) → header magic bytes → untyped `Blob` fallback.
- **1:1 Page Mapping:** `starts.length` (when audio is present) and `titles.length` should match the PDF page count. Index `0` corresponds to PDF page `1`.
- **Monotonic Timestamps:** Values in `starts` must be non-decreasing (`starts[0] <= starts[1] <= ... <= duration`), with `starts[0]` typically `0`.
- **Active Slide Resolution:** For playback position `t`, the player selects the highest index `i` where `t >= starts[i] - 0.05` (50 ms boundary tolerance), defaulting to `0`. Jumping to slide `i` seeks to `starts[i] + 0.001`.
- **Viewer-Only Fallback:** If `ppsx.json` is absent, `audio` is omitted, or the referenced attachment is missing/empty, `pdfstage` switches to viewer-only mode (slide navigation, chapter tooltips if `titles` exist, and full-text search).

---

## Building & Inspecting Compatible PDFs

For quick prototyping or inspection, [`pdfcpu`](https://pdfcpu.io/) can attach and extract embedded files:

```bash
# Attach manifest and audio to an existing PDF
pdfcpu attachments add deck.pdf ppsx.json audio.opus

# List embedded files
pdfcpu attachments list deck.pdf

# Extract embedded files for inspection
pdfcpu attachments extract deck.pdf ./extracted/
```

*(Note: Generic CLI tools may compress all attachments with `/FlateDecode` by default. For production pipelines with large decks, writing a minimal PDF incremental update keeps compressed audio streams raw while compressing `ppsx.json` with `/FlateDecode`.)*

---

## License

Licensed under the [Apache License 2.0](./LICENSE).

Bundles [PDF.js](https://mozilla.github.io/pdf.js/) `3.11.174` (Copyright Mozilla Foundation, Apache License 2.0).
