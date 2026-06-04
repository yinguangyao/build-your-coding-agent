#!/usr/bin/env python3
"""
Convert Markdown to WeChat-ready HTML in mdnice 蔷薇紫 (rose purple) theme.

Usage:
    python3 convert.py input.md
    python3 convert.py input.md -o output.html
    python3 convert.py input.md --color "#ff6b35"   # 换主题色

Output is HTML with inline styles, ready to paste into WeChat 公众号 editor.
Zero external dependencies (stdlib only).
"""
import argparse
import re
import sys
from pathlib import Path


# =====================================================================
# Style constants — change these to customize the theme
# =====================================================================
PRIMARY = "#8064a2"           # 蔷薇紫主色
PRIMARY_DARK = "#4a3a5c"      # 紫色引用块文字
TEXT = "#3f3f3f"              # 正文颜色
TEXT_DARK = "#1a1a1a"         # 标题、强调黑色
TEXT_MUTED = "#888888"
BG_GRAY = "#f7f7f7"           # 引用块背景
BG_CODE_INLINE = "#f4f4f5"    # 行内代码背景
BORDER_GRAY = "#cccccc"
BORDER_LIGHT = "#dddddd"
CODE_BG = "#282c34"           # 代码块 (Atom One Dark)
CODE_BAR = "#21252b"          # 代码块顶部工具栏
CODE_TEXT = "#abb2bf"
CODE_BORDER = "#181a1f"

# Atom One Dark syntax colors (used when --highlight)
SYN_KEYWORD = "#c678dd"       # 紫
SYN_FUNCTION = "#61afef"      # 蓝
SYN_TYPE = "#e5c07b"          # 黄
SYN_STRING = "#98c379"        # 绿
SYN_COMMENT = "#5c6370"       # 灰
SYN_ERROR = "#e06c75"         # 红

FONT_BODY = ("Optima-Regular, Optima, PingFangSC-light, PingFangTC-light, "
             "'PingFang SC', Cambria, Cochin, Georgia, Times, 'Times New Roman', serif")
FONT_MONO = "Menlo, Monaco, Consolas, monospace"

# Body wrapper style
WRAPPER_STYLE = (
    f"font-family: {FONT_BODY}; font-size: 16px; line-height: 1.75; "
    f"color: {TEXT}; letter-spacing: 0.05em; word-break: break-word;"
)


# =====================================================================
# Style helpers
# =====================================================================
def inline_code_style():
    return (f"background: {BG_CODE_INLINE}; color: {TEXT}; padding: 2px 6px; "
            f"border-radius: 3px; font-family: {FONT_MONO}; font-size: 14px;")


def strong_style():
    return f"color: {PRIMARY};"


def h1_style():
    return (f"font-size: 22px; font-weight: bold; color: {TEXT_DARK}; "
            f"text-align: center; margin: 0 auto 24px auto; line-height: 1.4; "
            f"padding-bottom: 6px; border-bottom: 2px solid {PRIMARY}; display: table;")


def h2_style():
    return (f"font-size: 20px; font-weight: bold; color: {TEXT_DARK}; "
            f"margin: 40px 0 20px 0; line-height: 1.4; "
            f"padding-left: 14px; border-left: 4px solid {PRIMARY};")


def h3_style():
    return (f"font-size: 17px; font-weight: bold; color: {TEXT_DARK}; "
            f"text-align: center; margin: 32px auto 16px auto; line-height: 1.4; "
            f"padding-bottom: 4px; border-bottom: 1.5px solid {PRIMARY}; display: table;")


def h4_style():
    return f"font-size: 16px; font-weight: bold; color: {TEXT_DARK}; margin: 24px 0 12px 0;"


def paragraph_style():
    return "margin: 0 0 16px 0;"


def blockquote_style(emphasis=False):
    border = PRIMARY if emphasis else BORDER_GRAY
    color = PRIMARY_DARK if emphasis else "#555"
    return (f"background: {BG_GRAY}; border-left: 4px solid {border}; "
            f"padding: 12px 16px; margin: 0 0 16px 0; color: {color}; line-height: 1.75;")


def ul_style():
    return "margin: 0 0 16px 0; padding-left: 28px; list-style-type: disc;"


def ol_style():
    return "margin: 0 0 16px 0; padding-left: 28px;"


def li_style():
    return "margin: 6px 0; line-height: 1.75;"


def link_style():
    return f"color: {PRIMARY}; text-decoration: underline;"


def hr_html():
    return ('<section style="text-align: center; margin: 28px 0;">'
            f'<span style="display: inline-block; width: 60px; height: 1px; '
            f'background: {BORDER_LIGHT};"></span></section>')


def image_html(alt, src):
    alt_esc = html_escape(alt)
    return (f'<section style="text-align: center; margin: 16px 0;">'
            f'<img src="{src}" alt="{alt_esc}" '
            f'style="max-width: 100%; height: auto; border-radius: 4px;" />'
            f'</section>')


def code_block_html(code, lang=""):
    """Render a fenced code block with Atom One Dark + macOS title bar."""
    body = html_escape(code)
    # Try light syntax highlighting for common cases
    body = lite_highlight(body, lang)
    return (
        f'<section style="background: {CODE_BG}; border-radius: 6px; padding: 0; '
        f'margin: 0 0 16px 0; overflow: hidden;">'
        f'<section style="background: {CODE_BAR}; padding: 8px 12px; '
        f'border-bottom: 1px solid {CODE_BORDER};">'
        '<span style="display: inline-block; width: 12px; height: 12px; '
        'border-radius: 50%; background: #ff5f56; margin-right: 6px; '
        'vertical-align: middle;"></span>'
        '<span style="display: inline-block; width: 12px; height: 12px; '
        'border-radius: 50%; background: #ffbd2e; margin-right: 6px; '
        'vertical-align: middle;"></span>'
        '<span style="display: inline-block; width: 12px; height: 12px; '
        'border-radius: 50%; background: #27c93f; vertical-align: middle;"></span>'
        '</section>'
        f'<section style="padding: 14px 16px; font-family: {FONT_MONO}; '
        f'font-size: 13px; line-height: 1.7; color: {CODE_TEXT}; '
        f'overflow-x: auto;">'
        f'<p style="margin: 0; white-space: pre;">{body}</p>'
        '</section>'
        '</section>'
    )


# =====================================================================
# Lightweight syntax highlighting
# =====================================================================
def lite_highlight(escaped_code, lang):
    """Apply rough syntax highlighting to common languages. Input is HTML-escaped."""
    if not lang:
        return escaped_code

    lang = lang.lower()

    # Strings (greedy match, all langs)
    def color_strings(text):
        # Double-quoted strings
        text = re.sub(
            r'(&quot;[^&]*?&quot;)',
            lambda m: f'<span style="color: {SYN_STRING};">{m.group(1)}</span>',
            text)
        # Single-quoted strings
        text = re.sub(
            r"('[^'\n]*?')",
            lambda m: f'<span style="color: {SYN_STRING};">{m.group(1)}</span>',
            text)
        return text

    # Comments (#-style or //-style)
    def color_line_comments(text, marker):
        return re.sub(
            f'({re.escape(marker)}[^\n]*)',
            lambda m: f'<span style="color: {SYN_COMMENT};">{m.group(1)}</span>',
            text)

    # Keywords (highlight as primary purple)
    def color_keywords(text, keywords):
        for kw in keywords:
            text = re.sub(
                r'\b(' + re.escape(kw) + r')\b',
                lambda m: f'<span style="color: {SYN_KEYWORD};">{m.group(1)}</span>',
                text)
        return text

    # Common keyword lists
    if lang in ('python', 'py'):
        kws = ['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'return',
               'import', 'from', 'as', 'try', 'except', 'finally', 'with',
               'lambda', 'and', 'or', 'not', 'in', 'is', 'None', 'True', 'False',
               'pass', 'break', 'continue', 'yield', 'raise', 'async', 'await']
        out = color_strings(escaped_code)
        out = color_line_comments(out, '#')
        out = color_keywords(out, kws)
        return out

    if lang in ('javascript', 'js', 'typescript', 'ts'):
        kws = ['const', 'let', 'var', 'function', 'return', 'if', 'else',
               'for', 'while', 'class', 'new', 'this', 'import', 'export',
               'from', 'async', 'await', 'try', 'catch', 'finally', 'throw',
               'typeof', 'instanceof', 'true', 'false', 'null', 'undefined']
        out = color_strings(escaped_code)
        out = color_line_comments(out, '//')
        out = color_keywords(out, kws)
        return out

    if lang in ('rust', 'rs'):
        kws = ['fn', 'let', 'mut', 'pub', 'struct', 'enum', 'impl', 'trait',
               'use', 'mod', 'match', 'if', 'else', 'for', 'while', 'loop',
               'return', 'self', 'Self', 'true', 'false', 'unsafe', 'async', 'await']
        out = color_strings(escaped_code)
        out = color_line_comments(out, '//')
        out = color_keywords(out, kws)
        return out

    if lang in ('go',):
        kws = ['func', 'var', 'const', 'type', 'struct', 'interface', 'package',
               'import', 'if', 'else', 'for', 'range', 'return', 'go', 'defer',
               'chan', 'map', 'true', 'false', 'nil', 'select', 'switch', 'case']
        out = color_strings(escaped_code)
        out = color_line_comments(out, '//')
        out = color_keywords(out, kws)
        return out

    if lang in ('zero', '0'):
        kws = ['pub', 'fun', 'raises', 'check', 'rescue', 'let', 'var',
               'shape', 'choice', 'enum', 'match', 'owned', 'drop', 'defer',
               'return', 'if', 'else', 'for', 'while', 'true', 'false']
        out = color_strings(escaped_code)
        out = color_line_comments(out, '//')
        out = color_keywords(out, kws)
        return out

    if lang in ('bash', 'sh', 'shell'):
        out = color_strings(escaped_code)
        out = color_line_comments(out, '#')
        return out

    if lang == 'json':
        return color_strings(escaped_code)

    # Unknown language → just escape, no highlight
    return escaped_code


# =====================================================================
# HTML escaping
# =====================================================================
def html_escape(s):
    return (s.replace('&', '&amp;')
             .replace('<', '&lt;')
             .replace('>', '&gt;'))


# =====================================================================
# Chinese punctuation normalization
# =====================================================================
# Default ON: when half-width ASCII punctuation appears adjacent to a Chinese
# character, convert it to its full-width Chinese counterpart. Disabled by
# --no-punct CLI flag. Code blocks and inline code are NOT touched (they're
# saved as placeholders before render_inline runs this step).
NORMALIZE_PUNCT = True

# CJK Unified Ideographs only (U+4E00 ~ U+9FFF). Deliberately exclude
# fullwidth punctuation like 「，」「。」, otherwise the rule "ASCII punct
# adjacent to Chinese" would chain-match across already-converted output and
# corrupt markdown syntax like `](url),` → `](url）,`.
CN_CHAR = r'[一-鿿]'

# Mapping for simple punctuation marks
_PUNCT_MAP = {
    ',': '，',
    ':': '：',
    ';': '；',
    '?': '？',
    '!': '！',
}


def normalize_punctuation(text):
    """Replace half-width ASCII punctuation with Chinese full-width equivalents
    when adjacent to a Chinese character. Idempotent.
    """
    if not NORMALIZE_PUNCT:
        return text

    # Single-char punctuation: comma, colon, semicolon, question, exclamation
    for half, full in _PUNCT_MAP.items():
        h = re.escape(half)
        # repeat until stable: handle 中,中,中 → 中，中，中 across multiple passes
        prev = None
        while prev != text:
            prev = text
            # Chinese on left
            text = re.sub(f'({CN_CHAR}){h}', f'\\1{full}', text)
            # Chinese on right
            text = re.sub(f'{h}({CN_CHAR})', f'{full}\\1', text)

    # Parentheses: convert when Chinese is on outer side, or when inside is
    # all-Chinese (typical case "(显式能力)" → "（显式能力）").
    prev = None
    while prev != text:
        prev = text
        # 中( → 中（
        text = re.sub(f'({CN_CHAR})\\(', r'\1（', text)
        # )中 → ）中
        text = re.sub(f'\\)({CN_CHAR})', r'）\1', text)
        # (纯中文内容) → （纯中文内容）
        text = re.sub(
            f'\\(({CN_CHAR}[^()\\n]*?{CN_CHAR})\\)',
            r'（\1）', text)
        text = re.sub(f'\\(({CN_CHAR})\\)', r'（\1）', text)

    return text


# =====================================================================
# Inline markdown processing
# =====================================================================
def render_inline(text):
    """Process inline markdown: code, bold, italic, links, images."""
    # Step 1: protect inline code (save and replace with placeholders)
    code_segments = []

    def save_code(m):
        code_segments.append(m.group(1))
        return f"\x00CODE{len(code_segments) - 1}\x00"

    text = re.sub(r'`([^`\n]+)`', save_code, text)

    # Step 1.5: normalize Chinese punctuation on the remaining text
    # (inline code segments are already protected as placeholders)
    text = normalize_punctuation(text)

    # Step 2: escape HTML in remaining text
    text = html_escape(text)

    # Step 3: images ![alt](url) — must come before links
    text = re.sub(
        r'!\[([^\]]*)\]\(([^)]+)\)',
        lambda m: image_html(m.group(1), m.group(2)),
        text)

    # Step 4: links [text](url)
    text = re.sub(
        r'\[([^\]]+)\]\(([^)]+)\)',
        lambda m: f'<a href="{m.group(2)}" style="{link_style()}">{m.group(1)}</a>',
        text)

    # Step 5: bold **text** (do this before italic to avoid * conflicts)
    text = re.sub(
        r'\*\*([^*\n]+)\*\*',
        lambda m: f'<strong style="{strong_style()}">{m.group(1)}</strong>',
        text)

    # Step 6: italic *text* — Chinese italic looks bad in WeChat, so we strip
    # the markers and keep the text content as-is. (Plain underscore _x_ also.)
    text = re.sub(r'(?<!\*)\*([^*\n]+)\*(?!\*)', r'\1', text)
    text = re.sub(r'(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])', r'\1', text)

    # Step 7: restore inline code with proper styling
    def restore_code(m):
        idx = int(m.group(1))
        content = html_escape(code_segments[idx])
        return f'<code style="{inline_code_style()}">{content}</code>'

    text = re.sub(r'\x00CODE(\d+)\x00', restore_code, text)

    return text


# =====================================================================
# Block parsing
# =====================================================================
def parse_blocks(md_text):
    """
    Split markdown into block-level elements.
    Returns list of (kind, content) tuples.
    """
    lines = md_text.splitlines()
    blocks = []
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]

        # Blank line — skip
        if line.strip() == '':
            i += 1
            continue

        # Fenced code block
        m = re.match(r'^```(\w*)\s*$', line)
        if m:
            lang = m.group(1)
            i += 1
            code_lines = []
            while i < n and not re.match(r'^```\s*$', lines[i]):
                code_lines.append(lines[i])
                i += 1
            i += 1  # skip closing ```
            blocks.append(('code', lang, '\n'.join(code_lines)))
            continue

        # Heading
        m = re.match(r'^(#{1,6})\s+(.*)$', line)
        if m:
            level = len(m.group(1))
            content = m.group(2).strip().rstrip('#').strip()
            blocks.append(('heading', level, content))
            i += 1
            continue

        # Horizontal rule
        if re.match(r'^\s*([-*_])\s*\1\s*\1[\s\1]*$', line):
            blocks.append(('hr', None, None))
            i += 1
            continue

        # Blockquote — consume consecutive > lines. Each non-blank > line
        # becomes its own paragraph (matches WeChat author intuition where
        # line breaks inside a quote are usually intentional, e.g. tweets).
        if line.lstrip().startswith('>'):
            quote_lines = []
            while i < n and lines[i].lstrip().startswith('>'):
                stripped = re.sub(r'^\s*>\s?', '', lines[i])
                quote_lines.append(stripped)
                i += 1
            blocks.append(('quote', None, quote_lines))
            continue

        # Unordered list
        if re.match(r'^\s*[-*+]\s+', line):
            items = []
            current = None
            while i < n:
                m = re.match(r'^\s*[-*+]\s+(.*)$', lines[i])
                if m:
                    if current is not None:
                        items.append(current)
                    current = m.group(1)
                    i += 1
                elif (lines[i].strip() != '' and
                      lines[i].startswith((' ', '\t')) and
                      current is not None):
                    # continuation of current item
                    current += ' ' + lines[i].strip()
                    i += 1
                else:
                    break
            if current is not None:
                items.append(current)
            blocks.append(('ul', None, items))
            continue

        # Ordered list
        if re.match(r'^\s*\d+\.\s+', line):
            items = []
            current = None
            while i < n:
                m = re.match(r'^\s*\d+\.\s+(.*)$', lines[i])
                if m:
                    if current is not None:
                        items.append(current)
                    current = m.group(1)
                    i += 1
                elif (lines[i].strip() != '' and
                      lines[i].startswith((' ', '\t')) and
                      current is not None):
                    current += ' ' + lines[i].strip()
                    i += 1
                else:
                    break
            if current is not None:
                items.append(current)
            blocks.append(('ol', None, items))
            continue

        # Paragraph — consume until blank line or block element
        para_lines = [line]
        i += 1
        while i < n and lines[i].strip() != '':
            l = lines[i]
            # Check if this line starts a new block element
            if (re.match(r'^#{1,6}\s', l) or
                re.match(r'^```', l) or
                re.match(r'^\s*[-*+]\s', l) or
                re.match(r'^\s*\d+\.\s', l) or
                l.lstrip().startswith('>') or
                re.match(r'^\s*([-*_])\s*\1\s*\1[\s\1]*$', l)):
                break
            para_lines.append(l)
            i += 1
        blocks.append(('p', None, ' '.join(s.strip() for s in para_lines)))

    return blocks


# =====================================================================
# Block rendering
# =====================================================================
def render_blocks(blocks):
    out = []
    for block in blocks:
        kind = block[0]
        if kind == 'heading':
            level = block[1]
            content = render_inline(block[2])
            style = {1: h1_style(), 2: h2_style(), 3: h3_style()}.get(level, h4_style())
            out.append(f'<h{level} style="{style}">{content}</h{level}>')
        elif kind == 'p':
            out.append(f'<p style="{paragraph_style()}">{render_inline(block[2])}</p>')
        elif kind == 'code':
            lang = block[1]
            code = block[2]
            out.append(code_block_html(code, lang))
        elif kind == 'quote':
            # Check if first non-empty line starts with "！" or has special emphasis
            inner_html = render_quote_content(block[2])
            out.append(f'<blockquote style="{blockquote_style(emphasis=False)}">{inner_html}</blockquote>')
        elif kind == 'ul':
            items_html = ''.join(
                f'<li style="{li_style()}">{render_inline(item)}</li>'
                for item in block[2]
            )
            out.append(f'<ul style="{ul_style()}">{items_html}</ul>')
        elif kind == 'ol':
            items_html = ''.join(
                f'<li style="{li_style()}">{render_inline(item)}</li>'
                for item in block[2]
            )
            out.append(f'<ol style="{ol_style()}">{items_html}</ol>')
        elif kind == 'hr':
            out.append(hr_html())
    return '\n'.join(out)


def render_quote_content(lines):
    """
    Render content inside a blockquote. `lines` is a list of stripped lines
    (already had the `> ` prefix removed). Empty strings mark paragraph breaks.
    Each non-blank line becomes its own <p>.
    """
    if not lines:
        return ''
    # Drop trailing empty lines
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        return ''
    rendered = []
    for idx, line in enumerate(lines):
        text = line.strip()
        if not text:
            continue
        margin = '0 0 8px 0' if idx < len(lines) - 1 else '0'
        rendered.append(f'<p style="margin: {margin};">{render_inline(text)}</p>')
    return ''.join(rendered)


# =====================================================================
# Top-level convert
# =====================================================================
def convert(md_text):
    blocks = parse_blocks(md_text)
    body = render_blocks(blocks)
    return f'<section style="{WRAPPER_STYLE}">\n{body}\n</section>\n'


# =====================================================================
# CLI
# =====================================================================
def apply_color_override(color):
    """Replace PRIMARY everywhere with custom color."""
    global PRIMARY, PRIMARY_DARK
    PRIMARY = color
    # PRIMARY_DARK is used for blockquote text — leave default for readability
    # User can edit script directly for more control.


def main():
    parser = argparse.ArgumentParser(
        description="Convert Markdown to WeChat 公众号 HTML in mdnice 蔷薇紫 style.")
    parser.add_argument('input', help='Input markdown file (.md)')
    parser.add_argument('-o', '--output',
                        help='Output HTML file (default: input.html alongside input)')
    parser.add_argument('--color', default=None,
                        help='Override primary color, e.g. "#ff6b35"')
    parser.add_argument('--stdout', action='store_true',
                        help='Print HTML to stdout instead of writing a file')
    parser.add_argument('--no-punct', action='store_true',
                        help='Disable automatic Chinese punctuation conversion '
                             '(keep ASCII punctuation as-is in markdown)')
    args = parser.parse_args()

    if args.color:
        if not re.match(r'^#[0-9A-Fa-f]{6}$', args.color):
            print(f"Error: --color must be a 6-digit hex like #8064a2", file=sys.stderr)
            sys.exit(1)
        apply_color_override(args.color)

    if args.no_punct:
        global NORMALIZE_PUNCT
        NORMALIZE_PUNCT = False

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: {input_path} does not exist", file=sys.stderr)
        sys.exit(1)

    md = input_path.read_text(encoding='utf-8')
    html = convert(md)

    if args.stdout:
        sys.stdout.write(html)
        return

    output_path = (Path(args.output) if args.output
                   else input_path.with_suffix('.html'))
    output_path.write_text(html, encoding='utf-8')
    print(f"Wrote {output_path} ({len(html):,} bytes)")


if __name__ == '__main__':
    main()
