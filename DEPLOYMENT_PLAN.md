# DCW SIOP — Production Deployment Plan

## Constraints (client-mandated)

- **Master.xlsx** and **COA folder** live on the **user's local machine**, inside a folder named `FS - SIOP` (e.g. `C:\FS - SIOP\Master.xlsx`, `C:\FS - SIOP\COA\...`).
- These files must **never leave the user's machine**.
- The app is delivered as a web app (hosted on Render or similar).
- Multiple users may use the app, each with their own local `FS - SIOP` folder.

## What this means

A pure web app (HTML/JS in a browser tab fetching from a remote Flask backend) **cannot** read a user's local filesystem without explicit per-session permission. The current code reads `Master.xlsx` from the backend's working directory — that model assumes the file is on the **server**, not the user. This must change.

## Architecture decision

Three options to expose local files to the web app:

### Option A — File System Access API (browser-native)
- User clicks "Choose FS - SIOP folder" once.
- Browser remembers the handle in IndexedDB.
- React app reads `Master.xlsx` + COA PDFs directly via `showDirectoryPicker()` → reads file bytes → uploads to backend OR processes client-side.
- **Pros:** no installer, pure web.
- **Cons:** Chrome/Edge only (no Firefox, no Safari). User must re-grant if they clear browser data.

### Option B — Local helper agent (recommended)
- Small Python sidecar binary the user installs once (`fs-siop-agent.exe`).
- Agent watches `C:\FS - SIOP\`, exposes a tiny HTTP server on `localhost:5174`.
- Web app calls `http://localhost:5174/master`, `http://localhost:5174/coa/<id>`.
- Hosted backend on Render handles: auth, fulfillments ledger, audit, multi-user state. Talks to the helper via the **user's browser** (browser proxies the local request, agent never exposed to internet).
- **Pros:** works in any browser, autoscans the folder, no per-session re-grant, can handle writes back to `Master.xlsx`.
- **Cons:** installer to maintain. Requires the agent to be running.

### Option C — Desktop app (Electron / Tauri)
- Wrap the React frontend in Electron or Tauri.
- Native filesystem access, no browser limits.
- **Pros:** best UX, full control.
- **Cons:** no longer a web app. Auto-update infrastructure required. Larger install.

**Recommendation: Option B.** Aligns with current Flask backend, supports all browsers, gives autoscan + write-back to local `Master.xlsx` without sacrificing the web-app delivery model. Option A is a fallback for users who refuse to install anything.

## Split of responsibilities

```
User's PC                          Render (cloud)
─────────                          ──────────────
FS - SIOP/                         Flask backend
  Master.xlsx        ◄──────┐      ├─ /api/v3/login
  COA/                      │      ├─ /api/v3/fulfillments  (ledger)
    customer_a.pdf    HTTP  │      ├─ /api/v3/match         (proxies to agent)
    ...               on    │      └─ /api/v3/audit
                      :5174 │
fs-siop-agent.exe    ◄──────┤      Postgres
  ├─ /master                │      ├─ users
  ├─ /coa/<id>              │      ├─ fulfillments
  ├─ /master/update    (write back)├─ fulfillment_edits
  └─ /coa/rescan            │      ├─ customer_overrides
                            │      └─ inventory_audit
React app (browser)         │
  ├─ Calls localhost:5174 ──┘  (Master, COA reads)
  └─ Calls render backend       (auth, ledger writes)
```

Master.xlsx and COA PDFs **never leave the user's PC**. Only derived data (parsed lot stats, fulfillment lines, audit entries) goes to Render Postgres.

## Migration phases

### Phase 1 — Stabilize current backend on Render (this week)
Goal: get current code production-running before refactor, with server-side Master.xlsx as temporary state. Buys time for Phase 2.

1. **Env-driven data dir.** In `v3_master.py` and `v3_fulfillments.py`:
   ```python
   BASE_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent))
   ```
   Default to current behavior locally; on Render set `DATA_DIR=/data`.

2. **Render Persistent Disk.** Add a 1GB disk mounted at `/data`. Cost ~$1/mo.

3. **One worker, one instance.** `gunicorn app:app --workers 1 --threads 4`. Prevents Excel + JSON write races.

4. **File locks** around mutating writes:
   ```python
   import portalocker
   with portalocker.Lock(str(LEDGER_FILE) + ".lock", timeout=10):
       LEDGER_FILE.write_text(...)
   ```
   Same around `wb.save(MASTER_FILE)`.

5. **Seed `/data`** with current `Master.xlsx` + `fulfillments.json` via Render shell on first deploy.

6. **Backup cron.** Render Cron Job nightly: `tar czf /tmp/backup.tgz /data && aws s3 cp /tmp/backup.tgz s3://...`. (Or Backblaze B2 — cheaper.)

7. **Environment variables.**
   - `DATA_DIR=/data`
   - `FLASK_ENV=production`
   - `SECRET_KEY=<random>`
   - DB URL once Phase 2 lands.

### Phase 2 — Postgres for ledger + multi-user state (next 2 weeks)
Goal: kill the JSON file race, enable concurrent users, audit becomes query-able. Master.xlsx still server-side temporarily.

1. **Render Postgres** free tier (1GB). Add `DATABASE_URL` env var.

2. **Schema:**
   ```sql
   CREATE TABLE users (
     username TEXT PRIMARY KEY,
     password_hash TEXT NOT NULL,
     type TEXT NOT NULL,
     name TEXT
   );

   CREATE TABLE fulfillments (
     id TEXT PRIMARY KEY,
     ts TIMESTAMPTZ NOT NULL,
     user_name TEXT NOT NULL,
     customer_id TEXT NOT NULL,
     customer_name TEXT,
     qty_requested NUMERIC NOT NULL,
     lines JSONB NOT NULL,
     edited_at TIMESTAMPTZ
   );

   CREATE TABLE fulfillment_edits (
     id BIGSERIAL PRIMARY KEY,
     fulfillment_id TEXT NOT NULL REFERENCES fulfillments(id),
     ts TIMESTAMPTZ NOT NULL,
     user_name TEXT NOT NULL,
     rewinds JSONB,
     applied JSONB,
     appended_lots JSONB,
     previous_lines JSONB
   );

   CREATE TABLE customer_overrides (
     customer_id TEXT PRIMARY KEY,
     patch JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL
   );

   CREATE TABLE inventory_audit (
     id BIGSERIAL PRIMARY KEY,
     ts TIMESTAMPTZ NOT NULL,
     user_name TEXT,
     customer TEXT,
     lot_id TEXT NOT NULL,
     lot_no TEXT,
     col_letter TEXT,
     prev_qty NUMERIC,
     consume_mt NUMERIC,
     new_qty NUMERIC
   );

   CREATE TABLE inventory_edit_dates (
     lot_id TEXT PRIMARY KEY,
     edited_on DATE NOT NULL
   );
   ```

3. **Rewrite** `v3_fulfillments.py` storage from JSON to SQL (psycopg or SQLAlchemy). Atomic `BEGIN ... COMMIT` around edit operations replaces file locking.

4. **Drop** `fulfillments.json`, `inventory_audit.csv`, `inventory_edit_dates.json`, `customer_overrides.json` from disk. They become tables.

5. **Can now run multiple workers.** Gunicorn back to `--workers 3`.

### Phase 3 — Move Master.xlsx + COA to user's PC via local agent (next month)
Goal: meet client mandate. Files leave the server entirely.

1. **Build `fs-siop-agent`** (Python, packaged with PyInstaller into a Windows .exe):
   - Reads `%USERPROFILE%\FS - SIOP\` by default; configurable.
   - Exposes `http://127.0.0.1:5174` only on loopback.
   - Endpoints:
     - `GET /health` → version + folder path
     - `GET /master` → parsed master JSON (same shape as current `/api/v3/master`)
     - `POST /master/update` → apply consume deductions, rewrite `Master.xlsx`
     - `GET /coa/list` → list customers
     - `GET /coa/<id>` → parsed COA JSON
     - `POST /coa/rescan` → re-scan folder
   - Watches folder with `watchdog`; invalidates cache on file change.
   - CORS: `Access-Control-Allow-Origin: https://your-render-domain.com` (locked to the hosted app).
   - Auth: shared secret header, generated on install, written to a config file the user copies into the web app once.

2. **Frontend changes:**
   - On login, ask the user to enter their agent URL + token (default `http://localhost:5174` + token from agent's config).
   - Save in `localStorage` per user.
   - Replace all `/api/v3/master`, `/api/v3/match`, `/api/v3/customers`, `/api/v3/fulfill` calls that touch Master/COA → call the **agent** for the Master + COA reads, then call **Render** for ledger writes.
   - The fulfill commit becomes a two-step:
     1. Render writes the fulfillment row to Postgres (source of truth for ledger).
     2. Frontend posts the same deductions to agent's `/master/update`, agent rewrites local `Master.xlsx`.
     3. If step 2 fails (agent offline), Render marks the fulfillment `pending_local_sync`; on next login when agent reachable, the frontend replays pending updates.

3. **Backend `v3_master.py` and `v3_coa.py`** become **stateless on the server** — they no longer touch Master.xlsx. The matching logic (`v3_match.py`) runs on Render but is fed lot data from the agent via the frontend (frontend POSTs the lots+coa to `/api/v3/match`). OR move matching into the agent too — debatable. Server-side keeps the compute on Render and the IP off the user's PC.

4. **Installer.** Sign the .exe (DigiCert or similar, ~$200/yr) or ship unsigned with install instructions. Auto-update via a simple GitHub releases check.

5. **Multi-PC users.** Each user installs the agent on their PC. Ledger is shared (Postgres). Master.xlsx is per-PC — but the **same file** is what the team coordinates around outside the app. If two users edit the same `Master.xlsx` (one on each PC), the app cannot reconcile. This needs a client conversation:
   - **Option:** designate one "master PC" whose `FS - SIOP` is the source. Other users read-only.
   - **Option:** sync `FS - SIOP` via OneDrive / Dropbox / a network share. The agent watches whichever path.
   - **Option:** only one user has write permission; others see snapshot.

### Phase 4 — Hardening
- Replace plaintext PINs and password dict in `v3_api.py` with bcrypt + DB.
- HTTPS everywhere. Render is HTTPS by default; the local agent stays HTTP on loopback (safe).
- Rate-limit auth.
- Sentry for errors (free tier).
- Structured logs.
- Add `ETag`/`If-Modified-Since` on `/master` so the agent doesn't reparse 2000-row Excel on every refresh.

## Open questions for the client

1. **Who edits `Master.xlsx` outside the app?** Determines whether multi-PC sync is required.
2. **One user or many?** If many, do they share one `FS - SIOP` (network share) or each their own?
3. **Browser?** Locking down to Chrome+Edge unlocks Option A as a backup if agent install is rejected.
4. **OS?** Windows-only or also Mac/Linux? Affects installer.
5. **Acceptable for the COA PDFs to be sent to Render for parsing once, then discarded server-side?** Or must parsing happen entirely on the user's PC (parsing moves to agent → more agent code)?

## Cost estimate (Render)

| Item | Phase | Monthly |
|------|-------|---------|
| Web service (Starter) | 1 | $7 |
| Persistent disk 1GB | 1 | $1 |
| Postgres (free 1GB) | 2 | $0 |
| Postgres (Starter 1GB) once free trial ends | 2 | $7 |
| Cron job | 1 | $0 (included) |
| S3/B2 backup storage | 1 | <$1 |
| Code-signing cert (optional) | 3 | $17 (~$200/yr) |
| **Total active** |  | **~$15–25/mo** |

## Immediate next step

Implement **Phase 1** today/tomorrow. It's <100 lines of changes and unblocks a production deploy without committing to the full local-agent design yet. Phase 2 and 3 follow once the client confirms the open questions above.
