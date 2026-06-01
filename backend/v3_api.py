"""
v3 Flask blueprint. Mount in app.py with:  from v3_api import v3_bp; app.register_blueprint(v3_bp)
"""
from __future__ import annotations

import json
import math
import os
import platform
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

import openpyxl
from flask import Blueprint, jsonify, request, send_file

import master_overview_chat
import master_overview_reports
import runtime_paths
import v3_coa
import v3_fulfillments
import v3_master
import v3_match


def _master_lock_owner() -> dict | None:
    """Return lock info if Master.xlsx is currently open in Excel, else None.

    Excel writes a sidecar lock file `~$Master.xlsx` while the workbook is open.
    The file contains the locking username (legacy header format). We read the
    first ~100 bytes and pull printable ASCII; if Excel isn't the locker but the
    file still can't be opened for write, we report a generic 'unknown' owner.
    """
    p = v3_master.MASTER_FILE
    side = p.parent / f"~${p.name}"
    if side.exists():
        owner = None
        try:
            raw = side.read_bytes()[:128]
            # Skip the 0x40-prefixed length byte at offset 1, take ASCII chunk
            chunk = raw[2:54] if len(raw) >= 54 else raw[2:]
            cleaned = "".join(ch for ch in chunk.decode("latin-1", errors="ignore") if ch.isprintable()).strip()
            owner = cleaned or None
        except Exception:
            owner = None
        try:
            mtime = datetime.fromtimestamp(side.stat().st_mtime).isoformat(timespec="seconds")
        except Exception:
            mtime = None
        return {"locked": True, "owner": owner or "unknown", "since": mtime, "source": "excel_lockfile"}
    # Fallback: try to open file exclusively. If it fails, something has it.
    try:
        with open(p, "rb+"):
            pass
    except PermissionError:
        return {"locked": True, "owner": "unknown", "since": None, "source": "permission_denied"}
    except FileNotFoundError:
        return None
    return None


v3_bp = Blueprint("v3", __name__, url_prefix="/api/v3")


PIN = "1234"
USER_CREDENTIALS = {
    "Akash": {"password": "a123", "type": "user", "name": "Akash"},
    "Anirudh": {"password": "a456", "type": "user", "name": "Anirudh"},
    "Sanjay": {"password": "s789", "type": "user", "name": "Sanjay"},
    "Sushant": {"password": "s123", "type": "user", "name": "Sushant"},
    "Naina": {"password": "n123", "type": "user", "name": "Naina"},
    "admin": {"password": "admin123", "type": "admin", "name": "Administrator"},
}


def _sanitize(obj: Any):
    """Recursively replace NaN/Inf with None for valid JSON."""
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
    return obj


@v3_bp.post("/login")
def login():
    body = request.get_json(force=True, silent=True) or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USER_CREDENTIALS.get(username)
    if not user or user["password"] != password:
        return jsonify({"success": False, "message": "Invalid credentials"}), 401
    return jsonify({
        "success": True,
        "user": {
            "username": username,
            "name": user["name"],
            "type": user["type"],
        },
    })


@v3_bp.get("/customers")
def customers():
    cache = v3_coa.load_cache()
    overrides = v3_coa.load_overrides()
    out = []
    for c in cache["customers"]:
        eff = v3_coa.get_customer_effective(c["id"])
        out.append({
            "id": c["id"],
            "name": c.get("name"),
            "folder": c.get("folder"),
            "grade": eff.get("grade") if eff else c.get("grade"),
            "std": c.get("std"),
            "report_date": c.get("report_date"),
            "report_date_iso": c.get("report_date_iso"),
            "city": c.get("city"),
            "parsed_ok": c.get("parsed_ok"),
            "latest_pdf": c.get("latest_pdf"),
            "overridden": c["id"] in overrides,
        })
    out.sort(key=lambda r: r["name"] or r["id"])
    return jsonify({"customers": out, "scanned_at": cache.get("scanned_at")})


@v3_bp.post("/coa/rescan")
def rescan():
    data = v3_coa.scan_all()
    return jsonify({"ok": True, "count": len(data["customers"]), "scanned_at": data["scanned_at"]})


@v3_bp.get("/customer/<cid>")
def customer_detail(cid):
    cust = v3_coa.get_customer_effective(cid)
    if not cust:
        return jsonify({"error": "customer not found"}), 404
    return jsonify(_sanitize(cust))


@v3_bp.post("/verify_pin")
def verify_pin():
    body = request.get_json(force=True, silent=True) or {}
    pin = str(body.get("pin", ""))
    if pin != PIN:
        return jsonify({"error": "invalid pin"}), 403
    return jsonify({"ok": True})


@v3_bp.post("/customer/<cid>/override")
def customer_override(cid):
    body = request.get_json(force=True, silent=True) or {}
    pin = str(body.get("pin", ""))
    if pin != PIN:
        return jsonify({"error": "invalid pin"}), 403
    patch = body.get("patch") or {}
    # Only accept known keys
    clean = {}
    if "grade" in patch:
        clean["grade"] = str(patch["grade"]).strip()
    for k in ("mass_tone", "tint_tone"):
        if k in patch and isinstance(patch[k], dict):
            clean[k] = {kk: vv for kk, vv in patch[k].items() if vv is not None}
    v3_coa.save_override(cid, clean)
    return jsonify({"ok": True, "effective": _sanitize(v3_coa.get_customer_effective(cid))})


@v3_bp.post("/customer/<cid>/override/clear")
def customer_override_clear(cid):
    # No PIN: reverting to canonical COA is not a privileged change (just removes
    # a customization). Privileged action is creating the override, not removing it.
    v3_coa.clear_override(cid)
    return jsonify({"ok": True, "effective": _sanitize(v3_coa.get_customer_effective(cid))})


@v3_bp.get("/master/lock")
def master_lock_status():
    """Lightweight poll endpoint: is Master.xlsx currently held by Excel?"""
    info = _master_lock_owner()
    if info:
        return jsonify(info)
    return jsonify({"locked": False})


@v3_bp.get("/runtime")
def runtime_info():
    return jsonify({
        "render": bool(os.getenv("RENDER")),
        "master_edit_mode": runtime_paths.master_edit_mode(),
        "supports_local_open": runtime_paths.supports_local_master_open(),
        "supports_master_upload": True,
        "data_dir": str(runtime_paths.DATA_DIR),
    })


@v3_bp.post("/master/open")
def master_open():
    """Open Master.xlsx in the host machine's default app (Excel) so the lab
    tech can edit it directly. Returns the lock state immediately afterwards
    so the client can flip into offline mode.

    Only works when the Flask backend runs on the same machine the user wants
    to edit on (typical SIOP deployment). For remote/cloud hosting this is a
    no-op and the client should surface a 'open the file manually' message.
    """
    body = request.get_json(force=True, silent=True) or {}
    if str(body.get("pin", "")) != PIN:
        return jsonify({"error": "invalid pin"}), 403
    if not runtime_paths.supports_local_master_open():
        return jsonify({
            "error": "local_open_disabled",
            "message": "This deployment cannot open Excel on the server. Download Master.xlsx, edit it locally, and upload the edited workbook instead.",
        }), 400
    p = v3_master.MASTER_FILE
    if not p.exists():
        return jsonify({"error": "master file not found", "path": str(p)}), 404
    try:
        if platform.system() == "Windows":
            os.startfile(str(p))  # type: ignore[attr-defined]
        elif platform.system() == "Darwin":
            subprocess.Popen(["open", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p)])
    except Exception as e:
        return jsonify({"error": f"could not open file: {e}"}), 500
    # Excel takes a moment to create the lock file; client should poll /lock.
    return jsonify({"ok": True, "path": str(p), "lock": _master_lock_owner() or {"locked": False}})


@v3_bp.get("/master/file")
def master_file_download():
    p = v3_master.MASTER_FILE
    if not p.exists():
        return jsonify({"error": "master file not found", "path": str(p)}), 404
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return send_file(p, as_attachment=True, download_name=f"Master-{stamp}.xlsx")


@v3_bp.post("/master/file")
def master_file_upload():
    blocked = _reject_if_locked()
    if blocked:
        return blocked

    if str(request.form.get("pin", "")) != PIN:
        return jsonify({"error": "invalid pin"}), 403

    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"error": "file is required"}), 400
    if not upload.filename.lower().endswith(".xlsx"):
        return jsonify({"error": "only .xlsx files are supported"}), 400

    tmp_dir = runtime_paths.DATA_DIR / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = tmp_dir / f"master-upload-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.xlsx"
    backup_path: Path | None = None

    try:
        upload.save(tmp_path)
        wb = openpyxl.load_workbook(tmp_path, read_only=True, data_only=True)
        if v3_master.SHEET_NAME not in wb.sheetnames:
            wb.close()
            return jsonify({"error": f"uploaded workbook must contain sheet '{v3_master.SHEET_NAME}'"}), 400
        wb.close()

        master_path = v3_master.MASTER_FILE
        backup_dir = runtime_paths.DATA_DIR / "backups" / "master_uploads"
        backup_dir.mkdir(parents=True, exist_ok=True)
        if master_path.exists():
            backup_path = backup_dir / f"Master-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.xlsx"
            shutil.copy2(master_path, backup_path)

        shutil.copy2(tmp_path, master_path)

        parsed = v3_master.parse_master()
        allowed_edit_keys = {lot["lot_id"] for lot in parsed.get("lots", [])}
        allowed_edit_keys.update(lot["lot_no"] for lot in parsed.get("lots", []) if lot.get("lot_no"))
        existing_dates = v3_master._read_edit_dates()
        filtered_dates = {k: v for k, v in existing_dates.items() if k in allowed_edit_keys}
        v3_master._write_edit_dates(filtered_dates)

        return jsonify({
            "ok": True,
            "message": "Master workbook replaced successfully. A backup of the previous file was created before upload.",
            "backup_file": backup_path.name if backup_path else None,
            "totals": {
                "lot_count": len(parsed.get("lots", [])),
                "total_qty_mt": round(sum((lot.get("qty_mt") or 0) for lot in parsed.get("lots", [])), 3),
            },
        })
    except Exception as e:  # pylint: disable=broad-except
        if backup_path and backup_path.exists():
            try:
                shutil.copy2(backup_path, v3_master.MASTER_FILE)
            except Exception:
                pass
        return jsonify({"error": f"master upload failed: {e}"}), 400
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


def _reject_if_locked():
    """Return a (response, status) tuple if master is locked, else None.
    Use at the top of any write endpoint that touches Master.xlsx."""
    info = _master_lock_owner()
    if info:
        return jsonify({
            "error": "master_locked",
            "message": "Master.xlsx is being edited and the app is offline. Try again once the file is closed.",
            "lock": info,
        }), 409
    return None


@v3_bp.get("/master")
def master():
    m = v3_master.parse_master()
    lots = [{
        "lot_id": l.get("lot_id"),
        "lot_no": l["lot_no"],
        "col_letter": l.get("col_letter"),
        "grade": l["grade"],
        "qty_mt": l["qty_mt"],
        "present_methods": l["present_methods"],
        "last_edited": l.get("last_edited"),
        "blocks": l.get("blocks"),
        "blend_notes": l.get("blend_notes") or [],
        "is_blended": bool(l.get("is_blended")),
    } for l in m["lots"]]
    method_axes = {}
    for row in m.get("layout") or []:
        method = row.get("method")
        axis = row.get("axis")
        if not method or not axis:
            continue
        method_axes.setdefault(method, [])
        if axis not in method_axes[method]:
            method_axes[method].append(axis)
    return jsonify(_sanitize({
        "methods": m["methods"],
        "submethod_of_method": m["submethod_of_method"],
        "method_axes": method_axes,
        "lots": lots,
        "duplicates": m.get("duplicates", []),
        "blends": m.get("blend_records") or [],
        "totals": {
            "lot_count": len(lots),
            "total_qty_mt": sum(l["qty_mt"] for l in lots),
        },
    }))


@v3_bp.get("/master/chat/config")
def master_chat_config():
    config = master_overview_chat.get_chat_config()
    return jsonify({
        "configured": config["configured"],
        "model": config["model"],
        "languages": config["languages"],
    })


@v3_bp.post("/master/chat")
def master_chat():
    body = request.get_json(force=True, silent=True) or {}
    question = str(body.get("question", "")).strip()
    language = str(body.get("language", "english")).strip().lower()
    history = body.get("history") or []
    user_name = str(body.get("user_name", "")).strip()

    if not question:
        return jsonify({"error": "question is required"}), 400

    try:
        result = master_overview_chat.ask_master_overview(
            question,
            language=language,
            history=history,
            user_name=user_name,
        )
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503
    except Exception as e:  # pylint: disable=broad-except
        return jsonify({"error": f"master chat failed: {e}"}), 500


@v3_bp.post("/master/blend/preview")
def master_blend_preview():
    body = request.get_json(force=True, silent=True) or {}
    sources = body.get("sources") or []
    try:
        result = v3_master.compute_blend_preview(sources)
    except Exception as e:  # pylint: disable=broad-except
        return jsonify({"error": f"blend preview failed: {e}"}), 400
    return jsonify(_sanitize(result))


@v3_bp.post("/master/blend")
def master_blend_create():
    blocked = _reject_if_locked()
    if blocked: return blocked
    body = request.get_json(force=True, silent=True) or {}
    pin = str(body.get("pin", ""))
    if pin != PIN:
        return jsonify({"error": "invalid PIN"}), 403
    payload = body.get("payload") or {}
    user = str(body.get("user", "")) or "system"
    try:
        result = v3_master.create_blend(payload, user=user)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:  # pylint: disable=broad-except
        return jsonify({"error": f"blend create failed: {e}"}), 500
    return jsonify(_sanitize(result))


@v3_bp.get("/master/blend")
def master_blend_list():
    return jsonify(_sanitize(v3_master.read_blend_records()))


@v3_bp.get("/master/blend/<blend_id>/card.pdf")
def master_blend_card(blend_id):
    try:
        path = v3_master.get_blend_card_path(blend_id)
    except FileNotFoundError:
        return jsonify({"error": "blend not found"}), 404
    return send_file(path, as_attachment=True, download_name=f"blend-{blend_id}.pdf")


@v3_bp.get("/master/chat/reports/<report_id>/<fmt>")
def master_chat_report_download(report_id, fmt):
    try:
        path, filename = master_overview_reports.get_report_file(report_id, fmt)
    except FileNotFoundError:
        return jsonify({"error": "report not found"}), 404
    return send_file(path, as_attachment=True, download_name=filename)


@v3_bp.post("/match")
def match():
    blocked = _reject_if_locked()
    if blocked: return blocked
    body = request.get_json(force=True, silent=True) or {}
    cid = body.get("customer_id")
    qty = float(body.get("qty") or 0)
    required_tests = body.get("required_tests") or []
    grade_strict = bool(body.get("grade_strict", True))
    in_spec_only = bool(body.get("in_spec_only", True))

    cust = v3_coa.get_customer_effective(cid) if cid else None
    if not cust:
        return jsonify({"error": "customer not found"}), 404

    m = v3_master.parse_master()
    ranked = v3_match.rank_lots(
        m["lots"], cust,
        required_tests=required_tests,
        grade_strict=grade_strict,
        in_spec_only=in_spec_only,
    )

    # Auto-fulfill suggestion
    auto = v3_match.fulfill_exact(ranked, qty) if qty > 0 else []

    return jsonify(_sanitize({
        "customer": cust,
        "qty": qty,
        "ranked": ranked,
        "auto_fulfill": auto,
        "totals": {
            "candidates": len(ranked),
            "available_mt": sum(r["qty_mt"] for r in ranked),
        },
        "methods": m["methods"],
    }))


@v3_bp.post("/fulfill")
def fulfill():
    blocked = _reject_if_locked()
    if blocked: return blocked
    body = request.get_json(force=True, silent=True) or {}
    cid = body.get("customer_id") or ""
    user = body.get("user") or "operator"
    qty_requested = float(body.get("qty_requested") or 0)
    allocations = body.get("allocations") or []  # [{lot_id, lot_no, consume_mt}, ...]
    snapshot = body.get("snapshot") or {}  # {lot_id: {ranks, mass_tone, tint_tone, within, direction, ...}}
    if not allocations:
        return jsonify({"error": "no allocations"}), 400
    cust = v3_coa.get_customer_effective(cid)
    cust_name = (cust or {}).get("name") or cid
    result = v3_master.update_lot_qty(allocations, user=user, customer=cust_name)
    entry = v3_fulfillments.record_commit(
        user=user, customer_id=cid, customer_name=cust_name,
        qty_requested=qty_requested, write_result=result,
        snapshot_by_lot=snapshot,
    )
    return jsonify({"ok": True, "fulfillment": entry, **result})


@v3_bp.get("/fulfillments")
def fulfillments_list():
    return jsonify({"fulfillments": v3_fulfillments.list_all()})


@v3_bp.post("/fulfillments/<fid>/edit")
def fulfillments_edit(fid):
    blocked = _reject_if_locked()
    if blocked: return blocked
    body = request.get_json(force=True, silent=True) or {}
    user = body.get("user") or "operator"
    new_lines = body.get("lines") or []
    new_lots = body.get("new_lots") or []
    try:
        entry = v3_fulfillments.edit_fulfillment(fid, user=user, new_lines=new_lines, new_lots=new_lots)
        return jsonify({"ok": True, "fulfillment": entry})
    except PermissionError as e:
        return jsonify({"error": str(e)}), 403
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@v3_bp.post("/fulfillments/<fid>/cancel")
def fulfillments_cancel(fid):
    blocked = _reject_if_locked()
    if blocked: return blocked
    body = request.get_json(force=True, silent=True) or {}
    if str(body.get("pin", "")) != PIN:
        return jsonify({"error": "invalid pin"}), 403
    user = body.get("user") or "operator"
    try:
        result = v3_fulfillments.cancel_fulfillment(fid, user=user)
        return jsonify({"ok": True, **result})
    except PermissionError as e:
        return jsonify({"error": str(e)}), 403
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
