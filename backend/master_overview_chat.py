from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional, Set, Tuple

from openai import OpenAI

import master_overview_reports
import v3_master


SUPPORTED_LANGUAGES = {
    "english": "Respond in clear English.",
    "hinglish": "Respond in natural Hinglish using Latin script only. Do not switch to Devanagari.",
    "tamil": "Respond in Tamil.",
}

MAX_HISTORY_ITEMS = 6
MAX_HISTORY_CHARS = 1200
MAX_RELEVANT_LOTS = 60
MAX_GRADE_LOTS = 80
MAX_BLENDS = 20

_SNAPSHOT_CACHE_LOCK = Lock()
_SNAPSHOT_CACHE: Dict[str, Any] = {
    "key": None,
    "snapshot": None,
}


def get_chat_config() -> Dict[str, Any]:
    api_key = os.getenv("MASTER_OVERVIEW_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    base_url = os.getenv("MASTER_OVERVIEW_OPENAI_BASE_URL") or os.getenv("OPENAI_BASE_URL")
    model = os.getenv("MASTER_OVERVIEW_OPENAI_MODEL") or os.getenv("OPENAI_MODEL") or "gpt-4o-mini"
    return {
        "configured": bool(api_key),
        "api_key": api_key,
        "base_url": base_url,
        "model": model,
        "languages": list(SUPPORTED_LANGUAGES.keys()),
    }


def _normalize_code(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]+", "", str(value or "").upper())


def _normalize_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def _file_signature(path: Path) -> Tuple[str, Optional[int], Optional[int]]:
    if not path.exists():
        return str(path), None, None
    stat = path.stat()
    return str(path), stat.st_mtime_ns, stat.st_size


def _snapshot_cache_key() -> Tuple[Tuple[str, Optional[int], Optional[int]], ...]:
    files = [
        v3_master.MASTER_FILE,
        v3_master.EDIT_DATES_FILE,
        v3_master.BLEND_RECORDS_FILE,
    ]
    return tuple(_file_signature(path) for path in files)


def _build_snapshot() -> Dict[str, Any]:
    master = v3_master.parse_master()
    lots = master.get("lots", [])
    total_qty = round(sum((lot.get("qty_mt") or 0) for lot in lots), 3)
    active_lots = [lot for lot in lots if (lot.get("qty_mt") or 0) > 0]
    top_active = sorted(
        active_lots,
        key=lambda lot: (-(lot.get("qty_mt") or 0), lot.get("lot_no") or "", lot.get("col_letter") or ""),
    )
    low_stock = sorted(
        [lot for lot in lots if 0 < (lot.get("qty_mt") or 0) <= 2],
        key=lambda lot: (lot.get("qty_mt") or 0, lot.get("lot_no") or "", lot.get("col_letter") or ""),
    )
    depleted = sorted(
        [lot for lot in lots if (lot.get("qty_mt") or 0) <= 0],
        key=lambda lot: (lot.get("grade") or "", lot.get("lot_no") or "", lot.get("col_letter") or ""),
    )
    recent_edits = sorted(
        [lot for lot in lots if lot.get("last_edited")],
        key=lambda lot: (lot.get("last_edited") or "", lot.get("lot_no") or ""),
        reverse=True,
    )

    grade_summary: Dict[str, Dict[str, Any]] = {}
    for lot in lots:
        grade = str(lot.get("grade") or "-")
        row = grade_summary.setdefault(
            grade,
            {"grade": grade, "lot_count": 0, "qty_mt": 0.0, "active_lots": 0, "largest_lot": None},
        )
        qty = lot.get("qty_mt") or 0
        row["lot_count"] += 1
        row["qty_mt"] = round(row["qty_mt"] + qty, 3)
        if qty > 0:
            row["active_lots"] += 1
        largest = row["largest_lot"]
        if largest is None or qty > (largest.get("qty_mt") or 0):
            row["largest_lot"] = {
                "lot_id": lot.get("lot_id"),
                "lot_no": lot.get("lot_no"),
                "col_letter": lot.get("col_letter"),
                "qty_mt": qty,
            }

    grade_rows = sorted(grade_summary.values(), key=lambda row: (-row["qty_mt"], row["grade"]))

    slim_lots = [
        {
            "lot_id": lot.get("lot_id"),
            "lot_no": lot.get("lot_no"),
            "col_letter": lot.get("col_letter"),
            "grade": lot.get("grade"),
            "qty_mt": lot.get("qty_mt"),
            "present_methods": lot.get("present_methods") or [],
            "last_edited": lot.get("last_edited"),
            "blend_notes": lot.get("blend_notes") or [],
            "is_blended": bool(lot.get("is_blended")),
        }
        for lot in lots
    ]

    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "totals": {
            "lot_count": len(lots),
            "active_lot_count": len(active_lots),
            "total_qty_mt": total_qty,
            "grade_count": len(grade_rows),
            "low_stock_count": len(low_stock),
            "depleted_count": len(depleted),
            "duplicate_count": len(master.get("duplicates") or []),
        },
        "methods": master.get("methods") or [],
        "submethod_of_method": master.get("submethod_of_method") or {},
        "grade_summary": grade_rows,
        "duplicates": master.get("duplicates") or [],
        "low_stock": low_stock[:30],
        "recent_edits": recent_edits[:30],
        "depleted": depleted[:30],
        "top_active": top_active[:40],
        "lots": slim_lots,
        "blends": master.get("blend_records") or [],
    }


def _get_snapshot() -> Dict[str, Any]:
    cache_key = _snapshot_cache_key()
    with _SNAPSHOT_CACHE_LOCK:
        if _SNAPSHOT_CACHE["key"] == cache_key and _SNAPSHOT_CACHE["snapshot"] is not None:
            return _SNAPSHOT_CACHE["snapshot"]
        snapshot = _build_snapshot()
        _SNAPSHOT_CACHE["key"] = cache_key
        _SNAPSHOT_CACHE["snapshot"] = snapshot
        return snapshot


def _normalize_history(history: Any) -> List[Dict[str, str]]:
    normalized: List[Dict[str, str]] = []
    if not isinstance(history, list):
        return normalized
    for item in history[-MAX_HISTORY_ITEMS:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        if role not in {"user", "assistant"}:
            continue
        text = _normalize_text(item.get("content"))
        if not text:
            continue
        normalized.append({"role": role, "content": text[:MAX_HISTORY_CHARS]})
    return normalized


def _extract_text(response: Any) -> str:
    output_text = getattr(response, "output_text", None)
    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()

    payload = response.model_dump() if hasattr(response, "model_dump") else response
    if isinstance(payload, dict):
        chunks: List[str] = []
        for item in payload.get("output", []) or []:
            item_type = item.get("type")
            if item_type == "message":
                for content in item.get("content", []) or []:
                    ctype = content.get("type")
                    if ctype in ("output_text", "text") and content.get("text"):
                        chunks.append(content["text"])
            elif item_type == "output_text" and item.get("text"):
                chunks.append(item["text"])
        if chunks:
            return "\n".join(chunks).strip()
    return ""


def _diagnose_empty(response: Any) -> str:
    payload = response.model_dump() if hasattr(response, "model_dump") else response
    if not isinstance(payload, dict):
        return "empty response"
    status = payload.get("status")
    incomplete = (payload.get("incomplete_details") or {}).get("reason")
    usage = payload.get("usage") or {}
    return f"status={status} reason={incomplete} usage={usage}"


def _compact_lot(lot: Dict[str, Any]) -> Dict[str, Any]:
    notes = lot.get("blend_notes") or []
    compact_notes = []
    total_blend_usage = 0.0
    for note in notes[:4]:
        mt_used = round(note.get("mt_used") or 0, 3)
        total_blend_usage += mt_used
        compact_notes.append({
            "blend_id": note.get("blend_id"),
            "mt_used": mt_used,
            "output_lot_no": note.get("output_lot_no"),
            "output_grade": note.get("output_grade"),
            "note": note.get("note"),
        })
    return {
        "lot_id": lot.get("lot_id"),
        "lot_no": lot.get("lot_no"),
        "col_letter": lot.get("col_letter"),
        "grade": lot.get("grade"),
        "qty_mt": lot.get("qty_mt"),
        "present_methods": lot.get("present_methods") or [],
        "last_edited": lot.get("last_edited"),
        "is_blended": bool(lot.get("is_blended")),
        "blend_usage_mt": round(total_blend_usage, 3),
        "blend_notes": compact_notes,
    }


def _compact_blend(blend: Dict[str, Any]) -> Dict[str, Any]:
    output = blend.get("output") or {}
    return {
        "blend_id": blend.get("blend_id"),
        "created_at": blend.get("created_at"),
        "card_url": blend.get("card_url"),
        "output": {
            "lot_id": output.get("lot_id"),
            "lot_no": output.get("lot_no"),
            "grade": output.get("grade"),
            "qty_mt": output.get("qty_mt"),
        },
        "inputs": [
            {
                "lot_id": item.get("lot_id"),
                "lot_no": item.get("lot_no"),
                "grade": item.get("grade"),
                "mt_used": item.get("mt_used"),
            }
            for item in (blend.get("inputs") or [])
        ],
    }


def _query_intents(question: str) -> Set[str]:
    q = question.lower()
    intents: Set[str] = set()
    if any(term in q for term in ("low stock", "lowest stock", "depleted", "out of stock", "zero stock", "below 2", "at or below 2")):
        intents.add("low_stock")
    if any(term in q for term in ("recent edits", "recently edited", "edit history", "last edited", "edited most recently")):
        intents.add("recent_edits")
    if any(term in q for term in ("duplicate", "duplicates", "same lot", "repeated lot")):
        intents.add("duplicates")
    if any(term in q for term in ("blend", "blended", "blending", "blend card")):
        intents.add("blends")
    if any(term in q for term in ("highest stock", "top stock", "most stock", "largest lots", "highest qty")):
        intents.add("highest_stock")
    if any(term in q for term in ("show all", "list all", "all lots", "full inventory", "download", "export", "report")):
        intents.add("broad_inventory")
    return intents


def _find_matches(
    snapshot: Dict[str, Any],
    question: str,
    history_items: List[Dict[str, str]],
) -> Tuple[List[Dict[str, Any]], List[str], List[str], Set[str], str]:
    query_parts = [item["content"] for item in history_items if item["role"] == "user"][-2:] + [question]
    query_text = " ".join(part for part in query_parts if part).strip()
    lowered_query = query_text.lower()
    normalized_query = _normalize_code(query_text)
    query_tokens = {
        _normalize_code(token)
        for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9-]*", query_text)
    }
    query_tokens.discard("")

    lots = snapshot.get("lots") or []
    lot_index: Dict[str, List[Dict[str, Any]]] = {}
    for lot in lots:
        lot_index.setdefault(_normalize_code(lot.get("lot_no")), []).append(lot)

    matched_lots: List[Dict[str, Any]] = []
    seen_lot_ids: Set[str] = set()
    for token in query_tokens:
        for lot in lot_index.get(token, []):
            lot_id = str(lot.get("lot_id") or "")
            if lot_id and lot_id not in seen_lot_ids:
                seen_lot_ids.add(lot_id)
                matched_lots.append(lot)

    matched_grades: List[str] = []
    for row in snapshot.get("grade_summary") or []:
        grade = str(row.get("grade") or "").strip()
        if not grade:
            continue
        grade_norm = _normalize_code(grade)
        exact_phrase = re.search(rf"(?<![A-Za-z0-9]){re.escape(grade.lower())}(?![A-Za-z0-9])", lowered_query)
        relaxed_phrase = len(grade_norm) >= 5 and grade_norm in normalized_query
        if grade_norm in query_tokens or exact_phrase or relaxed_phrase:
            matched_grades.append(grade)

    matched_methods: List[str] = []
    for method in snapshot.get("methods") or []:
        method_text = str(method or "").strip()
        submethod_text = str((snapshot.get("submethod_of_method") or {}).get(method_text) or "").strip()
        if method_text and method_text.lower() in lowered_query:
            matched_methods.append(method_text)
            continue
        if submethod_text and submethod_text.lower() in lowered_query:
            matched_methods.append(method_text)

    return matched_lots, sorted(set(matched_grades)), sorted(set(matched_methods)), _query_intents(query_text), query_text


def _dedupe_lots(lots: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    deduped: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for lot in lots:
        lot_id = str(lot.get("lot_id") or "")
        if not lot_id or lot_id in seen:
            continue
        seen.add(lot_id)
        deduped.append(lot)
    return deduped


def _sort_lots_by_qty(lots: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(
        lots,
        key=lambda lot: (-(lot.get("qty_mt") or 0), lot.get("lot_no") or "", lot.get("col_letter") or ""),
    )


def _related_blends(snapshot: Dict[str, Any], lots: List[Dict[str, Any]], include_all: bool) -> List[Dict[str, Any]]:
    lot_ids = {str(lot.get("lot_id") or "") for lot in lots}
    lot_numbers = {_normalize_code(lot.get("lot_no")) for lot in lots}
    related: List[Dict[str, Any]] = []
    for blend in snapshot.get("blends") or []:
        output = blend.get("output") or {}
        output_id = str(output.get("lot_id") or "")
        output_no = _normalize_code(output.get("lot_no"))
        inputs = blend.get("inputs") or []
        input_hit = any(
            str(item.get("lot_id") or "") in lot_ids or _normalize_code(item.get("lot_no")) in lot_numbers
            for item in inputs
        )
        output_hit = output_id in lot_ids or output_no in lot_numbers
        if include_all or input_hit or output_hit:
            related.append(_compact_blend(blend))
    return related[:MAX_BLENDS]


def _build_query_snapshot(
    snapshot: Dict[str, Any],
    question: str,
    history_items: List[Dict[str, str]],
) -> Dict[str, Any]:
    matched_lots, matched_grades, matched_methods, intents, query_text = _find_matches(snapshot, question, history_items)

    relevant_lots: List[Dict[str, Any]] = []
    if matched_lots:
        relevant_lots.extend(matched_lots)

    if matched_grades:
        grade_lots = [
            lot for lot in snapshot.get("lots") or []
            if str(lot.get("grade") or "") in matched_grades
        ]
        grade_limit = MAX_GRADE_LOTS if "broad_inventory" in intents else MAX_RELEVANT_LOTS
        relevant_lots.extend(_sort_lots_by_qty(grade_lots)[:grade_limit])

    if matched_methods:
        method_lots = [
            lot for lot in snapshot.get("lots") or []
            if any(method in (lot.get("present_methods") or []) for method in matched_methods)
        ]
        relevant_lots.extend(_sort_lots_by_qty(method_lots)[:MAX_RELEVANT_LOTS])

    if "low_stock" in intents:
        relevant_lots.extend(snapshot.get("low_stock") or [])
        relevant_lots.extend(snapshot.get("depleted") or [])

    if "recent_edits" in intents:
        relevant_lots.extend(snapshot.get("recent_edits") or [])

    if "highest_stock" in intents:
        relevant_lots.extend(snapshot.get("top_active") or [])
    elif not relevant_lots and not intents:
        relevant_lots.extend(snapshot.get("top_active") or [])

    relevant_lots = _dedupe_lots(relevant_lots)[:MAX_GRADE_LOTS]

    include_duplicates = "duplicates" in intents
    include_low_stock = "low_stock" in intents
    include_recent_edits = "recent_edits" in intents
    include_blends = "blends" in intents or any(
        lot.get("is_blended") or (lot.get("blend_notes") or []) for lot in relevant_lots
    )

    return {
        "generated_at": snapshot.get("generated_at"),
        "query_focus": {
            "question": query_text,
            "intents": sorted(intents),
            "matched_lot_numbers": sorted({str(lot.get("lot_no") or "") for lot in matched_lots}),
            "matched_grades": matched_grades,
            "matched_methods": matched_methods,
            "included_lot_count": len(relevant_lots),
            "omitted_lot_count": max(0, len(snapshot.get("lots") or []) - len(relevant_lots)),
        },
        "totals": snapshot.get("totals") or {},
        "methods": snapshot.get("methods") or [],
        "submethod_of_method": snapshot.get("submethod_of_method") or {},
        "grade_summary": snapshot.get("grade_summary") or [],
        "top_active_lots": [_compact_lot(lot) for lot in (snapshot.get("top_active") or [])[:20]],
        "relevant_lots": [_compact_lot(lot) for lot in relevant_lots],
        "low_stock": [_compact_lot(lot) for lot in (snapshot.get("low_stock") or [])] if include_low_stock else [],
        "depleted": [_compact_lot(lot) for lot in (snapshot.get("depleted") or [])] if include_low_stock else [],
        "recent_edits": [_compact_lot(lot) for lot in (snapshot.get("recent_edits") or [])] if include_recent_edits else [],
        "duplicates": (snapshot.get("duplicates") or []) if include_duplicates else [],
        "blends": _related_blends(snapshot, relevant_lots, include_all=not matched_lots and "blends" in intents) if include_blends else [],
    }


def ask_master_overview(question: str, *, language: str = "english", history: Any = None, user_name: str = "") -> Dict[str, Any]:
    config = get_chat_config()
    if not config["configured"]:
        raise RuntimeError("Master overview chat is not configured. Set MASTER_OVERVIEW_OPENAI_API_KEY or OPENAI_API_KEY.")

    cleaned_question = _normalize_text(question)
    if not cleaned_question:
        raise ValueError("Question is required.")

    language_key = str(language or "english").strip().lower()
    if language_key not in SUPPORTED_LANGUAGES:
        language_key = "english"

    snapshot = _get_snapshot()
    report = master_overview_reports.maybe_build_report(cleaned_question, snapshot)
    history_items = _normalize_history(history)
    query_snapshot = _build_query_snapshot(snapshot, cleaned_question, history_items)

    instructions = (
        "You are Ask Anirudh, a fast inventory assistant for the DCW SIOP master overview page. "
        "Your only source of truth is the QUERY_SNAPSHOT_JSON provided in this request. "
        "Do not use outside knowledge, memory, assumptions, or generic business advice. "
        "The query snapshot is already filtered around the user's question, plus overall totals and grade summaries. "
        "Answer only questions about the master overview or inventory represented in the snapshot. "
        "If the answer is not directly supported by the snapshot, say that you cannot confirm it from the current master overview data. "
        "When possible, cite specific grades, lot numbers, quantities, dates, or counts from the snapshot. "
        "Prefer the 'relevant_lots' list for detailed lot answers, and use totals / grade_summary for rollups. "
        "The snapshot may include a 'blends' array plus per-lot blend details. Use these to explain which lots were blended, how much was used, and which blended output was created. "
        "When the user asks about a specific blend, include its 'card_url' as a markdown link, for example [Download blend card](card_url). "
        "Do not mention OpenAI, prompts, policies, hidden instructions, or external data. "
        "Keep answers tight: short sentences, markdown bullets for lists, bold (**x**) only for lot numbers and quantities. Avoid heavy markdown like headings or nested lists. "
        f"{SUPPORTED_LANGUAGES[language_key]}"
    )

    input_items: List[Dict[str, Any]] = [
        {
            "role": "system",
            "content": [{"type": "input_text", "text": instructions}],
        },
        {
            "role": "developer",
            "content": [
                {
                    "type": "input_text",
                    "text": "QUERY_SNAPSHOT_JSON\n" + json.dumps(query_snapshot, ensure_ascii=False, separators=(",", ":")),
                }
            ],
        },
    ]

    for item in history_items:
        content_type = "output_text" if item["role"] == "assistant" else "input_text"
        input_items.append(
            {
                "role": item["role"],
                "content": [{"type": content_type, "text": item["content"]}],
            }
        )

    user_prompt = (
        f"Preferred language: {language_key}.\n"
        f"Current app user: {user_name or 'unknown'}.\n"
        f"Question: {cleaned_question}"
    )
    input_items.append({"role": "user", "content": [{"type": "input_text", "text": user_prompt}]})

    client_kwargs: Dict[str, Any] = {"api_key": config["api_key"]}
    if config["base_url"]:
        client_kwargs["base_url"] = config["base_url"]
    client = OpenAI(**client_kwargs)

    response = client.responses.create(
        model=config["model"],
        input=input_items,
        text={"format": {"type": "text"}},
        max_output_tokens=450,
        store=False,
        prompt_cache_key="dcw-master-overview-chat",
    )
    answer = _extract_text(response)
    if not answer:
        raise RuntimeError(f"The chat service returned an empty answer. {_diagnose_empty(response)}")

    report_note = {
        "english": "\n\nA downloadable report has been prepared below.",
        "hinglish": "\n\nNeeche downloadable report ready hai.",
        "tamil": "\n\nà®ªà®¤à®¿à®µà®¿à®±à®•à¯à®•à®•à¯à®•à¯‚à®Ÿà®¿à®¯ à®…à®±à®¿à®•à¯à®•à¯ˆ à®•à¯€à®´à¯‡ à®¤à®¯à®¾à®°à¯ à®šà¯†à®¯à¯à®¯à®ªà¯à®ªà®Ÿà¯à®Ÿà¯à®³à¯à®³à®¤à¯.",
    }
    if report:
        answer = answer.rstrip() + report_note.get(language_key, report_note["english"])

    return {
        "answer": answer,
        "language": language_key,
        "model": config["model"],
        "snapshot_generated_at": snapshot["generated_at"],
        "report": report,
    }
