"""
COA OCR/parse pipeline for DCW SIOP v3.

Strategy:
- Scan backend/COA/<customer-folder>/*.pdf
- For each folder, parse all PDFs; pick the most recent (by report date in PDF, falling
  back to file mtime) as the customer's current COA.
- Extract fields:
    customer (folder name + Remark line)
    grade, std, lot_no_on_coa, quantity_on_coa
    report_date, mfg_date, po_no
    product, chemical_class, delivery_condition, colour_index
    mass_tone: {DL, Da, Db, DE, DL_lo, DL_hi, Da_lo, Da_hi, Db_lo, Db_hi, DE_max}
    tint_tone: {DL, Da, Db, DE, strength, *_lo, *_hi, DE_max, strength_lo, strength_hi}
- For scanned (image-only) PDFs: fall back to pdf2image + tesseract; otherwise OpenAI vision.
- Persist to customer_coa.json. UI can override values; overrides stored in customer_overrides.json.
"""
from __future__ import annotations

import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pdfplumber

try:
    import pytesseract
    from pdf2image import convert_from_path
    OCR_OK = True
except Exception:
    OCR_OK = False

BASE_DIR = Path(__file__).resolve().parent
COA_DIR = BASE_DIR / "COA"
COA_CACHE_FILE = BASE_DIR / "customer_coa.json"
COA_OVERRIDES_FILE = BASE_DIR / "customer_overrides.json"


_TONE_KEY_RE = re.compile(
    r"colour\s*difference\s*(D[LEab])\s*of\s*(mass|tint)\s*tone",
    re.IGNORECASE,
)
_STRENGTH_RE = re.compile(r"tint(?:ing)?\s*strength", re.IGNORECASE)
_OCR_CONFIG = "--oem 3 --psm 6"


def _tesseract_candidates() -> List[Path]:
    candidates: List[Path] = []
    seen: set[str] = set()

    def add(path_str: str | None) -> None:
        if not path_str:
            return
        path = Path(path_str.strip('"')).expanduser()
        key = str(path).lower()
        if key not in seen:
            candidates.append(path)
            seen.add(key)

    add(os.environ.get("TESSERACT_CMD"))
    add(shutil.which("tesseract"))

    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    program_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    user_profile = os.environ.get("USERPROFILE", "")

    add(str(Path(program_files) / "Tesseract-OCR" / "tesseract.exe"))
    add(str(Path(program_files_x86) / "Tesseract-OCR" / "tesseract.exe"))
    if local_app_data:
        add(str(Path(local_app_data) / "Programs" / "Tesseract-OCR" / "tesseract.exe"))
    if user_profile:
        add(str(Path(user_profile) / "AppData" / "Local" / "Programs" / "Tesseract-OCR" / "tesseract.exe"))

    return candidates


def _poppler_candidates() -> List[Path]:
    candidates: List[Path] = []
    seen: set[str] = set()

    def add(path_str: str | None) -> None:
        if not path_str:
            return
        path = Path(path_str.strip('"')).expanduser()
        key = str(path).lower()
        if key not in seen:
            candidates.append(path)
            seen.add(key)

    add(os.environ.get("POPPLER_BIN"))

    local_app_data = Path(os.environ.get("LOCALAPPDATA", ""))
    program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
    possible_roots = [
        local_app_data / "Microsoft" / "WinGet" / "Packages",
        local_app_data / "Programs",
        program_files,
    ]
    for root in possible_roots:
        if not root.exists():
            continue
        for exe in root.rglob("pdfinfo.exe"):
            add(str(exe.parent))

    pdfinfo_on_path = shutil.which("pdfinfo")
    if pdfinfo_on_path:
        add(str(Path(pdfinfo_on_path).parent))
    return candidates


def _configure_ocr_tools() -> Optional[Path]:
    if not OCR_OK:
        return None

    for candidate in _tesseract_candidates():
        if candidate.exists():
            pytesseract.pytesseract.tesseract_cmd = str(candidate)
            break

    for candidate in _poppler_candidates():
        if (candidate / "pdfinfo.exe").exists() and (candidate / "pdftoppm.exe").exists():
            return candidate
    return None


def _norm(s: Any) -> str:
    if s is None:
        return ""
    return re.sub(r"\s+", " ", str(s)).strip()


def _to_float(s: Any) -> Optional[float]:
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    t = _norm(s)
    if not t or t == "-" or t.upper() in {"N/A", "NA"}:
        return None
    # Strip non-numeric trailing junk
    m = re.search(r"-?\d+(?:\.\d+)?", t)
    return float(m.group()) if m else None


def _parse_date(s: str) -> Optional[str]:
    s = _norm(s)
    for fmt in ("%d.%m.%Y", "%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except Exception:
            pass
    return None


def _extract_header_fields(text: str) -> Dict[str, Any]:
    """Parse the 'General Description' block (key : value pairs)."""
    out: Dict[str, Any] = {}
    fields = {
        "product": r"Product\s*[:\-]\s*([^\n]+?)\s+Chemical\s*Class",
        "chemical_class": r"Chemical\s*Class\s*[:\-]\s*([^\n]+)",
        "delivery_condition": r"Delivery\s*Condition\s*[:\-]\s*([^\n]+?)\s+Colour\s*Index",
        "colour_index": r"Colour\s*Index\s*[:\-]\s*([^\n]+)",
        "grade": r"Grade\s*[:\-]\s*([^\n]+?)\s+Lot\s*No",
        "lot_no_on_coa": r"Lot\s*No\s*[:\-]\s*([^\n]+)",
        "std": r"STD\s*[:\-]\s*([^\n]+?)\s+Quantity",
        "quantity_on_coa": r"Quantity\s*[:\-]\s*([^\n]+)",
        "mfg_date": r"Date\s*of\s*Mfg\s*[:\-]\s*([^\n]+?)\s+PO\s*No",
        "po_no": r"PO\s*No\s*[:\-]?\s*([^\n]*)",
        "report_date": r"Report\s*Date\s*[:\-]\s*([0-9./\-]+)",
        "remark1": r"Remark[s]?1?\s*[:\-]\s*([^\n]+)",
        "remark2": r"Remark[s]?2\s*[:\-]\s*([^\n]+)",
    }
    for k, pat in fields.items():
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            out[k] = _norm(m.group(1))

    # Generic Remarks: line
    if "remark1" not in out:
        m = re.search(r"Remarks?\s*[:\-]\s*([^\n]+)", text, re.IGNORECASE)
        if m:
            out["remark1"] = _norm(m.group(1))

    # Normalize dates
    if "report_date" in out:
        out["report_date_iso"] = _parse_date(out["report_date"]) or out["report_date"]
    if "mfg_date" in out:
        out["mfg_date_iso"] = _parse_date(out["mfg_date"]) or out["mfg_date"]
    return out


def _classify_row(characteristic: str) -> Tuple[Optional[str], Optional[str]]:
    """Return (tone_kind, axis) where tone_kind in {'mass','tint'} and axis in {DL,Da,Db,DE} or (None,None)."""
    if not characteristic:
        return (None, None)
    # Normalize whitespace + remove newlines + handle 'ColourdifferenceDLofMassTone' (no spaces)
    s = re.sub(r"\s+", " ", characteristic).strip()
    s2 = s.replace(" ", "")
    m = re.search(r"colourdifference(D[LEab])of(mass|tint)tone", s2, re.IGNORECASE)
    if m:
        return (m.group(2).lower(), m.group(1)[0].upper() + m.group(1)[1].lower() if False else m.group(1))
    # Fallback spaced
    m = re.search(r"colour\s*difference\s*(D[LEab])\s*of\s*(mass|tint)\s*tone", s, re.IGNORECASE)
    if m:
        axis = m.group(1)
        # canonicalize axis: DL, Da, Db, DE
        axis_norm = axis[0].upper() + axis[1] if len(axis) > 1 else axis.upper()
        # but we want 'DL','Da','Db','DE'
        ax_map = {"DL": "DL", "DA": "Da", "DB": "Db", "DE": "DE"}
        axis_norm = ax_map.get(axis.upper(), axis)
        return (m.group(2).lower(), axis_norm)
    return (None, None)


def _canon_axis(a: str) -> str:
    a = a.strip()
    m = {"DL": "DL", "DA": "Da", "DB": "Db", "DE": "DE"}
    return m.get(a.upper(), a)


def _parse_tables(tables: List[List[List[str]]]) -> Dict[str, Any]:
    """Extract mass_tone, tint_tone dicts + strength from extracted tables.

    Supports two COA layouts:
      A) Row-per-axis: 'Colour difference DL of Mass Tone' with Lo/Hi/Result cols
      B) Row-per-tone: 'XXX-Mass tone' / 'XXX-Reduced tone' with DL/Da/Db/DE columns
    """
    mass: Dict[str, Any] = {}
    tint: Dict[str, Any] = {}
    strength: Dict[str, Any] = {}

    # Detect table type by header
    for table in tables:
        if not table:
            continue
        header = [_norm(c).lower() for c in table[0]]
        # Layout B: header contains 'description' AND axis cols 'dl','da','db','de'
        is_layout_b = ("description" in " ".join(header)) and any("dl" == h or h.endswith(" dl") for h in header)
        if is_layout_b:
            # find col indices for DL,Da,Db,DE,Strength
            idx = {}
            for i, h in enumerate(header):
                hl = h.lower().strip()
                if hl == "dl": idx["DL"] = i
                elif hl == "da": idx["Da"] = i
                elif hl == "db": idx["Db"] = i
                elif hl == "de": idx["DE"] = i
                elif "tint" in hl or "strength" in hl: idx["strength"] = i
                elif hl == "description" or hl.endswith("description"): idx["desc"] = i
            for row in table[1:]:
                if not row or len(row) <= max(idx.values(), default=0):
                    continue
                desc = _norm(row[idx.get("desc", 1)])
                if not desc:
                    continue
                bucket = None
                dl_lower = desc.lower()
                if "mass" in dl_lower:
                    bucket = mass
                elif "reduced" in dl_lower or "tint" in dl_lower:
                    bucket = tint
                if bucket is None:
                    continue
                for ax in ("DL", "Da", "Db", "DE"):
                    if ax in idx:
                        bucket[ax] = _to_float(row[idx[ax]])
                if bucket is tint and "strength" in idx:
                    sv = _to_float(row[idx["strength"]])
                    if sv is not None:
                        tint["strength"] = sv
            continue

        # Layout A
        for row in table:
            if not row or len(row) < 5:
                continue
            characteristic = _norm(row[1])
            lo = _to_float(row[2])
            hi = _to_float(row[3])
            res = _to_float(row[4])
            if not characteristic:
                continue

            tone, axis = _classify_row(characteristic)
            if tone and axis:
                axis = _canon_axis(axis)
                bucket = mass if tone == "mass" else tint
                bucket[axis] = res
                bucket[f"{axis}_lo"] = lo
                bucket[f"{axis}_hi"] = hi
                if axis == "DE":
                    bucket["DE_max"] = hi
                continue

            if _STRENGTH_RE.search(characteristic) or "tinting" in characteristic.lower():
                strength = {"value": res, "lo": lo, "hi": hi}

    if strength:
        tint["strength"] = strength.get("value")
        tint["strength_lo"] = strength.get("lo")
        tint["strength_hi"] = strength.get("hi")

    return {"mass_tone": mass, "tint_tone": tint}


def _ocr_text_to_pseudo_tables(text: str) -> List[List[List[str]]]:
    """Coarse: split each line on multi-space; let _parse_tables decide. Builds 1 pseudo-table."""
    rows: List[List[str]] = []
    for line in text.splitlines():
        cells = re.split(r"\s{2,}|\t", line.strip())
        if len(cells) >= 5:
            rows.append(cells)
    return [rows] if rows else []


def _parse_ocr_measurements(text: str) -> Dict[str, Any]:
    mass: Dict[str, Any] = {}
    tint: Dict[str, Any] = {}

    for raw_line in text.splitlines():
        line = _norm(raw_line)
        if not line:
            continue

        tone_match = re.search(r"Colour\s*difference\s*(D[LEab])\s*of\s*(Mass|Tint)\s*(.*)", line, re.IGNORECASE)
        if tone_match:
            axis = _canon_axis(tone_match.group(1))
            bucket = mass if tone_match.group(2).lower() == "mass" else tint
            values = [float(v) for v in re.findall(r"-?\d+(?:\.\d+)?", tone_match.group(3))]
            if axis == "DE":
                if len(values) >= 2:
                    bucket["DE_hi"] = values[0]
                    bucket["DE"] = values[1]
                    bucket["DE_max"] = values[0]
                elif len(values) == 1:
                    bucket["DE_hi"] = values[0]
                    bucket["DE_max"] = values[0]
            else:
                if len(values) >= 3:
                    bucket[f"{axis}_lo"] = values[0]
                    bucket[f"{axis}_hi"] = values[1]
                    bucket[axis] = values[2]
                elif len(values) >= 2:
                    bucket[f"{axis}_lo"] = values[0]
                    bucket[f"{axis}_hi"] = values[1]
                elif len(values) == 1:
                    bucket[axis] = values[0]
            continue

        if _STRENGTH_RE.search(line):
            raw_values = re.findall(r"-?\d+(?:\.\d+)?", line)
            values = [float(v) for v in raw_values]
            if len(values) >= 3:
                strength_value = values[-1]
                if "." not in raw_values[-1] and strength_value > 1000 and values[-2] <= 200:
                    strength_value = strength_value / 100.0
                tint["strength_lo"] = values[-3]
                tint["strength_hi"] = values[-2]
                tint["strength"] = strength_value
            elif len(values) == 1:
                tint["strength"] = values[0]

    return {"mass_tone": mass, "tint_tone": tint}


def parse_coa_pdf(pdf_path: Path) -> Dict[str, Any]:
    """Parse a single COA PDF. Falls back to tesseract OCR for cid-encoded PDFs."""
    text_parts: List[str] = []
    all_tables: List[List[List[str]]] = []
    poppler_bin = _configure_ocr_tools()
    with pdfplumber.open(pdf_path) as p:
        for page in p.pages:
            t = page.extract_text() or ""
            text_parts.append(t)
            try:
                all_tables.extend(page.extract_tables() or [])
            except Exception:
                pass
    full_text = "\n".join(text_parts)

    # cid-encoded or empty text -> fallback to tesseract
    cid_ratio = full_text.count("(cid:") / max(1, len(full_text))
    if (cid_ratio > 0.02 or len(full_text.strip()) < 60) and OCR_OK and poppler_bin is not None:
        try:
            images = convert_from_path(str(pdf_path), dpi=300, poppler_path=str(poppler_bin))
            ocr_text = "\n".join(pytesseract.image_to_string(img, config=_OCR_CONFIG) for img in images)
            if len(ocr_text.strip()) > len(full_text.strip()):
                full_text = ocr_text
                # try table-ish parsing on OCR text rows
                all_tables = _ocr_text_to_pseudo_tables(ocr_text)
        except Exception:
            pass

    head = _extract_header_fields(full_text)
    tones = _parse_tables(all_tables)
    if full_text:
        ocr_tones = _parse_ocr_measurements(full_text)
        for tone_key in ("mass_tone", "tint_tone"):
            tones.setdefault(tone_key, {})
            for key, value in ocr_tones.get(tone_key, {}).items():
                tones[tone_key].setdefault(key, value)

    out: Dict[str, Any] = {
        "file": pdf_path.name,
        "parsed_ok": bool(tones["mass_tone"] or tones["tint_tone"]),
        **head,
        **tones,
        "raw_text_preview": full_text[:600],
    }
    return out


def _coa_sort_key(parsed: Dict[str, Any], file_mtime: float) -> Tuple[str, float]:
    iso = parsed.get("report_date_iso") or ""
    return (iso, file_mtime)


def scan_all() -> Dict[str, Any]:
    """Scan all COA folders. Returns {customers: [...]}."""
    if not COA_DIR.exists():
        return {"customers": [], "scanned_at": datetime.now().isoformat(timespec="seconds")}

    customers: List[Dict[str, Any]] = []
    for folder in sorted(COA_DIR.iterdir()):
        if not folder.is_dir():
            continue
        pdfs = sorted(folder.glob("*.pdf"))
        if not pdfs:
            continue
        parsed_list: List[Dict[str, Any]] = []
        for p in pdfs:
            try:
                d = parse_coa_pdf(p)
                d["_mtime"] = p.stat().st_mtime
            except Exception as e:
                d = {"file": p.name, "parsed_ok": False, "error": str(e), "_mtime": p.stat().st_mtime}
            parsed_list.append(d)
        # Pick latest by report_date then mtime
        latest = max(parsed_list, key=lambda d: _coa_sort_key(d, d.get("_mtime", 0)))

        # Customer name: prefer Remark1 (e.g. 'M/S ASIAN PAINTS,KASNA') else folder name
        remark = latest.get("remark1") or ""
        cust_name = re.sub(r"^M/?S[\s.]*", "", remark, flags=re.IGNORECASE).strip() or folder.name
        cust_id = folder.name

        customers.append({
            "id": cust_id,
            "folder": folder.name,
            "name": cust_name,
            "city": latest.get("remark2", "") or "",
            "grade": latest.get("grade", ""),
            "std": latest.get("std", ""),
            "product": latest.get("product", ""),
            "colour_index": latest.get("colour_index", ""),
            "delivery_condition": latest.get("delivery_condition", ""),
            "report_date": latest.get("report_date", ""),
            "report_date_iso": latest.get("report_date_iso", ""),
            "mfg_date": latest.get("mfg_date", ""),
            "po_no": latest.get("po_no", ""),
            "latest_pdf": latest.get("file"),
            "mass_tone": latest.get("mass_tone", {}),
            "tint_tone": latest.get("tint_tone", {}),
            "all_files": [{"file": d["file"], "report_date_iso": d.get("report_date_iso")} for d in parsed_list],
            "parsed_ok": latest.get("parsed_ok", False),
        })

    out = {
        "customers": customers,
        "scanned_at": datetime.now().isoformat(timespec="seconds"),
    }
    COA_CACHE_FILE.write_text(json.dumps(out, indent=2, default=str), encoding="utf-8")
    return out


def load_cache() -> Dict[str, Any]:
    if COA_CACHE_FILE.exists():
        return json.loads(COA_CACHE_FILE.read_text(encoding="utf-8"))
    return scan_all()


def load_overrides() -> Dict[str, Dict[str, Any]]:
    if COA_OVERRIDES_FILE.exists():
        return json.loads(COA_OVERRIDES_FILE.read_text(encoding="utf-8"))
    return {}


def save_override(customer_id: str, patch: Dict[str, Any]) -> None:
    d = load_overrides()
    d[customer_id] = patch
    COA_OVERRIDES_FILE.write_text(json.dumps(d, indent=2), encoding="utf-8")


def clear_override(customer_id: str) -> None:
    d = load_overrides()
    d.pop(customer_id, None)
    COA_OVERRIDES_FILE.write_text(json.dumps(d, indent=2), encoding="utf-8")


def get_customer_effective(customer_id: str) -> Optional[Dict[str, Any]]:
    cache = load_cache()
    cust = next((c for c in cache["customers"] if c["id"] == customer_id), None)
    if not cust:
        return None
    ovs = load_overrides().get(customer_id)
    if ovs:
        eff = json.loads(json.dumps(cust))  # deep copy
        for k in ("mass_tone", "tint_tone", "grade"):
            if k in ovs:
                if isinstance(ovs[k], dict):
                    eff.setdefault(k, {}).update(ovs[k])
                else:
                    eff[k] = ovs[k]
        eff["_overridden"] = True
        return eff
    return cust


if __name__ == "__main__":
    data = scan_all()
    print(f"Scanned {len(data['customers'])} customers")
    ok = sum(1 for c in data['customers'] if c.get('parsed_ok'))
    print(f"Parsed OK: {ok}")
    for c in data['customers'][:3]:
        print(f"\n--- {c['id']} ({c['name']}) ---")
        print(f"  grade={c['grade']} std={c['std']} report={c['report_date']}")
        print(f"  MT: {c.get('mass_tone')}")
        print(f"  RT: {c.get('tint_tone')}")
