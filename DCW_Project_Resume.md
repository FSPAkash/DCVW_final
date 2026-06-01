# DCW SIOP — Project Resume

**Role:** Sole developer and product owner
**Stack:** Python 3 / Flask, Pandas, NumPy, scikit-learn, openpyxl, pdfplumber, pytesseract, ReportLab, OpenAI API, React (CRA), JavaScript (ES6+), HTML5/CSS3
**Domain:** Pigment manufacturing — Sales, Inventory & Operations Planning (SIOP) for a factory-floor color matching workflow at DCW (iron-oxide pigment plant)
**Scope:** Two end-to-end builds. V1 shipped a standard-first allocation tool replacing a legacy pigment/order prototype. V3 is a customer-COA-first rewrite that drives the live Master.xlsx inventory ledger, with Excel coexistence (file-lock arbitration), multi-method color matching, blending, and a domain-grounded LLM advisor.

---

## Project Summary

Designed and shipped a production-grade internal web application that lets a factory-floor operator pick a customer (whose latest COA is OCR-parsed from a PDF folder) and instantly see which inventory lots in `Master.xlsx` best satisfy the open demand, ranked by a blended Euclidean + Cosine + Scaled-Euclidean color-distance score with FIFO age tiebreaker, full in-spec/out-of-spec tiering, direction-of-deviation matching, tinting-strength weighting, partial allocation, and an editable fulfillment ledger. Added: a customer COA override console with PIN guard, a blending workbench (mix multiple in-stock lots into a new on-spec lot, with PDF blend cards), a Master overview dashboard (low-stock, depletion, duplicate-lot, recent-edit reports with PDF/XLSX export), and a multilingual GPT advisor grounded on a live Master.xlsx snapshot. Owned the full stack: Flask blueprint, Master.xlsx parser/writer with Excel-lock arbitration, COA OCR pipeline, blending and fulfillment engines, React dashboard, auth, deployment.

---

## V3 Technical Contributions (current product)

### Backend — Flask blueprint and Master.xlsx engine

- Rewrote the backend as a thin Flask entrypoint ([backend/app.py](backend/app.py), 53 LOC) registering a single blueprint, [backend/v3_api.py](backend/v3_api.py) (454 LOC).
- Replaced the legacy CSV pipeline with a live Master.xlsx ledger as the single source of truth. [backend/v3_master.py](backend/v3_master.py) (556 LOC) parses the `proposed ` sheet — grade row, lot-number row, qty row, and rows 9–55 of method blocks (Method I a / I b / II, axes DL/Da/Db/DE/Strength) — pivots columns into per-lot records, and writes back qty mutations atomically. Maintains an audit row (row 61 "Last edited"), an external `inventory_edit_dates.json`, and an append-only [backend/inventory_audit.csv](backend/inventory_audit.csv).
- Built Excel-coexistence locking: detects Excel's `~$Master.xlsx` sidecar lock file, parses the locker's username from its binary header, and exposes `GET /api/v3/master/lock`. All write endpoints (`/match`, `/fulfill`, `/master/blend`, `/fulfillments/*/edit|cancel`) call `_reject_if_locked()` and 409 with the lock owner so the UI can flip into read-only mode. `POST /api/v3/master/open` shells `os.startfile` to launch Excel for in-place edits.
- Built the v3 matching engine ([backend/v3_match.py](backend/v3_match.py), 460 LOC):
  - 6-D color vector `[MT_DL, MT_Da, MT_Db, RT_DL, RT_Da, RT_Db]` + optional 7th dim `w_str * (Strength − COA_mid) / COA_halfwidth` (`w_str = 0.5`).
  - Three distance signals: Euclidean, Cosine (dropped when ‖target‖ < 0.1), and Scaled-Euclidean via `StandardScaler` fit on the candidate pool.
  - Per-signal robust z-score, then weighted blend (`euclid : cosine : knn : age = 1 : 1 : 1 : 0.5`, renormalized when cosine drops). Lower = better; magnitude (not just rank) survives, so rank gaps are interpretable.
  - FIFO age signal: within each grade, ordinal-rank by (Excel column, numeric lot_no) — older lots score lower (preferred), so equal color matches deplete oldest stock first.
  - Per-axis direction-of-deviation check (sign agreement vs COA target on axes with `|COA Δ| ≥ 0.05`); used as a hard tier.
  - Hard tier ordering (in-spec + dir OK > in-spec + dir mismatch > out-of-spec + dir OK > out-of-spec + dir mismatch); blended score only reorders within a tier.
  - Greedy `fulfill_exact()` with two-pass allocation: exhaust non-super lots before dipping into "super" lots (lots carrying >2 test methods — these are scarce, kept in reserve unless needed).
- Built the COA OCR pipeline ([backend/v3_coa.py](backend/v3_coa.py), 532 LOC):
  - Walks `backend/COA/<customer-folder>/*.pdf`, parses each with pdfplumber, falls back to `pdf2image` + `pytesseract` for scanned PDFs, with auto-discovery of the Tesseract binary across standard Windows install paths.
  - Regex-extracts grade, std, lot, report/mfg date, PO, product, chemical class, delivery condition, colour index, mass-tone and tint-tone DL/Da/Db/DE with `_lo`/`_hi`/`DE_max` bands, plus tinting strength + band.
  - Per-customer override file ([backend/customer_overrides.json](backend/customer_overrides.json)) with PIN-gated `POST /customer/<id>/override` so a lab tech can correct an OCR miss without re-running the parse.
  - Caches scan output to [backend/customer_coa.json](backend/customer_coa.json) (2773 lines); `POST /api/v3/coa/rescan` rebuilds.
- Built the fulfillment ledger ([backend/v3_fulfillments.py](backend/v3_fulfillments.py), 352 LOC): append-only `fulfillments.json` with newest-first ordering, a 24-hour edit window, and atomic edit/cancel that rewinds previous Master.xlsx deductions and re-applies new allocations. Each commit captures a snapshot of the lot's ranks/spec/direction at commit time so the edit UI works even after the lot is depleted.
- Built blending ([backend/v3_master.py](backend/v3_master.py) `compute_blend_preview` / `create_blend`):
  - `POST /api/v3/master/blend/preview` computes the weighted-average MT/RT/DE/Strength of N source lots without writing.
  - `POST /api/v3/master/blend` commits: deducts source qty from Master.xlsx, appends a new lot column with averaged blocks, generates a ReportLab PDF blend card under [backend/blend_cards/](backend/blend_cards/), and records the lineage in [backend/blend_records.json](backend/blend_records.json).
  - `GET /api/v3/master/blend/<id>/card.pdf` streams the card.
- Built the Master overview LLM advisor ([backend/master_overview_chat.py](backend/master_overview_chat.py), 548 LOC):
  - Builds a structured snapshot (active lots, low-stock, depleted, grade rollups, blend records, edit timeline) from a live `parse_master()` call. Cached on `(mtime, size)` of Master/edit-dates/blend files so reads are free until inventory actually changes.
  - English, Hinglish (Latin-script only), and Tamil response modes via system prompt directives.
  - Strict grounding: model is forbidden to invent lots/quantities; absent data must be acknowledged. History trimmed to last 6 messages / 1200 chars.
  - OpenAI client read from env (`MASTER_OVERVIEW_OPENAI_*` with fallback to `OPENAI_*`). Configurable model, defaults to `gpt-4o-mini`.
- Built report generation ([backend/master_overview_reports.py](backend/master_overview_reports.py), 521 LOC): question-driven spec detection ("lowest stock", "recent edits", "duplicate lot codes"), then materializes a paired PDF (ReportLab, iron-oxide accent palette, partner logo header) and XLSX (openpyxl) under [backend/generated_reports/](backend/generated_reports/). Files are served by `GET /api/v3/master/chat/reports/<id>/<fmt>`.
- Endpoints shipped (all under `/api/v3`):
  - Auth: `POST /login` (in-memory user table — Akash/Anirudh/Sanjay/Sushant/Naina/admin).
  - Customers: `GET /customers`, `POST /coa/rescan`, `GET /customer/<id>`, `POST /customer/<id>/override`, `POST /customer/<id>/override/clear`, `POST /verify_pin`.
  - Master: `GET /master`, `GET /master/lock`, `POST /master/open`.
  - Match/fulfill: `POST /match`, `POST /fulfill`, `GET /fulfillments`, `POST /fulfillments/<id>/edit`, `POST /fulfillments/<id>/cancel`.
  - Blend: `POST /master/blend/preview`, `POST /master/blend`, `GET /master/blend`, `GET /master/blend/<id>/card.pdf`.
  - Advisor: `GET /master/chat/config`, `POST /master/chat`, `GET /master/chat/reports/<id>/<fmt>`.

### Frontend — React Dashboard V3

- Consolidated the dashboard into [frontend/src/DashboardV3.jsx](frontend/src/DashboardV3.jsx) (3115 LOC) — single orchestrator, no state manager, hooks + lifted state. Old V1 components (`Dashboard.jsx`, `MatchingFlowTab.jsx`, `ResultsTabs.jsx`, `UpdateDataTab.jsx`, `Sidebar.jsx`, `ProductionPanel.jsx`, `Visualization3D.jsx`, `redesign.css`, `utils/allocation.js`) deleted.
- Shipped a four-tab `HomeScreen` (New fulfillment, Recent fulfillments, Blending, Master overview) with live customer search, COA mini-preview swatch, required-method chips, qty input, in-spec toggle, grade-strict toggle, and a ranked-results table that surfaces blended score, per-method Euclid/Cosine/KNN/Age ranks, spec banding with per-axis reasons, and direction-of-deviation indicators.
- Built `BlendingTab`: select N source lots (filter by grade, low stock first), Smart Blend recommender (auto-pick weights to minimize predicted ΔE), preview deltas, PIN-gated commit, downloadable PDF blend card.
- Built `MasterOverview`: stats tiles (lot count, total MT, low-stock count, depleted count), drill-down tables (Lowest stock, Recent edits, Depleted lots, Duplicate codes), each with a PDF/XLSX export menu wired to the report endpoint.
- Built `MasterOverviewChat` ("Anirudh") — embedded chat UI with language picker (English / Hinglish / Tamil), grounded-snapshot disclaimer, conversational follow-up, and inline downloadable reports when the question matches a report spec.
- Built fulfillment history with 24-hour edit-mode banner, lot swap, partial qty edits, and PIN-gated cancel.
- Built [frontend/src/Login.jsx](frontend/src/Login.jsx) + [frontend/src/auth.css](frontend/src/auth.css) — DCW-branded login with user/admin role differentiation.
- Built Excel-lock UX: polls `/master/lock` every few seconds; when locked, shows the locker name + lockout banner across the app, disables write actions, and re-enables on release. `Open in Excel` button calls `/master/open` for in-place edits.
- All v3 styling in [frontend/src/v3.css](frontend/src/v3.css) (3535 LOC), single iron-oxide palette, no left-edge color rails on cards (per design memory).

### Data Engineering

- Killed the stitched-CSV pipeline. `Master.xlsx` is now read on every request; mutations write back through openpyxl with the same lock contract Excel itself uses.
- Designed the COA folder convention (`backend/COA/<customer-name>/*.pdf`, one folder per customer, most-recent PDF wins by report date with mtime fallback).
- Built the blending lineage chain: every blended lot persists its source lot IDs, weights, and resulting MT/RT/DE/Strength so an auditor can trace a customer-shipped lot back to its constituents.
- Inventory edit timeline is dual-tracked: a row in the workbook for human readability and an external JSON for machine read of last-edit timestamps across the whole sheet.

### Correctness, Persistence, and Deployment

- Single-locker invariant: Excel and the Flask write path cannot both mutate Master.xlsx — every backend write goes through `_reject_if_locked()`, and Excel's lock file is the source of truth.
- Atomic fulfillment edits: a 24-hour reversible window with full rewind of previous deductions, validated by re-reading the sheet before re-applying.
- Snapshot-cached LLM grounding keyed on `(mtime, size)` of source files — no stale answers, no redundant rebuilds.
- NaN/Inf sanitization at the API boundary (`_sanitize`) so the React side never gets invalid JSON from numpy.
- Validated every backend change with `python -m py_compile` + endpoint smoke tests. Validated every frontend change with `npm run build`.
- Production prep: gunicorn in [backend/requirements.txt](backend/requirements.txt), env-driven `REACT_APP_API_URL`, `.gitignore` excludes venv and the lock sidecar.
- Investigated and documented Electron private-deployment path in [ELECTRON_PRIVATE_DEPLOYMENT_RESEARCH.md](ELECTRON_PRIVATE_DEPLOYMENT_RESEARCH.md) for on-prem packaging without exposing the Master.xlsx machine to the network.

---

## V1 Technical Contributions (predecessor, retired)

(Kept here because the iteration explains the V3 design choices.)

- Shipped the original Flask backend (single ~2275-LOC `app.py`, since deleted) serving five stitched CSV datasets with greedy allocation across three tolerance modes (`strict`, `relaxed`, `review`), three distance methods (Euclidean, Cosine, KNN), and consensus ordinal-rank ranking.
- Shipped the original React dashboard (`Dashboard.jsx`, `MatchingFlowTab.jsx`, `ResultsTabs.jsx`, `UpdateDataTab.jsx`, ~3100 LOC across components) with admin CSV upload, OCR invoice intake, and a 3-D LAB visualizer.
- Retired the entire V1 surface in the V3 rewrite (commit `a3ac310` "newest push") after the standard-first model proved structurally wrong — operators think in *customers* (each with a stable COA spec), not *standards*. The V3 customer-COA-first model directly mirrors how lab techs already work.

---

## Soft-Skill Contributions

### Product Ownership

- Reframed the problem twice: from *pigment-to-order matching* (V0 prototype) to *standard-first allocation* (V1) to *customer-COA-first allocation* (V3). Each reframe came from watching the operator's actual workflow, not from a spec.
- Designed Excel coexistence as a first-class feature instead of fighting it. The plant runs on Excel; making the app a respectful co-tenant of `Master.xlsx` (rather than asking the lab to abandon the file) is what got it adopted.
- Decided to keep blending in-app rather than punt to a separate workbook — a blend that produces a PDF card with full lineage is a real factory-floor artifact, not just a database row.

### Communication & Documentation

- Maintained design notes in repo ([ELECTRON_PRIVATE_DEPLOYMENT_RESEARCH.md](ELECTRON_PRIVATE_DEPLOYMENT_RESEARCH.md), DEPLOYMENT_PLAN.md, V1's CHANGELOG / DATA_FLOW / PERSISTENCE_FIX postmortems) so a second developer could pick up the system without pairing.
- Built the LLM advisor with a hard "never guess" rule, so the operator never gets a confident hallucination — if the data isn't in the snapshot, the model says so.

### Iteration & Feedback Loops

- Iterated the ranking algorithm three times: ordinal-consensus rank-sum (V1) → blended z-scored Euclidean + Cosine + KNN with FIFO age tiebreaker (V3 algo-update commit `e9646cb`). Rank-sum hid the magnitude of the gap between #1 and #2; z-score blending exposes it.
- Iterated the "is this lot good enough?" gate from a single ΔE threshold (V1 strict/relaxed/review) to a hard-tier system (spec × direction × strength) where blended score only re-orders within a tier — the operator sees in-spec lots first, always.
- Added the 24-hour edit window to fulfillments after observing that lab techs caught their own mistakes within minutes but had no way to fix them once committed.

### Quality Discipline

- No silent fallbacks: missing or malformed Master.xlsx raises a clear API error rather than serving sample data.
- Lock-then-write or fail loudly: every write path is gated by Excel's own lock contract; "the file was open in Excel" is a 409 with the locker's name, not a silent overwrite.
- Snapshot-cached, never speculatively cached: LLM context is rebuilt the moment the source file changes.

---

## Selected Outcomes

- Replaced a standard-first prototype with a customer-COA-first flow that matches how lab techs actually work.
- Cut operator decision time from "open three spreadsheets and eyeball ΔE" to "pick a customer, hit Match, fulfill from the top of the ranked list."
- Shipped Excel coexistence: the plant's existing Master.xlsx workflow is preserved; the app and Excel arbitrate writes via the same lock file.
- Shipped a blending workbench with auditable PDF lineage cards — the lab can mix lots in-app instead of in a side workbook.
- Shipped a domain-grounded multilingual advisor that answers stock questions in English, Hinglish, or Tamil and emits downloadable PDF/XLSX reports for the common queries.

---

## Tooling & Practices

Git (feature branches, clean commit history on `main`), openpyxl (read+write workbook arbitration), pdfplumber + pytesseract + pdf2image (OCR with vendored Tesseract auto-discovery), NumPy + scikit-learn (`StandardScaler`, robust z-score blending), ReportLab (branded PDF cards and reports), OpenAI API (grounded chat with snapshot caching), Flask blueprints, React (CRA) hooks-only state, `python -m py_compile`, `npm run build`, markdown-driven design docs, lock-file-as-contract, atomic write + reload pattern, per-request identity instead of session state.
