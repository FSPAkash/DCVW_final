"""
V3-only Flask backend entrypoint.
"""

from __future__ import annotations

from pathlib import Path

from flask import Flask, jsonify
from flask_cors import CORS

try:
    from dotenv import load_dotenv
except Exception:  # pylint: disable=broad-except
    load_dotenv = None

from v3_api import v3_bp


BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parent


def create_app() -> Flask:
    if load_dotenv is not None:
        load_dotenv(ROOT_DIR / ".env")
        load_dotenv(BASE_DIR / ".env")

    app = Flask(__name__)
    app.secret_key = "dcw-siop-v3-2026"
    CORS(app, supports_credentials=True)
    app.register_blueprint(v3_bp)

    @app.get("/")
    def index():
        return jsonify({
            "app": "dcw-siop-v3",
            "version": 3,
            "status": "ok",
        })

    @app.get("/api/health")
    def health():
        return jsonify({"ok": True, "app": "dcw-siop-v3"})

    return app


app = create_app()


if __name__ == "__main__":
    app.run(debug=True, port=5000)
