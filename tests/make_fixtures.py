#!/usr/bin/env python3
"""Build a corpus of PDFs that exercise the editor's hard cases."""
import os, subprocess, textwrap
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import LETTER
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_JUSTIFY

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
os.makedirs(OUT, exist_ok=True)
W, H = LETTER

LOREM = ("The quick brown fox jumps over the lazy dog while the parliament of owls "
         "deliberates the merits of nocturnal governance. Committee findings were "
         "inconclusive, and a second session was scheduled for the following equinox.")


def p(name):
    return os.path.join(OUT, name)


# ---------------------------------------------------------------- 1. plain
def simple():
    c = canvas.Canvas(p("simple.pdf"), pagesize=LETTER)
    c.setFont("Helvetica-Bold", 22)
    c.drawString(72, H - 90, "Quarterly Report")
    c.setFont("Helvetica", 11)
    c.drawString(72, H - 118, "Prepared by the Office of Unremarkable Findings")
    c.setFont("Helvetica", 11)
    y = H - 160
    for line in textwrap.wrap(LOREM, 78):
        c.drawString(72, y, line)
        y -= 15
    c.setFont("Times-Roman", 12)
    c.drawString(72, y - 24, "A single line set in Times Roman.")
    c.setFont("Courier", 10)
    c.drawString(72, y - 44, "monospaced_value = 42")
    # right-aligned and centred lines, to test alignment detection
    c.setFont("Helvetica", 10)
    c.drawRightString(W - 72, 90, "Page 1 of 1")
    c.drawCentredString(W / 2, 70, "Centred footer text")
    c.save()


# ------------------------------------------------- 2. embedded subset font
def embedded():
    pdfmetrics.registerFont(TTFont("Poppins", "/usr/share/fonts/truetype/google-fonts/Poppins-Regular.ttf"))
    pdfmetrics.registerFont(TTFont("PoppinsB", "/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf"))
    c = canvas.Canvas(p("embedded.pdf"), pagesize=LETTER)
    c.setFont("PoppinsB", 20)
    c.drawString(72, H - 90, "Embedded Subset Heading")
    c.setFont("Poppins", 11)
    y = H - 130
    for line in textwrap.wrap(LOREM, 74):
        c.drawString(72, y, line)
        y -= 16
    c.setFont("Poppins", 11)
    c.drawString(72, y - 20, "Accents: café, naïve, Zürich — em dash and quotes “like this”.")
    c.save()


# --------------------------------------- 3. text over gradient / shading
def gradient():
    c = canvas.Canvas(p("gradient.pdf"), pagesize=LETTER)
    c.linearGradient(0, H - 260, W, H - 60,
                     (colors.HexColor("#1e3a8a"), colors.HexColor("#9333ea"), colors.HexColor("#f59e0b")),
                     positions=[0, 0.5, 1], extend=True)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 30)
    c.drawString(60, H - 150, "Text On A Gradient")
    c.setFont("Helvetica", 13)
    c.drawString(60, H - 180, "A white patch here would be obvious immediately.")

    # a shaded table
    c.setFillColor(colors.HexColor("#e0e7ff"))
    c.rect(60, H - 420, W - 120, 110, stroke=0, fill=1)
    c.setFillColor(colors.HexColor("#c7d2fe"))
    c.rect(60, H - 350, W - 120, 40, stroke=0, fill=1)
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(74, H - 336, "Region")
    c.drawString(240, H - 336, "Revenue")
    c.drawString(400, H - 336, "Change")
    c.setFont("Helvetica", 12)
    c.drawString(74, H - 372, "Northern Territories")
    c.drawString(240, H - 372, "412,900")
    c.drawString(400, H - 372, "+3.1%")
    c.drawString(74, H - 398, "Coastal Districts")
    c.drawString(240, H - 398, "298,144")
    c.drawString(400, H - 398, "-1.4%")

    # rotated text
    c.saveState()
    c.translate(90, 200)
    c.rotate(38)
    c.setFont("Helvetica-Bold", 18)
    c.setFillColor(colors.HexColor("#b91c1c"))
    c.drawString(0, 0, "ROTATED DRAFT STAMP")
    c.restoreState()
    c.save()


# ------------------------------------------------- 4. justified paragraphs
def flowing():
    doc = SimpleDocTemplate(p("flowing.pdf"), pagesize=LETTER,
                            leftMargin=72, rightMargin=72, topMargin=72, bottomMargin=72)
    ss = getSampleStyleSheet()
    just = ParagraphStyle("just", parent=ss["BodyText"], alignment=TA_JUSTIFY,
                          fontName="Times-Roman", fontSize=11, leading=15.5, spaceAfter=11)
    story = [Paragraph("On the Governance of Owls", ss["Title"]), Spacer(1, 8)]
    body = (LOREM + " ") * 3
    for _ in range(4):
        story.append(Paragraph(body, just))
    data = [["Item", "Qty", "Unit"], ["Perches", "14", "9.50"], ["Hoods", "3", "22.00"]]
    t = Table(data, colWidths=[220, 60, 60])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#d1fae5")),
        ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#f0fdf4")),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ]))
    story += [Spacer(1, 12), t]
    doc.build(story)


# ------------------------------------------------------------- 5. AcroForm
def form():
    c = canvas.Canvas(p("form.pdf"), pagesize=LETTER)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(72, H - 80, "Membership Application")
    c.setFont("Helvetica", 11)
    c.drawString(72, H - 130, "Full name")
    c.acroForm.textfield(name="fullName", tooltip="Full name", x=170, y=H - 136,
                         width=260, height=20, borderWidth=1, forceBorder=True, value="")
    c.drawString(72, H - 170, "Email")
    c.acroForm.textfield(name="email", tooltip="Email", x=170, y=H - 176,
                         width=260, height=20, borderWidth=1, forceBorder=True, value="")
    c.drawString(72, H - 210, "Subscribe")
    c.acroForm.checkbox(name="subscribe", x=170, y=H - 214, size=16, borderWidth=1, forceBorder=True)
    c.save()


# --------------------------------------------------------------- 6. LaTeX
def latex():
    tex = r"""
\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{iftex}
\ifXeTeX\usepackage{fontspec}\setmainfont{TeX Gyre Termes}\else\usepackage[T1]{fontenc}\fi
\begin{document}
\section*{A Study of Nocturnal Committees}
The quick brown fox jumps over the lazy dog while the parliament of owls
deliberates the merits of nocturnal governance. Committee findings were
inconclusive, and a second session was scheduled for the following equinox.
Members expressed concern that the perches were inadequately maintained.

\subsection*{Recommendations}
We recommend the immediate procurement of fourteen replacement perches and a
review of the hood inventory. The expenditure is modest relative to the
reputational cost of a collapsed perch during open session.
\end{document}
"""
    d = os.path.join(OUT, "_tex")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "doc.tex"), "w") as f:
        f.write(tex)
    # xelatex embeds the OpenType Latin Modern as a CID font (the common
    # modern case); pdflatex without Type1 CM falls back to Type 3 bitmap
    # fonts, which is its own worthwhile edge case.
    subprocess.run(["xelatex", "-interaction=nonstopmode", "-output-directory", d, "doc.tex"],
                   check=False, capture_output=True)
    if os.path.exists(os.path.join(d, "doc.pdf")):
        os.replace(os.path.join(d, "doc.pdf"), p("latex.pdf"))
    for junk in ("doc.aux", "doc.log", "doc.pdf"):
        try: os.remove(os.path.join(d, junk))
        except OSError: pass
    subprocess.run(["pdflatex", "-interaction=nonstopmode", "-output-directory", d, "doc.tex"],
                   check=False, capture_output=True)
    if os.path.exists(os.path.join(d, "doc.pdf")):
        os.replace(os.path.join(d, "doc.pdf"), p("type3.pdf"))


# ------------------------------------------------------------------ 7. CJK
def cjk():
    try:
        pdfmetrics.registerFont(TTFont("NotoJP", "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf"))
    except Exception as e:
        print("skip cjk:", e)
        return
    c = canvas.Canvas(p("cjk.pdf"), pagesize=LETTER)
    c.setFont("NotoJP", 18)
    c.drawString(72, H - 100, "日本語のテキスト編集")
    c.setFont("NotoJP", 12)
    c.drawString(72, H - 140, "これはテスト文書です。フォントは埋め込まれています。")
    c.setFont("Helvetica", 12)
    c.drawString(72, H - 180, "Mixed with Latin text on the same page.")
    c.save()


# ------------------------------- 7b. predefined CMap, non-embedded CJK font
def cmap_predefined():
    """Adobe-Japan1 with UniJIS-UCS2-H — the only case that needs pdf.js's
    CMap data at runtime. Renders as a blank page without it."""
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    try:
        pdfmetrics.registerFont(UnicodeCIDFont("HeiseiMin-W3"))
    except Exception as e:
        print("skip cmap-predefined:", e)
        return
    c = canvas.Canvas(p("cmap-predefined.pdf"), pagesize=LETTER)
    c.setFont("HeiseiMin-W3", 20)
    c.drawString(72, H - 100, "予定義シーマップのテスト")
    c.setFont("HeiseiMin-W3", 12)
    c.drawString(72, H - 140, "このフォントは埋め込まれていません。")
    c.setFont("Helvetica", 12)
    c.drawString(72, H - 180, "Latin text alongside it.")
    c.save()


# ------------------------------------------------- 8. stamp image for tests
def stamp():
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", (240, 180), (255, 255, 255, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([10, 10, 230, 170], outline=(200, 30, 30, 255), width=8)
    d.text((70, 80), "APPROVED", fill=(200, 30, 30, 255))
    im.save(os.path.join(OUT, "..", "stamp.png"))


# --------------------------------- 9. large doc + scan with an OCR layer
def perf_fixtures():
    try:
        import pymupdf
    except ImportError:
        print("skip big.pdf / scanned.pdf: pymupdf not installed")
        return

    src = pymupdf.open(p("flowing.pdf"))
    big = pymupdf.open()
    for _ in range(100):
        big.insert_pdf(src)
    big.save(p("big.pdf"))

    # rasterise a page, then lay render-mode-3 (invisible) text over the
    # image — exactly what an OCR'd scan looks like
    d = pymupdf.open(p("simple.pdf"))
    pix = d[0].get_pixmap(dpi=150)
    out = pymupdf.open()
    pg = out.new_page(width=612, height=792)
    pg.insert_image(pymupdf.Rect(0, 0, 612, 792), pixmap=pix)
    tw = pymupdf.TextWriter(pg.rect)
    for x0, y0, x1, y1, word, *_ in d[0].get_text("words"):
        try:
            tw.append(pymupdf.Point(x0, y1), word, fontsize=max(4, (y1 - y0) * 0.85))
        except Exception:
            pass
    tw.write_text(pg, render_mode=3)
    out.save(p("scanned.pdf"))


def cleanup():
    import shutil
    shutil.rmtree(os.path.join(OUT, "_tex"), ignore_errors=True)


if __name__ == "__main__":
    simple(); embedded(); gradient(); flowing(); form(); latex(); cjk()
    cmap_predefined()
    stamp(); perf_fixtures(); cleanup()
    for f in sorted(os.listdir(OUT)):
        if f.endswith(".pdf"):
            print(f, os.path.getsize(p(f)), "bytes")
