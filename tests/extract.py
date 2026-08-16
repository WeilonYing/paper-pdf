import sys, pymupdf
d = pymupdf.open(sys.argv[1])
out = []
for pg in d:
    out.append(pg.get_text())
sys.stdout.write("\n".join(out))
