from __future__ import annotations

import os
import shutil
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parent
ROOT_DIR = BACKEND_DIR.parent
DATA_DIR = Path(os.getenv("DATA_DIR", str(BACKEND_DIR))).expanduser()
FRONTEND_BUILD_DIR = ROOT_DIR / "frontend" / "build"
FRONTEND_PUBLIC_DIR = ROOT_DIR / "frontend" / "public"

_SEED_FILES = (
    "Master.xlsx",
    "customer_coa.json",
    "customer_overrides.json",
    "fulfillments.json",
    "inventory_edit_dates.json",
    "inventory_audit.csv",
    "blend_records.json",
)
_SEED_DIRS = (
    "COA",
)
_RUNTIME_DIRS = (
    "generated_reports",
    "blend_cards",
    "backups",
    "tmp",
)


def ensure_data_layout() -> Path:
    if DATA_DIR == BACKEND_DIR:
        return DATA_DIR

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    for name in _SEED_FILES:
        src = BACKEND_DIR / name
        dest = DATA_DIR / name
        if src.exists() and not dest.exists():
            shutil.copy2(src, dest)

    for name in _SEED_DIRS:
        src = BACKEND_DIR / name
        dest = DATA_DIR / name
        if src.exists() and not dest.exists():
            shutil.copytree(src, dest)

    for name in _RUNTIME_DIRS:
        (DATA_DIR / name).mkdir(parents=True, exist_ok=True)

    return DATA_DIR


def master_edit_mode() -> str:
    mode = (os.getenv("MASTER_EDIT_MODE") or "auto").strip().lower()
    if mode in {"local-open", "download-upload", "hybrid"}:
        return mode
    if os.getenv("RENDER"):
        return "download-upload"
    return "hybrid"


def supports_local_master_open() -> bool:
    return master_edit_mode() in {"local-open", "hybrid"} and not bool(os.getenv("RENDER"))


ensure_data_layout()
