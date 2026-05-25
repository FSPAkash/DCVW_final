from __future__ import annotations

import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from openpyxl import Workbook
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


ACCENT = colors.HexColor("#B84A2E")        # iron-oxide red
ACCENT_INK = colors.HexColor("#8C2F1A")
INK = colors.HexColor("#111111")
INK_2 = colors.HexColor("#3F3F3F")
INK_3 = colors.HexColor("#757575")
LINE = colors.HexColor("#E5E5E5")
LINE_2 = colors.HexColor("#EFEFEF")
BG_STRIPE = colors.HexColor("#FAFAFA")
BG_CARD = colors.white
ACCENT_TINT = colors.HexColor("#FBEDE8")


def _logo_path() -> Optional[Path]:
    for name in ("partner2.png", "main-logo.png"):
        p = BASE_DIR.parent / "frontend" / "public" / "logos" / name
        if p.exists():
            return p
    return None


BASE_DIR = Path(__file__).resolve().parent
REPORTS_DIR = BASE_DIR / "generated_reports"
REPORTS_DIR.mkdir(exist_ok=True)


def maybe_build_report(question: str, snapshot: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    spec = _build_report_spec(question, snapshot)
    if not spec:
        return None
    return _materialize_report(spec)


def get_report_file(report_id: str, fmt: str) -> tuple[Path, str]:
    report_dir = REPORTS_DIR / report_id
    if not report_dir.exists():
        raise FileNotFoundError(report_id)
    suffix = fmt.lower().strip()
    if suffix not in {"pdf", "xlsx"}:
        raise FileNotFoundError(fmt)
    matches = list(report_dir.glob(f"*.{suffix}"))
    if not matches:
        raise FileNotFoundError(f"{report_id}.{suffix}")
    return matches[0], matches[0].name


def _build_report_spec(question: str, snapshot: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    q = " ".join(str(question or "").lower().split())
    lots = snapshot.get("lots") or []
    duplicates = snapshot.get("duplicates") or []
    recent_edits = sorted(snapshot.get("recent_edits") or [], key=lambda row: row.get("last_edited") or "", reverse=True)
    grade_filter = _extract_grade_filter(q)

    if _matches_any(q, ["duplicate", "duplicates", "same lot", "repeated lot"]):
        rows = [row for row in duplicates if not grade_filter or str(row.get("grade") or "").lower() == grade_filter]
        if not rows:
            return None
        return {
            "kind": "duplicate-lot-codes",
            "title": f"Duplicate Lot Codes{' - Grade ' + grade_filter.upper() if grade_filter else ''}",
            "question": question,
            "summary": f"{len(rows)} duplicate lot entries found in the current master overview.",
            "stats": [
                {"label": "Duplicate entries", "value": str(len(rows))},
                {"label": "Grade filter", "value": grade_filter.upper() if grade_filter else "All"},
            ],
            "sections": [
                {
                    "title": "Duplicate lot entries",
                    "columns": ["Lot No", "Grade", "Column", "Qty MT"],
                    "rows": [
                        [row.get("lot_no") or "-", row.get("grade") or "-", row.get("col_letter") or "-", _fmt_qty(row.get("qty_mt"))]
                        for row in rows
                    ],
                }
            ],
            "reason": "Duplicate lot codes are easier to review and share as a downloadable report.",
        }

    if _matches_any(q, ["lowest stock", "low stock", "minimum stock", "min stock", "depleted", "out of stock", "zero stock"]):
        depleted = [
            row for row in lots
            if (row.get("qty_mt") or 0) <= 0 and _grade_ok(row, grade_filter)
        ]
        low_non_zero = sorted(
            [
                row for row in lots
                if (row.get("qty_mt") or 0) > 0 and (row.get("qty_mt") or 0) <= 2 and _grade_ok(row, grade_filter)
            ],
            key=lambda row: (row.get("qty_mt") or 0, row.get("lot_no") or ""),
        )
        if not depleted and not low_non_zero:
            return None
        lowest_positive = low_non_zero[0]["qty_mt"] if low_non_zero else None
        sections: List[Dict[str, Any]] = []
        if depleted:
            sections.append({
                "title": "Depleted lots (0 MT)",
                "columns": ["Lot No", "Grade", "Column", "Qty MT", "Last edited"],
                "rows": [_lot_row(row) for row in sorted(depleted, key=lambda r: ((r.get("grade") or ""), (r.get("lot_no") or "")))],
            })
        if low_non_zero:
            sections.append({
                "title": "Low non-zero lots (<= 2 MT)",
                "columns": ["Lot No", "Grade", "Column", "Qty MT", "Last edited"],
                "rows": [_lot_row(row) for row in low_non_zero],
            })
        return {
            "kind": "stock-edge-cases",
            "title": f"Lowest Stock Overview{' - Grade ' + grade_filter.upper() if grade_filter else ''}",
            "question": question,
            "summary": (
                f"{len(depleted)} depleted lots and {len(low_non_zero)} non-zero low-stock lots"
                + (f"; lowest non-zero stock is {_fmt_qty(lowest_positive)} MT." if lowest_positive is not None else ".")
            ),
            "stats": [
                {"label": "Depleted lots", "value": str(len(depleted))},
                {"label": "Low non-zero lots", "value": str(len(low_non_zero))},
                {"label": "Lowest non-zero MT", "value": _fmt_qty(lowest_positive) if lowest_positive is not None else "-"},
                {"label": "Grade filter", "value": grade_filter.upper() if grade_filter else "All"},
            ],
            "sections": sections,
            "reason": "This question returns many lots, so the agent prepared a report automatically.",
        }

    if _matches_any(q, ["recently edited", "recent edits", "edited most recently", "last edited", "edit history"]):
        rows = [row for row in recent_edits if _grade_ok(row, grade_filter)]
        if not rows:
            return None
        return {
            "kind": "recent-edits",
            "title": f"Recent Inventory Edits{' - Grade ' + grade_filter.upper() if grade_filter else ''}",
            "question": question,
            "summary": f"{len(rows)} lots have edit stamps in the current master overview.",
            "stats": [
                {"label": "Stamped lots", "value": str(len(rows))},
                {"label": "Most recent date", "value": rows[0].get("last_edited") or "-"},
                {"label": "Grade filter", "value": grade_filter.upper() if grade_filter else "All"},
            ],
            "sections": [
                {
                    "title": "Lots with edit dates",
                    "columns": ["Lot No", "Grade", "Column", "Qty MT", "Last edited"],
                    "rows": [_lot_row(row) for row in rows],
                }
            ],
            "reason": "Recent edit history is more useful as a downloadable list than a short chat reply.",
        }

    if _matches_any(q, ["highest stock", "top stock", "most stock", "largest lots", "highest qty"]):
        rows = sorted(
            [row for row in lots if (row.get("qty_mt") or 0) > 0 and _grade_ok(row, grade_filter)],
            key=lambda row: (-(row.get("qty_mt") or 0), row.get("lot_no") or ""),
        )
        if not rows:
            return None
        top_rows = rows[:50]
        return {
            "kind": "highest-stock",
            "title": f"Highest Stock Lots{' - Grade ' + grade_filter.upper() if grade_filter else ''}",
            "question": question,
            "summary": f"Top {len(top_rows)} active lots sorted by available MT.",
            "stats": [
                {"label": "Active lots", "value": str(len(rows))},
                {"label": "Top lot", "value": f"{top_rows[0].get('lot_no')} ({_fmt_qty(top_rows[0].get('qty_mt'))} MT)"},
                {"label": "Grade filter", "value": grade_filter.upper() if grade_filter else "All"},
            ],
            "sections": [
                {
                    "title": "Top active lots by stock",
                    "columns": ["Lot No", "Grade", "Column", "Qty MT", "Last edited"],
                    "rows": [_lot_row(row) for row in top_rows],
                }
            ],
            "reason": "Large ranked stock lists are easier to scan in Excel or PDF.",
        }

    if grade_filter and _matches_any(q, ["show", "list", "all lots", "all", "export", "report", "download"]):
        rows = sorted(
            [row for row in lots if _grade_ok(row, grade_filter)],
            key=lambda row: (-(row.get("qty_mt") or 0), row.get("lot_no") or ""),
        )
        if not rows:
            return None
        return {
            "kind": "grade-inventory",
            "title": f"Inventory Lots - Grade {grade_filter.upper()}",
            "question": question,
            "summary": f"{len(rows)} lots found for grade {grade_filter.upper()}.",
            "stats": [
                {"label": "Lots", "value": str(len(rows))},
                {"label": "Total MT", "value": _fmt_qty(sum((row.get('qty_mt') or 0) for row in rows))},
                {"label": "Grade filter", "value": grade_filter.upper()},
            ],
            "sections": [
                {
                    "title": f"All lots in grade {grade_filter.upper()}",
                    "columns": ["Lot No", "Grade", "Column", "Qty MT", "Last edited"],
                    "rows": [_lot_row(row) for row in rows],
                }
            ],
            "reason": "The request is list-shaped, so the agent prepared a full report automatically.",
        }

    return None


def _materialize_report(spec: Dict[str, Any]) -> Dict[str, Any]:
    report_id = datetime.now().strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:8]
    report_dir = REPORTS_DIR / report_id
    report_dir.mkdir(parents=True, exist_ok=True)

    base_name = _slugify(spec["title"])
    pdf_path = report_dir / f"{base_name}.pdf"
    xlsx_path = report_dir / f"{base_name}.xlsx"

    _write_xlsx(xlsx_path, spec)
    _write_pdf(pdf_path, spec)

    return {
        "id": report_id,
        "kind": spec["kind"],
        "title": spec["title"],
        "summary": spec["summary"],
        "reason": spec["reason"],
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "files": {
            "pdf": {
                "filename": pdf_path.name,
                "url": f"/api/v3/master/chat/reports/{report_id}/pdf",
            },
            "xlsx": {
                "filename": xlsx_path.name,
                "url": f"/api/v3/master/chat/reports/{report_id}/xlsx",
            },
        },
    }


def _write_xlsx(path: Path, spec: Dict[str, Any]) -> None:
    wb = Workbook()
    summary_ws = wb.active
    summary_ws.title = "Summary"
    summary_ws.append(["Title", spec["title"]])
    summary_ws.append(["Question", spec["question"]])
    summary_ws.append(["Summary", spec["summary"]])
    summary_ws.append(["Generated", datetime.now().strftime("%Y-%m-%d %H:%M:%S")])
    summary_ws.append([])
    summary_ws.append(["Metric", "Value"])
    for stat in spec.get("stats", []):
        summary_ws.append([stat.get("label"), stat.get("value")])
    summary_ws.column_dimensions["A"].width = 24
    summary_ws.column_dimensions["B"].width = 60

    for section in spec.get("sections", []):
        ws = wb.create_sheet(title=_sheet_title(section.get("title") or "Section"))
        ws.append([section.get("title")])
        ws.append([spec["question"]])
        ws.append([])
        columns = section.get("columns") or []
        ws.append(columns)
        for row in section.get("rows", []):
            ws.append(row)
        for idx, col_name in enumerate(columns, start=1):
            width = max(len(str(col_name)), 12)
            for row in section.get("rows", [])[:100]:
                width = max(width, len(str(row[idx - 1])) if idx - 1 < len(row) else 0)
            ws.column_dimensions[_excel_col(idx)].width = min(width + 2, 28)
        ws.freeze_panes = "A4"

    wb.save(path)


def _write_pdf(path: Path, spec: Dict[str, Any]) -> None:
    eyebrow_style = ParagraphStyle(
        "Eyebrow",
        fontName="Helvetica-Bold",
        fontSize=8,
        leading=10,
        textColor=ACCENT_INK,
        spaceAfter=4,
    )
    title_style = ParagraphStyle(
        "DashTitle",
        fontName="Helvetica-Bold",
        fontSize=22,
        leading=24,
        textColor=INK,
        spaceAfter=10,
    )
    meta_label = ParagraphStyle(
        "MetaLabel",
        fontName="Helvetica-Bold",
        fontSize=7.5,
        leading=10,
        textColor=INK_3,
        spaceAfter=1,
    )
    meta_value = ParagraphStyle(
        "MetaValue",
        fontName="Helvetica",
        fontSize=10,
        leading=13,
        textColor=INK,
        spaceAfter=6,
    )
    section_style = ParagraphStyle(
        "SectionTitle",
        fontName="Helvetica-Bold",
        fontSize=9,
        leading=11,
        spaceBefore=6,
        spaceAfter=6,
        textColor=INK_2,
    )

    page_size = landscape(A4)
    left = right = 16 * mm
    doc = SimpleDocTemplate(
        str(path),
        pagesize=page_size,
        leftMargin=left,
        rightMargin=right,
        topMargin=14 * mm,
        bottomMargin=16 * mm,
    )

    story: List[Any] = [
        Paragraph("SALES &middot; INVENTORY &middot; OPERATIONS PLANNING", eyebrow_style),
        Paragraph(spec["title"], title_style),
    ]

    meta_pairs = [
        ("QUESTION", spec.get("question") or "-"),
        ("SUMMARY", spec.get("summary") or "-"),
        ("GENERATED", datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
    ]
    meta_cells: List[List[Any]] = []
    for label, value in meta_pairs:
        meta_cells.append([
            Paragraph(label, meta_label),
            Paragraph(str(value), meta_value),
        ])
    meta_table = Table(meta_cells, colWidths=[28 * mm, page_size[0] - left - right - 28 * mm])
    meta_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LINEBELOW", (0, -1), (-1, -1), 0.5, LINE),
    ]))
    story.extend([meta_table, Spacer(1, 10)])

    if spec.get("stats"):
        stat_rows = [["METRIC", "VALUE"]] + [
            [stat.get("label"), stat.get("value")] for stat in spec["stats"]
        ]
        stat_table = Table(stat_rows, colWidths=[70 * mm, 120 * mm], repeatRows=1)
        stat_table.setStyle(_table_style())
        story.extend([stat_table, Spacer(1, 14)])

    for section in spec.get("sections", []):
        story.append(Paragraph((section.get("title") or "Section").upper(), section_style))
        table_rows = [
            [str(c).upper() for c in (section.get("columns") or [])]
        ] + (section.get("rows") or [])
        col_count = max(1, len(section.get("columns") or []))
        usable_width = page_size[0] - left - right
        col_width = usable_width / col_count
        table = Table(table_rows, colWidths=[col_width] * col_count, repeatRows=1)
        table.setStyle(_table_style())
        story.extend([table, Spacer(1, 12)])

    doc.build(story, onFirstPage=_draw_chrome, onLaterPages=_draw_chrome)


def _table_style() -> TableStyle:
    return TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BG_STRIPE),
        ("TEXTCOLOR", (0, 0), (-1, 0), INK_3),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, 0), 7.5),
        ("FONTSIZE", (0, 1), (-1, -1), 9),
        ("LEADING", (0, 0), (-1, -1), 12),
        ("TEXTCOLOR", (0, 1), (-1, -1), INK),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, LINE),
        ("LINEBELOW", (0, 1), (-1, -2), 0.3, LINE_2),
        ("BOX", (0, 0), (-1, -1), 0.4, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [BG_CARD, BG_STRIPE]),
        ("ALIGN", (0, 0), (-1, -1), "LEFT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, 0), 6),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
        ("TOPPADDING", (0, 1), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ])


def _draw_chrome(canvas, doc) -> None:
    page_w, page_h = doc.pagesize
    # Top accent rule
    canvas.setStrokeColor(ACCENT)
    canvas.setLineWidth(1.5)
    canvas.line(doc.leftMargin, page_h - 8 * mm, doc.leftMargin + 22 * mm, page_h - 8 * mm)

    # Footer chrome
    footer_y = 8 * mm
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.4)
    canvas.line(doc.leftMargin, footer_y + 6 * mm, page_w - doc.rightMargin, footer_y + 6 * mm)

    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(INK_3)
    canvas.drawString(doc.leftMargin, footer_y, "DCW SIOP · INVENTORY MATCH MATRIX")

    # Powered by (right side)
    powered_text = "POWERED BY  FINDABILITY SCIENCES"
    text_w = canvas.stringWidth(powered_text, "Helvetica-Bold", 7.5)
    logo = _logo_path()
    logo_w = 0
    right_x = page_w - doc.rightMargin
    if logo:
        try:
            from reportlab.lib.utils import ImageReader
            img = ImageReader(str(logo))
            iw, ih = img.getSize()
            logo_h = 4.5 * mm
            logo_w = logo_h * (iw / ih) if ih else 4.5 * mm
            canvas.drawImage(
                img,
                right_x - text_w - logo_w - 3,
                footer_y - 1,
                width=logo_w,
                height=logo_h,
                mask="auto",
                preserveAspectRatio=True,
            )
        except Exception:
            logo_w = 0
    canvas.setFont("Helvetica-Bold", 7.5)
    canvas.setFillColor(INK_2)
    canvas.drawRightString(right_x, footer_y, powered_text)

    # Page number center
    page_num = f"PAGE {doc.page}"
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(INK_3)
    canvas.drawCentredString(page_w / 2, footer_y, page_num)


def _lot_row(row: Dict[str, Any]) -> List[str]:
    return [
        str(row.get("lot_no") or "-"),
        str(row.get("grade") or "-"),
        str(row.get("col_letter") or "-"),
        _fmt_qty(row.get("qty_mt")),
        str(row.get("last_edited") or "-"),
    ]


def _grade_ok(row: Dict[str, Any], grade_filter: Optional[str]) -> bool:
    if not grade_filter:
        return True
    return str(row.get("grade") or "").lower() == grade_filter


def _extract_grade_filter(q: str) -> Optional[str]:
    match = re.search(r"\bgrade\s*([a-z0-9.-]+)\b", q)
    if match:
        return match.group(1).strip().lower()
    return None


def _matches_any(q: str, phrases: List[str]) -> bool:
    return any(phrase in q for phrase in phrases)


def _fmt_qty(value: Any) -> str:
    if value is None:
        return "-"
    try:
        return f"{float(value):.3f}".rstrip("0").rstrip(".")
    except Exception:
        return str(value)


def _slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return cleaned or "master-overview-report"


def _sheet_title(value: str) -> str:
    cleaned = re.sub(r"[:\\/*?\[\]]+", " ", value).strip()
    return (cleaned or "Sheet")[:31]


def _excel_col(idx: int) -> str:
    out = ""
    while idx > 0:
        idx, rem = divmod(idx - 1, 26)
        out = chr(65 + rem) + out
    return out
