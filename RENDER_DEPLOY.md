# Render Free Deploy Guide

## What I changed

- [render.yaml](/c:/Users/AkashPatil/DCW%20SIOP/render.yaml) now targets Render `plan: free`.
- The paid persistent disk was removed.
- `DATA_DIR` now points at `/tmp/dcw-siop`, which works on free web services.
- A built-in keep-alive service now self-pings `/api/health` every 14 minutes.

This makes the app deployable on Render's free web service tier.

## Important reality check

Render free web services use an ephemeral filesystem.
That means:

- the app can deploy and run for free
- uploaded `Master.xlsx` changes can work during runtime
- but file changes are **not durable** across restarts, redeploys, or free-tier spin-down

So:

- `free Render` = good for demo, testing, and user review
- `paid Render + persistent disk` = needed for durable live workbook editing on Render itself

## Best free setup

Do this instead of `Blueprint`, because Render may still push you toward billing screens during that flow.

1. Push the repo to GitHub.
2. In Render, click `New +`.
3. Choose `Web Service`, not `Blueprint`.
4. Connect the GitHub repo.
5. Use these settings:
   - Runtime: `Docker`
   - Instance Type: `Free`
   - Dockerfile Path: `./Dockerfile`
   - Docker Context: `.`
   - Health Check Path: `/api/health`
6. Add these environment variables:
   - `DATA_DIR=/tmp/dcw-siop`
   - `MASTER_EDIT_MODE=download-upload`
   - `MASTER_OVERVIEW_OPENAI_MODEL=gpt-4o-mini`
   - `MASTER_OVERVIEW_OPENAI_API_KEY=...` only if you want the AI master chat enabled
   - `RENDER_EXTERNAL_URL=https://your-app-name.onrender.com`
7. Deploy.

## Keep-alive setup

This repo now includes a non-GitHub-Actions keep-alive service.

- It runs inside the Flask app process.
- It waits 60 seconds after boot, then calls `GET /api/health` on your public Render URL every 14 minutes.
- It only enables itself when Render is detected and `RENDER_EXTERNAL_URL` is set.

What you need to do in Render:

1. Open your web service.
2. Go to `Environment`.
3. Add `RENDER_EXTERNAL_URL` and set it to your live Render URL.
   - Example: `https://dcvw-final.onrender.com`
4. Save changes and redeploy once.

What success looks like in Render logs:

- `Keep-alive service initialized`
- `Keep-alive service thread started`
- `Keep-alive ping successful at ...`

Important limitation:

- this is a best-effort warm-keepalive for Render free
- it avoids GitHub Actions and external cron services
- if the app process crashes, the keep-alive thread dies with it until Render restarts the service

## If you still want to use `render.yaml`

The file is now free-safe:

- plan is explicitly `free`
- no persistent disk is requested

So if Render allows Blueprint creation in your workspace without billing prompts, this repo config should no longer request a paid service.

## What will still work on free

- frontend + backend in one service
- login
- matching
- viewing master data
- testing the upload/download workflow
- demoing the app with current repo-seeded data

## What will not be durable on free

- uploaded `Master.xlsx` replacements
- fulfillment history written to local JSON
- local report/output files
- override files written at runtime

Those can disappear after:

- a redeploy
- a restart
- Render free idle spin-down

## If you need both free deploy and durable data

Render free alone is not enough for this app's current file-based storage model.
The next real options are:

1. Keep Render free and move mutable state to an external store like Supabase, Neon, S3, or GitHub API.
2. Stay on Render and use a paid persistent disk.

If you want, I can do the next step and refactor the mutable workbook/history storage so the app keeps free hosting while persisting edits outside Render.
