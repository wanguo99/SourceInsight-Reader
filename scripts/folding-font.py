"""Generate the two original box +/- glyphs used by the product icon theme.

Development only: python3 scripts/folding-font.py (requires fontTools).
The extension ships the generated WOFF and needs no Python installation.
"""
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

font = FontBuilder(1000, isTTF=True)
font.setupGlyphOrder(['.notdef', 'expanded', 'collapsed'])
font.setupCharacterMap({0xE001: 'expanded', 0xE002: 'collapsed'})
glyphs = {}
for name in ['.notdef', 'expanded', 'collapsed']:
    pen = TTGlyphPen(None)
    def rectangle(x, y, width, height):
        pen.moveTo((x, y))
        pen.lineTo((x + width, y))
        pen.lineTo((x + width, y + height))
        pen.lineTo((x, y + height))
        pen.closePath()
    if name != '.notdef':
        for box in [(125, 75, 750, 65), (125, 760, 750, 65), (125, 140, 65, 620), (810, 140, 65, 620), (300, 415, 400, 70)]:
            rectangle(*box)
        if name == 'collapsed':
            rectangle(465, 250, 70, 165)
            rectangle(465, 485, 70, 165)
    glyphs[name] = pen.glyph()
font.setupGlyf(glyphs)
font.setupHorizontalMetrics({name: (1000, 0) for name in glyphs})
font.setupHorizontalHeader(ascent=900, descent=-100)
font.setupNameTable({'familyName': 'SourceInsight Folding', 'styleName': 'Regular', 'uniqueFontIdentifier': 'SourceInsightFolding-Regular', 'fullName': 'SourceInsight Folding Regular', 'psName': 'SourceInsightFolding-Regular', 'version': 'Version 1.0'})
font.setupOS2(sTypoAscender=900, sTypoDescender=-100, usWinAscent=900, usWinDescent=100)
font.setupPost()
font.font['head'].created = font.font['head'].modified = 3800000000
font.font.flavor = 'woff'
font.save(Path(__file__).resolve().parents[1] / 'themes' / 'sourceinsight-folding.woff')
