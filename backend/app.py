"""
V3-only Flask backend entrypoint.
"""

from __future__ import annotations

from pathlib import Path

from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS

try:
    from dotenv import load_dotenv
except Exception:  # pylint: disable=broad-except
    load_dotenv = None

import runtime_paths
runtime_paths.ensure_data_layout()

from v3_api import v3_bp


BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parent
FRONTEND_BUILD_DIR = runtime_paths.FRONTEND_BUILD_DIR


def create_app() -> Flask:
    if load_dotenv is not None:
        load_dotenv(ROOT_DIR / ".env")
        load_dotenv(BASE_DIR / ".env")

    # Disable Flask's default /static handler so React build assets under
    # frontend/build/static are served by our catch-all route instead.
    app = Flask(__name__, static_folder=None)
    app.secret_key = "dcw-siop-v3-2026"
    CORS(app, supports_credentials=True)
    app.register_blueprint(v3_bp)

    @app.get("/")
    def index():
        index_file = FRONTEND_BUILD_DIR / "index.html"
        if index_file.exists():
            return send_from_directory(FRONTEND_BUILD_DIR, "index.html")
        return jsonify({
            "app": "dcw-siop-v3",
            "version": 3,
            "status": "ok",
        })

    @app.get("/api/health")
    def health():
        return jsonify({"ok": True, "app": "dcw-siop-v3"})

    @app.get("/<path:path>")
    def frontend(path: str):
        asset = FRONTEND_BUILD_DIR / path
        if asset.exists() and asset.is_file():
            return send_from_directory(FRONTEND_BUILD_DIR, path)
        if Path(path).suffix:
            return jsonify({"error": "asset not found", "path": path}), 404
        index_file = FRONTEND_BUILD_DIR / "index.html"
        if index_file.exists():
            return send_from_directory(FRONTEND_BUILD_DIR, "index.html")
        return jsonify({"error": "frontend build not found", "path": path}), 404

    return app


app = create_app()


if __name__ == "__main__":
    app.run(debug=True, port=5000)
