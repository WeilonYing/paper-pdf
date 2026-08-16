# Tests

Three suites, all driving the real editor in headless Chromium against generated PDFs. They are not
required to run or deploy the app — the app has no build step and no runtime dependencies beyond
what's vendored.

| Suite | What it covers |
| --- | --- |
| `run.js` | The engine, via the `window.Paper` scripting API. 65 assertions across eight fixture PDFs: font reuse, operator removal, wrapping, justification, CID and Type 3 fonts, forms, shapes, undo, and `qpdf --check` on every output. |
| `interact.js` | The UI, via real mouse and keyboard events. 28 assertions: placing and editing text boxes, surviving a preview rebuild mid-type, click-vs-drag disambiguation, discarding empty boxes, and drawing shapes by hand. |
| `offline.js` | The app loaded from `file://`, where a worker can't be spawned from a file URL and sibling files can't be fetched. 10 assertions: it boots, pages actually paint, predefined CJK CMaps resolve from the packed data, and an edit round-trips. |
| `perf.js` | Open and build timings on a 100-page document and a 6 MB scan. Not pass/fail; it prints numbers. |

The split matters. `run.js` never touches the DOM, so it cannot catch UI-layer bugs — a race where
the debounced preview rebuild destroyed the textarea the user was typing into passed all 65 engine
assertions. `interact.js` exists to catch that class of problem, and `offline.js` covers a third
mode that looks fine in both of the others because everything still works over HTTP.

`offline.js` deliberately does *not* pass Chrome's `--allow-file-access-from-files`; with that flag
it would pass for the wrong reason.

## Running them

```bash
npm install                 # playwright
npx playwright install chromium
npm run fixtures            # generate the test PDFs (see deps below)
npm test
```

`CHROMIUM_PATH=/path/to/chrome` overrides the browser if you have your own build.

## Fixture dependencies

`make_fixtures.py` builds the corpus from scratch. It needs:

- `reportlab` — most of the PDFs
- `pymupdf` — the 100-page document, the simulated scan, and text extraction during verification
- `xelatex` and `pdflatex` — `latex.pdf` (CID fonts) and `type3.pdf` (TeX bitmap fonts)
- `Pillow` — the stamp image
- `qpdf` — structural validation of every output

```bash
pip install reportlab pymupdf pillow
```

Anything missing is skipped with a message rather than failing the run, so a partial toolchain still
gets you most of the corpus.

## The corpus

| Fixture | Why it's here |
| --- | --- |
| `simple.pdf` | Standard 14 fonts, not embedded. Ragged-right paragraphs, centred and right-aligned footers. |
| `embedded.pdf` | Subset TrueType (Poppins). The pixel-perfect font-reuse path, plus accented characters. |
| `gradient.pdf` | Text over a gradient, over shaded table cells, and rotated 38°. The cases whiteout destroys. |
| `flowing.pdf` | Justified multi-paragraph body text and a table. Tests re-wrapping and alignment detection. |
| `latex.pdf` | xelatex output: CID fonts, Identity-H, word spacing driven by `TJ` adjustments. |
| `type3.pdf` | pdflatex bitmap fonts with a custom `FontMatrix` — where widths are *not* per-1000. |
| `cjk.pdf` | Japanese in a subset font. Tests reuse for scripts outside Latin-1, and correct refusal when the subset lacks a glyph. |
| `cmap-predefined.pdf` | Adobe-Japan1 with `UniJIS-UCS2-H` and no embedded font — the only case that needs pdf.js's CMap data at runtime. Renders blank without it. |
| `form.pdf` | AcroForm text fields and a checkbox. |
| `big.pdf` | 100 pages, for lazy-analysis and rendering behaviour. |
| `scanned.pdf` | A rasterised page with an invisible render-mode-3 OCR layer. |

Outputs land in `tests/out/` for inspection — every edited PDF the suite produces is kept, so you can
open them and look.
