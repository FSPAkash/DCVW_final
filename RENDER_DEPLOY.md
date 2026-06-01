# Render Deploy Guide

## What changed

- The app can now run as one Render web service using `Dockerfile`.
- Mutable data can live on a Render persistent disk via `DATA_DIR=/var/data`.
- `Master.xlsx` no longer has to be edited through GitHub after deploy.
- The app now supports:
  - `Download Master`
  - edit locally in Excel
  - `Upload Edited Master`
  - automatic backup of the previous live workbook before replacement

## Recommended Render setup

1. Push this repo to GitHub.
2. In Render, choose `New +` -> `Blueprint`.
3. Point it at this repo so Render reads [render.yaml](/c:/Users/AkashPatil/DCW%20SIOP/render.yaml).
4. Confirm the web service settings:
   - Runtime: `Docker`
   - Health check path: `/api/health`
   - Persistent disk mount path: `/var/data`
   - Persistent disk size: `10 GB` or larger if you expect more PDFs/reports
5. Add or confirm environment variables:
   - `DATA_DIR=/var/data`
   - `MASTER_EDIT_MODE=download-upload`
   - `MASTER_OVERVIEW_OPENAI_API_KEY` if you want the master chat to work
   - `MASTER_OVERVIEW_OPENAI_MODEL=gpt-4o-mini` unless you want a different model
6. Deploy.

## First deploy behavior

- On first boot, the app seeds `/var/data` from the repo's current backend data.
- After that, the live workbook and JSON files come from the disk, not from GitHub.
- Future code deploys update the app code without overwriting the live disk data.

## How to edit Master after deploy

1. Open the app.
2. Go to `Master Overview`.
3. Click `Download Master`.
4. Edit the downloaded workbook in Excel.
5. Click `Upload Edited Master`.
6. Enter the supervisor PIN and upload the edited `.xlsx`.

Notes:

- The app creates a timestamped backup of the previous workbook before replacing it.
- This is the safest way to keep live inventory edits out of Git history.
- GitHub stays for code changes; the app UI handles data changes.

## After deploy

- Use Render `Manual Deploy` only for code changes.
- Do not expect edits inside the repo checkout to persist on Render.
- Use the in-app workbook upload flow for inventory/master changes.
