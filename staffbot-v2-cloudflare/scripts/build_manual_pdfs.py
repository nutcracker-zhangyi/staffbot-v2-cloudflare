from __future__ import annotations

import html
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "output" / "pdf"
FONT_PATH = Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf")

NAVY = colors.HexColor("#111827")
BLUE = colors.HexColor("#2563EB")
PALE_BLUE = colors.HexColor("#EFF6FF")
SLATE = colors.HexColor("#475569")
LIGHT = colors.HexColor("#E2E8F0")
VERY_LIGHT = colors.HexColor("#F8FAFC")
WARNING_BG = colors.HexColor("#FFF7ED")
WARNING_BORDER = colors.HexColor("#F97316")


def register_fonts() -> None:
    if not FONT_PATH.exists():
        raise FileNotFoundError(f"Required Unicode font is missing: {FONT_PATH}")
    pdfmetrics.registerFont(TTFont("StaffBotUnicode", str(FONT_PATH)))
    pdfmetrics.registerFontFamily(
        "StaffBotUnicode",
        normal="StaffBotUnicode",
        bold="StaffBotUnicode",
        italic="StaffBotUnicode",
        boldItalic="StaffBotUnicode",
    )


def inline_markup(value: str) -> str:
    placeholders: list[str] = []

    def save(fragment: str) -> str:
        placeholders.append(fragment)
        return f"@@INLINE{len(placeholders) - 1}@@"

    value = re.sub(
        r"\[([^\]]+)\]\((https?://[^)]+)\)",
        lambda match: save(
            f'<link href="{html.escape(match.group(2), quote=True)}" color="#2563EB">'
            f'{html.escape(match.group(1))}</link>'
        ),
        value,
    )
    value = re.sub(
        r"<(https?://[^>]+)>",
        lambda match: save(
            f'<link href="{html.escape(match.group(1), quote=True)}" color="#2563EB">'
            f'{html.escape(match.group(1))}</link>'
        ),
        value,
    )
    value = re.sub(
        r"`([^`]+)`",
        lambda match: save(
            f'<font name="StaffBotUnicode" color="#0F766E">{html.escape(match.group(1))}</font>'
        ),
        value,
    )
    value = html.escape(value)
    value = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", value)
    for index, fragment in enumerate(placeholders):
        value = value.replace(f"@@INLINE{index}@@", fragment)
    return value


def build_styles():
    styles = getSampleStyleSheet()
    common = {
        "fontName": "StaffBotUnicode",
        "textColor": NAVY,
        "wordWrap": "CJK",
        "splitLongWords": True,
    }
    return {
        "cover_title": ParagraphStyle(
            "CoverTitle",
            alignment=TA_LEFT,
            fontSize=27,
            leading=37,
            spaceAfter=14,
            **common,
        ),
        "cover_subtitle": ParagraphStyle(
            "CoverSubtitle",
            alignment=TA_LEFT,
            fontSize=13,
            leading=21,
            textColor=SLATE,
            fontName="StaffBotUnicode",
            wordWrap="CJK",
        ),
        "h1": ParagraphStyle(
            "Heading1",
            fontSize=20,
            leading=29,
            spaceBefore=8,
            spaceAfter=13,
            keepWithNext=True,
            **common,
        ),
        "h2": ParagraphStyle(
            "Heading2",
            fontSize=14,
            leading=21,
            spaceBefore=12,
            spaceAfter=7,
            keepWithNext=True,
            textColor=colors.HexColor("#1D4ED8"),
            fontName="StaffBotUnicode",
            wordWrap="CJK",
        ),
        "h3": ParagraphStyle(
            "Heading3",
            fontSize=11.5,
            leading=17,
            spaceBefore=7,
            spaceAfter=4,
            keepWithNext=True,
            **common,
        ),
        "body": ParagraphStyle(
            "Body",
            fontSize=9.5,
            leading=15,
            spaceAfter=5,
            **common,
        ),
        "list": ParagraphStyle(
            "List",
            fontSize=9.5,
            leading=15,
            leftIndent=0,
            firstLineIndent=0,
            **common,
        ),
        "quote": ParagraphStyle(
            "Quote",
            fontSize=9.2,
            leading=15,
            textColor=colors.HexColor("#9A3412"),
            fontName="StaffBotUnicode",
            wordWrap="CJK",
        ),
        "table_head": ParagraphStyle(
            "TableHead",
            fontSize=8.7,
            leading=13,
            textColor=colors.white,
            fontName="StaffBotUnicode",
            wordWrap="CJK",
        ),
        "table_body": ParagraphStyle(
            "TableBody",
            fontSize=8.5,
            leading=13,
            **common,
        ),
        "toc_title": ParagraphStyle(
            "TOCTitle",
            fontSize=18,
            leading=26,
            spaceAfter=14,
            **common,
        ),
    }


class Divider(Flowable):
    def __init__(self, width: float, color=LIGHT, thickness: float = 0.8):
        super().__init__()
        self.width = width
        self.height = 8
        self.color = color
        self.thickness = thickness

    def draw(self):
        self.canv.setStrokeColor(self.color)
        self.canv.setLineWidth(self.thickness)
        self.canv.line(0, 4, self.width, 4)


class ManualDocTemplate(BaseDocTemplate):
    def __init__(self, filename: str, short_title: str, **kwargs):
        super().__init__(filename, **kwargs)
        self.short_title = short_title
        frame = Frame(
            self.leftMargin,
            self.bottomMargin,
            self.width,
            self.height,
            leftPadding=0,
            rightPadding=0,
            topPadding=0,
            bottomPadding=0,
            id="normal",
        )
        self.addPageTemplates(PageTemplate(id="manual", frames=[frame], onPage=self._page))

    def _page(self, canvas, doc):
        if doc.page == 1:
            return
        canvas.saveState()
        canvas.setStrokeColor(LIGHT)
        canvas.setLineWidth(0.6)
        canvas.line(self.leftMargin, A4[1] - 16 * mm, A4[0] - self.rightMargin, A4[1] - 16 * mm)
        canvas.setFont("StaffBotUnicode", 8)
        canvas.setFillColor(SLATE)
        canvas.drawString(self.leftMargin, A4[1] - 12.5 * mm, self.short_title)
        canvas.drawRightString(A4[0] - self.rightMargin, 12 * mm, f"{doc.page}")
        canvas.restoreState()

    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph):
            style_name = flowable.style.name
            if style_name in {"Heading1", "Heading2", "Heading3"}:
                # The Markdown document title is rendered on the cover and is
                # skipped in the body, so many manuals begin directly at H2.
                level = 1 if style_name == "Heading3" else 0
                text = flowable.getPlainText()
                key = f"heading-{self.page}-{abs(hash(text))}"
                self.canv.bookmarkPage(key)
                self.canv.addOutlineEntry(text, key, level=level, closed=False)
                self.notify("TOCEntry", (level, text, self.page, key))


def cover_story(title: str, subtitle: str, audience: str, styles) -> list:
    width = A4[0] - 42 * mm
    return [
        Spacer(1, 31 * mm),
        Paragraph("STAFFBOT", ParagraphStyle(
            "Brand", fontName="StaffBotUnicode", fontSize=12, leading=16,
            textColor=BLUE, spaceAfter=14, wordWrap="CJK"
        )),
        Paragraph(inline_markup(title), styles["cover_title"]),
        Paragraph(inline_markup(subtitle), styles["cover_subtitle"]),
        Spacer(1, 18 * mm),
        Table(
            [[Paragraph(inline_markup(audience), styles["body"])]],
            colWidths=[width],
            style=TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), PALE_BLUE),
                ("BOX", (0, 0), (-1, -1), 0.8, BLUE),
                ("LEFTPADDING", (0, 0), (-1, -1), 12),
                ("RIGHTPADDING", (0, 0), (-1, -1), 12),
                ("TOPPADDING", (0, 0), (-1, -1), 10),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
            ]),
        ),
        Spacer(1, 58 * mm),
        Paragraph("STAGING ONLY - 仅供测试", ParagraphStyle(
            "Staging", fontName="StaffBotUnicode", fontSize=10, leading=14,
            textColor=colors.HexColor("#C2410C"), wordWrap="CJK"
        )),
        Paragraph("2026-08-14", styles["cover_subtitle"]),
        PageBreak(),
    ]


def toc_story(styles) -> list:
    toc = TableOfContents()
    toc.levelStyles = [
        ParagraphStyle(
            "TOCLevel1", fontName="StaffBotUnicode", fontSize=8.6,
            leading=11.5, leftIndent=0, firstLineIndent=0, textColor=NAVY,
        ),
        ParagraphStyle(
            "TOCLevel2", fontName="StaffBotUnicode", fontSize=7.4,
            leading=10, leftIndent=14, firstLineIndent=0, textColor=SLATE,
        ),
    ]
    return [
        Paragraph("目录 / Mục lục / Содержание", styles["toc_title"]),
        Divider(A4[0] - 42 * mm, BLUE, 1.2),
        Spacer(1, 4 * mm),
        toc,
        PageBreak(),
    ]


def paragraph(text: str, style) -> Paragraph:
    return Paragraph(inline_markup(text), style)


def list_flow(items: list[str], ordered: bool, styles):
    return ListFlowable(
        [ListItem(paragraph(item, styles["list"]), leftIndent=4) for item in items],
        bulletType="1" if ordered else "bullet",
        start="1",
        leftIndent=17,
        bulletFontName="StaffBotUnicode",
        bulletFontSize=8.5,
        bulletColor=BLUE,
        spaceAfter=6,
    )


def table_flow(rows: list[list[str]], styles, available_width: float):
    column_count = len(rows[0])
    widths = [available_width / column_count] * column_count
    formatted = []
    for row_index, row in enumerate(rows):
        style = styles["table_head"] if row_index == 0 else styles["table_body"]
        formatted.append([paragraph(cell, style) for cell in row])
    table = Table(formatted, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("BACKGROUND", (0, 1), (-1, -1), VERY_LIGHT),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, VERY_LIGHT]),
        ("GRID", (0, 0), (-1, -1), 0.45, LIGHT),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return table


def markdown_story(markdown: str, styles, available_width: float) -> list:
    lines = markdown.splitlines()
    story: list = []
    index = 0
    first_title_seen = False
    body_started = False

    while index < len(lines):
        raw = lines[index].rstrip()
        stripped = raw.strip()
        if not stripped:
            index += 1
            continue

        if stripped == "---":
            if first_title_seen and not body_started:
                # Cover metadata is already represented on the designed cover.
                # Drop source front matter so it does not create a sparse page.
                story.clear()
            else:
                story.append(PageBreak())
            index += 1
            continue

        heading = re.match(r"^(#{1,3})\s+(.+)$", stripped)
        if heading:
            level = len(heading.group(1))
            text = heading.group(2)
            if level == 1 and not first_title_seen:
                first_title_seen = True
                index += 1
                continue
            body_started = True
            if level == 1 and story and not isinstance(story[-1], PageBreak):
                story.append(PageBreak())
            story.append(paragraph(text, styles[f"h{level}"]))
            index += 1
            continue

        if stripped.startswith("> "):
            quote_lines = []
            while index < len(lines) and lines[index].strip().startswith("> "):
                quote_lines.append(lines[index].strip()[2:])
                index += 1
            story.append(Table(
                [[paragraph(" ".join(quote_lines), styles["quote"])]],
                colWidths=[available_width],
                style=TableStyle([
                    ("BACKGROUND", (0, 0), (-1, -1), WARNING_BG),
                    ("LINEBEFORE", (0, 0), (0, -1), 3, WARNING_BORDER),
                    ("LEFTPADDING", (0, 0), (-1, -1), 10),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                    ("TOPPADDING", (0, 0), (-1, -1), 8),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ]),
            ))
            story.append(Spacer(1, 3 * mm))
            continue

        if stripped.startswith("|") and index + 1 < len(lines):
            separator = lines[index + 1].strip()
            if re.match(r"^\|(?:\s*:?-+:?\s*\|)+$", separator):
                rows = []
                rows.append([cell.strip() for cell in stripped.strip("|").split("|")])
                index += 2
                while index < len(lines) and lines[index].strip().startswith("|"):
                    rows.append([cell.strip() for cell in lines[index].strip().strip("|").split("|")])
                    index += 1
                story.append(table_flow(rows, styles, available_width))
                story.append(Spacer(1, 3 * mm))
                continue

        ordered_match = re.match(r"^\d+\.\s+(.+)$", stripped)
        bullet_match = re.match(r"^-\s+(.+)$", stripped)
        if ordered_match or bullet_match:
            ordered = bool(ordered_match)
            items = []
            pattern = r"^\d+\.\s+(.+)$" if ordered else r"^-\s+(.+)$"
            while index < len(lines):
                match = re.match(pattern, lines[index].strip())
                if not match:
                    break
                items.append(match.group(1))
                index += 1
            story.append(list_flow(items, ordered, styles))
            continue

        paragraph_lines = [stripped]
        index += 1
        while index < len(lines):
            candidate = lines[index].strip()
            if not candidate:
                break
            if (
                candidate == "---"
                or candidate.startswith("#")
                or candidate.startswith("> ")
                or candidate.startswith("|")
                or re.match(r"^\d+\.\s+", candidate)
                or candidate.startswith("- ")
            ):
                break
            paragraph_lines.append(candidate)
            index += 1
        story.append(paragraph(" ".join(paragraph_lines), styles["body"]))

    return story


def build_manual(source_name: str, output_name: str, title: str, subtitle: str, audience: str) -> Path:
    source_path = ROOT / "docs" / "manuals" / source_name
    output_path = OUTPUT_DIR / output_name
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    styles = build_styles()
    doc = ManualDocTemplate(
        str(output_path),
        short_title=title,
        pagesize=A4,
        leftMargin=21 * mm,
        rightMargin=21 * mm,
        topMargin=21 * mm,
        bottomMargin=19 * mm,
        title=title,
        author="StaffBot",
        subject="StaffBot staging operation manual",
    )
    story = cover_story(title, subtitle, audience, styles)
    story.extend(toc_story(styles))
    story.extend(markdown_story(source_path.read_text(encoding="utf-8"), styles, doc.width))
    doc.multiBuild(story)
    return output_path


def main() -> None:
    register_fonts()
    outputs = [
        build_manual(
            "STAGING_ADMIN_GUIDE_ZH.md",
            "staffbot-staging-admin-guide-zh.pdf",
            "StaffBot Staging 管理员操作手册",
            "iPhone 安装、Telegram 验证、审批、工资付款与异常处理",
            "适用对象：staging 店铺管理员与系统测试人员",
        ),
        build_manual(
            "STAGING_EMPLOYEE_GUIDE_ZH_VI_RU.md",
            "staffbot-staging-employee-guide-zh-vi-ru.pdf",
            "StaffBot Staging 员工操作手册",
            "中文 / Tiếng Việt / Русский",
            "适用对象：staging 员工测试人员",
        ),
    ]
    for output in outputs:
        print(output)


if __name__ == "__main__":
    main()
