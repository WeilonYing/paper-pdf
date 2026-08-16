# Vendored libraries

Checked in rather than installed, so the site is a plain static directory with no build step.

| File | Library | Version | Licence |
| --- | --- | --- | --- |
| `pdf.min.js`, `pdf.worker.min.js` | [pdf.js](https://github.com/mozilla/pdf.js) | 3.11.174 | Apache-2.0 — `LICENSE-pdf.js` |
| `pdf-lib.min.js` | [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT — `LICENSE-pdf-lib.md` |
| `fontkit.umd.min.js` | [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) | 1.1.1 | MIT |
| `pdfjs-data.js` | pdf.js CMap + standard-font data | 3.11.174 | `LICENSE-cmaps`, `LICENSE-foxit-fonts`, `LICENSE-liberation-fonts` |

## pdfjs-data.js

pdf.js ships its CMap and standard-font data as loose files that it fetches at runtime. Carrying
185 files in the repo for data almost nothing reads is a poor trade, and fetching doesn't work at all
when `index.html` is opened directly from disk — a `file://` page can't fetch its own siblings.

So they're packed into one generated file (1.9 MB, gzipped and base64'd) which `js/app.js` loads
**lazily**, via pdf.js's `CMapReaderFactory` and `StandardFontDataFactory` hooks. Most documents never
trigger it: embedded fonts need no CMap data, and the standard 14 are substituted from system fonts.
What does need it is predefined CJK CMaps — an Adobe-Japan1 document with a non-embedded font renders
blank without it.

Regenerate after upgrading pdf.js:

```bash
npm pack pdfjs-dist@<version>
python3 tools/build-pdfjs-data.py pdfjs-dist-<version>.tgz
```

## Upgrading

```bash
npm pack pdfjs-dist@<version> pdf-lib@<version> @pdf-lib/fontkit@<version>
```

Copy `build/pdf.min.js` and `build/pdf.worker.min.js` from pdfjs-dist, `dist/pdf-lib.min.js` from
pdf-lib, and `dist/fontkit.umd.min.js` from fontkit — then rebuild `pdfjs-data.js` as above.

pdf.js 4.x moved to ES modules and drops the `pdfjsLib` UMD global, so going past 3.x needs changes in
`index.html` and `js/app.js`. Run `npm test` either way.
