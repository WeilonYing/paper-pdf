#!/usr/bin/env python3
"""Pack pdf.js's CMap and standard-font data into one JavaScript file.

pdf.js ships these as ~185 loose files that it fetches at runtime. That's
185 files in the repo to carry around, and it doesn't work at all when
index.html is opened straight from disk, because a file:// page can't
fetch its own siblings.

So we pack the lot into a single gzipped, base64'd script and hand pdf.js
factories that read from it. It's loaded lazily — only when a document
actually asks for a CMap or a standard font, which most never do.

Source order:
  1. a pdfjs-dist tarball or extracted directory passed as an argument
  2. vendor/cmaps and vendor/standard_fonts, if they're still present

Usage:
    python3 tools/build-pdfjs-data.py                    # from vendor/
    python3 tools/build-pdfjs-data.py pdfjs-dist-3.11.174.tgz
    python3 tools/build-pdfjs-data.py path/to/pdfjs-dist/
"""
import base64
import gzip
import json
import os
import sys
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "vendor")
OUT = os.path.join(VENDOR, "pdfjs-data.js")

WANTED = ("cmaps", "standard_fonts")


def collect_from_tarball(path):
    files = {}
    with tarfile.open(path) as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            parts = member.name.split("/")           # package/cmaps/Foo.bcmap
            if len(parts) < 3 or parts[1] not in WANTED:
                continue
            name = parts[1] + "/" + "/".join(parts[2:])
            if os.path.basename(name).startswith("LICENSE"):
                continue
            files[name] = tf.extractfile(member).read()
    return files


def collect_from_dir(base):
    files = {}
    for d in WANTED:
        src = os.path.join(base, d)
        if not os.path.isdir(src):
            continue
        for name in sorted(os.listdir(src)):
            path = os.path.join(src, name)
            if not os.path.isfile(path) or name.startswith("LICENSE"):
                continue
            with open(path, "rb") as f:
                files[d + "/" + name] = f.read()
    return files


def main():
    if len(sys.argv) > 1:
        src = sys.argv[1]
        files = collect_from_tarball(src) if src.endswith((".tgz", ".tar.gz")) \
            else collect_from_dir(src)
    else:
        files = collect_from_dir(VENDOR)

    if not files:
        sys.exit("no CMap or standard-font data found — pass a pdfjs-dist "
                 "tarball or directory, e.g.\n"
                 "  npm pack pdfjs-dist@3.11.174 && python3 tools/build-pdfjs-data.py pdfjs-dist-3.11.174.tgz")

    blob = bytearray()
    index = {}
    for name in sorted(files):
        data = files[name]
        index[name] = [len(blob), len(data)]
        blob.extend(data)

    packed = gzip.compress(bytes(blob), 9)
    b64 = base64.b64encode(packed).decode("ascii")
    lines = [b64[i:i + 120] for i in range(0, len(b64), 120)]

    js = """/* pdfjs-data.js — GENERATED, do not edit.
 *
 * pdf.js CMap and standard-font data, packed into one file instead of
 * the ~185 loose files pdf.js normally fetches at runtime. Loaded lazily
 * by js/app.js, and only for documents that actually need it — which
 * means predefined CJK CMaps, and Symbol / ZapfDingbats.
 *
 * Packing it this way is also what lets the app work when index.html is
 * opened directly from disk, where fetch() of sibling files is blocked.
 *
 * Regenerate: python3 tools/build-pdfjs-data.py [pdfjs-dist tarball]
 * Licences:   vendor/LICENSE-cmaps, LICENSE-foxit-fonts, LICENSE-liberation-fonts
 *
 * %d files, %s raw, %s packed.
 */
window.PdfjsData = {
  index: %s,
  data:
  %s
};
""" % (
        len(index), human(len(blob)), human(len(packed)),
        json.dumps(index, separators=(",", ":")),
        "'" + "' +\n  '".join(lines) + "'",
    )

    with open(OUT, "w") as f:
        f.write(js)

    print("wrote %s" % os.path.relpath(OUT, ROOT))
    print("  %d files, %s raw -> %s packed -> %s on disk"
          % (len(index), human(len(blob)), human(len(packed)), human(len(js))))


def human(n):
    n = float(n)
    for unit in ("B", "KB", "MB"):
        if n < 1024 or unit == "MB":
            return "%d B" % n if unit == "B" else "%.1f %s" % (n, unit)
        n /= 1024.0


if __name__ == "__main__":
    main()
