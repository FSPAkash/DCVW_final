# Electron Private Deployment Research

Last verified: 2026-05-28

## Scope

This document answers four practical questions for this project:

1. Can this project be turned into an Electron desktop app?
2. What is the cheapest reliable way to distribute and update it for one client with up to 4 Windows installs?
3. Can the app be disabled for non-payment and after more than 72 hours offline?
4. What current costs, licensing constraints, and implementation risks need to be accounted for?

This writeup is based on:

- The current repository state as of 2026-05-28.
- Official Electron, Microsoft, Cloudflare, OpenAI, PyInstaller, and upstream project sources listed in the appendix.

## Executive Summary

Yes, this project is a strong Electron candidate.

The best-fit deployment for this client is:

- Windows-only Electron app
- Bundled local Python backend
- MSIX packaging
- Distribution and auto-updates via `.appinstaller`
- Update files hosted on the client's network share or internal file share
- Self-signed code-signing certificate deployed by client IT to trusted stores
- A small remote license service that issues short-lived leases
- App lock if subscription is inactive
- App lock if no successful lease refresh occurs for more than 72 hours

For this specific client setup, the ongoing cash cost can remain effectively **$0/month** if:

- You do not use the Microsoft Store
- You do not buy a public code-signing certificate
- You let client IT trust your self-signed certificate
- You use the client's own share for update hosting
- You keep the subscription service on a free tier such as Cloudflare Workers + D1

The two biggest non-obvious risks are:

- **Concurrent writes to shared files**: the current repo checks whether Excel itself is holding `Master.xlsx`, but it does not yet implement strong cross-process locking for app-to-app writes to `Master.xlsx`, `fulfillments.json`, and other side files.
- **PDF/OCR licensing**: bundling Tesseract is commercially workable, but bundling Poppler binaries appears to raise GPL obligations and needs a legal review before release.

If you keep the optional AI chat feature, the app will no longer be truly zero-cost because the current backend includes OpenAI API usage. That feature can remain optional or be removed. (Source: [R-Chat], [OAI-Pricing])

## What The Project Looks Like Today

The current repo already behaves much more like a desktop/local app than a cloud-only web app:

- The frontend is a React app in [`frontend`](frontend) with API calls to a local backend. (Source: [R-Frontend])
- The backend is Flask in [`backend/app.py`](backend/app.py). (Source: [R-Backend])
- The backend expects a local `Master.xlsx` file via [`backend/v3_master.py`](backend/v3_master.py). (Source: [R-Master])
- The backend expects a local `COA` folder via [`backend/v3_coa.py`](backend/v3_coa.py). (Source: [R-COA])
- The backend already opens `Master.xlsx` directly on the host machine with `os.startfile(...)` in [`backend/v3_api.py`](backend/v3_api.py). (Source: [R-OpenMaster])
- The app already detects when Excel has locked `Master.xlsx` and exposes that lock status through the API. (Source: [R-ExcelLock])
- The project writes inventory state and logs to shared files such as `fulfillments.json`, `inventory_audit.csv`, `customer_overrides.json`, and `inventory_edit_dates.json`. (Source: [R-Ledger], [R-Audit], [R-Overrides])
- The current backend saves workbook changes directly with `wb.save(...)`, but there is no explicit cross-process file lock around those save operations. (Source: [R-MasterSave], [R-FulfillmentSave])
- The current repo has an optional OpenAI-powered chat feature in [`backend/master_overview_chat.py`](backend/master_overview_chat.py). (Source: [R-Chat])

This means Electron is not forcing an unnatural architecture onto the project. It mostly formalizes what the app is already doing:

- Local UI
- Local file access
- Local Python backend
- Optional cloud calls for licensing and AI features

## Is Electron Feasible?

Yes.

For this project, Electron is feasible for both product fit and technical fit:

- Electron is designed for packaging desktop apps with web frontends.
- The current app already has a clean React frontend plus Flask backend split.
- The app needs filesystem access to `Master.xlsx` and the `COA` folder on the client environment.
- Electron can package the renderer UI and spawn a bundled Python backend process locally.

Microsoft's current guidance explicitly supports packaging Electron apps as MSIX, and notes that Electron Forge can be used directly in that workflow. (Source: [W-Electron-MSIX])

Microsoft's MSIX containerization docs also state that **full trust** packaged apps run like standard desktop apps and can still access most system resources directly. That matters here because this app needs access to a shared drive, local Excel files, and locally bundled binaries. (Source: [W-MSIX-Container])

## Recommended Architecture For This Client

### Recommended end state

Use this stack:

- Electron app for UI, app lifecycle, licensing, and update coordination
- Bundled Python backend for Excel parsing/writes and COA parsing
- Shared UNC/network path for `Master.xlsx` and `COA`
- MSIX package for installation and updates
- `.appinstaller` manifest for updates
- Self-signed signing certificate trusted by client IT
- Small hosted license API for subscription status and 72-hour lease enforcement

### Why this is the best fit

This option is the best fit because:

- It matches the repo's current local-file assumptions.
- It avoids browser file access restrictions.
- It avoids paying for a public code-signing certificate.
- It avoids needing the Microsoft Store.
- It works well with a client-managed Windows environment.
- It lets you keep updates simple and mostly infrastructure-free.

### Practical runtime layout

```text
Client PC
  Electron shell
    -> React renderer
    -> main process
    -> bundled Python backend child process

Shared drive / network share
  -> Master.xlsx
  -> COA\
  -> optional update share:
     -> AppName.appinstaller
     -> AppName-1.0.0.msix
     -> AppName-1.0.1.msix

Your hosted service
  -> /license/lease
  -> /license/heartbeat
  -> /license/revoke
```

### Important packaging note

The app package itself should be treated as immutable. All client data should stay outside the package, on the shared drive or in user data directories. This lines up well with MSIX's update model, where app binaries are read-only and updates replace the package cleanly. (Source: [W-MSIX-Container])

## Distribution And Update Options

## Option A - Recommended

### MSIX + `.appinstaller` + client network share

This is the recommended path for this client.

Why it fits:

- Microsoft says App Installer can download and update apps from the **web, a network share, or a local file share**, and supports `https`, `http`, and `smb`. (Source: [W-AppInstaller-Overview])
- Microsoft says App Installer can be configured to check for updates on launch, hide prompts, and even **block app launch until the latest update is installed**. (Source: [W-AppInstaller-Auto])
- For internal enterprise deployment, Microsoft explicitly supports **self-signed certificates** when IT deploys trust via Group Policy or Intune. (Source: [W-CodeSigning], [W-Distribution])

How it would work:

1. Build a new `.msix` package.
2. Sign it with your self-signed certificate.
3. Replace or update the `.appinstaller` file on the network share.
4. On next launch, client machines check the `.appinstaller` file and update automatically.

Why this is cheaper than Electron's own updater:

- No external update server is required.
- No R2/S3 bucket is required.
- No public code-signing certificate is required.
- No app store is required.

What client IT must do once:

- Install your signing root certificate into trusted certificate stores on the 4 machines.
- Ensure App Installer is available on those machines.
- Ensure the users can reach the network share hosting the `.appinstaller` and `.msix` files.

Cost:

- Cash cost: **$0**
- Internal IT effort: **required**

## Option B - Good fallback

### MSIX + `.appinstaller` + HTTPS hosting

If you do not want to depend on the client's network share for update distribution, you can host the `.appinstaller` file and the `.msix` file over HTTPS instead.

This still keeps the basic Windows update flow the same, but moves the update artifacts to your own hosted endpoint. Microsoft documents this as a supported path. (Source: [W-AppInstaller-Overview], [W-Distribution], [W-Electron-MSIX])

For your scale, Cloudflare R2 is a realistic free option:

- 10 GB-month free storage
- 1 million Class A operations per month free
- 10 million Class B operations per month free
- no Internet egress charges for R2 storage classes

(Source: [CF-R2])

At 4 installs, this is likely still free if:

- You keep only a few current builds
- Your package size is not unusually large
- You are not pushing updates constantly

This option is still more moving parts than Option A, so it is a fallback, not the recommendation.

## Option C - Possible but usually unnecessary here

### Electron `autoUpdater`

Electron's current docs support serverless/static update flows and say `autoUpdater` can point to static release metadata in cloud object storage. (Source: [E-Updates])

Electron's current `autoUpdater` docs also say:

- MSIX packages use the MSIX updater
- direct MSIX file links are supported
- JSON update feeds are supported

(Source: [E-AutoUpdater])

So yes, you *can* use Electron-managed OTA updates for this app.

However, for this client, App Installer is usually simpler than maintaining your own in-app updater because:

- Windows already knows how to install and update MSIX packages
- App Installer already supports update-on-launch
- App Installer can block activation until updated
- client IT is available to manage trust and rollout

Recommendation:

- Prefer **Windows App Installer updates**
- Use Electron `autoUpdater` only if you have a strong reason to keep update logic inside the app

## Option D - Technically possible, not recommended for this client

### Microsoft Store

Microsoft is now making Store onboarding cheaper than before:

- Microsoft Learn says Store MSIX signing is free because Microsoft re-signs the package after certification. (Source: [W-CodeSigning])
- Microsoft's Windows Developer Blog says the company onboarding fee was removed on 2026-05-07. (Source: [W-Store-Free])

But the Store is still not the best fit here because:

- this is a private client-specific app
- there are only 4 installs
- client IT is already cooperating
- the client already has a shared-drive workflow

You do not need Store discovery, Store trust, or Store merchandising.

## Current Cost Breakdown

## Recommended path cost table

| Item | Current pricing / status | Needed for recommended path? | Notes |
| --- | --- | --- | --- |
| Electron | $0 | Yes | Electron is MIT-licensed. (Source: [E-License]) |
| Electron Forge | $0 | Yes | Forge is MIT-licensed. (Source: [Forge-License]) |
| PyInstaller | $0 | Yes | Commercial bundling is allowed under PyInstaller's license exception. (Source: [PyI-License]) |
| MSIX packaging tooling | $0 | Yes | Microsoft documents Electron-to-MSIX packaging paths. (Source: [W-Electron-MSIX]) |
| Self-signed code-signing certificate | $0 | Yes | Viable because client IT can trust it on managed endpoints. (Source: [W-CodeSigning], [W-Cert]) |
| Microsoft Store account | Free for company accounts as of 2026-05-07 | No | Optional path only. (Source: [W-Store-Free]) |
| Azure Artifact Signing | About $9.99/month | No | Only needed if you want public trust outside managed IT environments. (Source: [W-CodeSigning], [W-ArtifactSigning]) |
| Traditional OV certificate | Typically $150-300/year | No | Not needed if client IT trusts your cert. (Source: [W-CodeSigning]) |
| EV certificate | $400+/year | No | Microsoft says EV is no longer recommended solely for SmartScreen bypass. (Source: [W-CodeSigning]) |
| Update hosting on client network share | $0 cash | Yes | Best fit for this client if the share is stable. (Source: [W-AppInstaller-Overview]) |
| Update hosting on Cloudflare R2 | Free tier available | No | Good fallback if you want off-network hosting. (Source: [CF-R2]) |
| License API on Cloudflare Workers | Free tier available | Yes, if hosted remotely | 100,000 requests/day on free plan. (Source: [CF-Workers]) |
| License state in Cloudflare D1 | Free tier available | Yes, if hosted remotely | 5M reads/day, 100k writes/day, 5 GB free. (Source: [CF-D1]) |
| OpenAI API for optional chat feature | Usage-based, not free | Optional | Current repo uses OpenAI for chat if configured. (Source: [R-Chat], [OAI-Pricing]) |

### Bottom line

For the recommended path:

- **Minimum practical cash cost: $0**
- **Likely ongoing cash cost: $0**
- **First unavoidable paid item only appears if you want public trust or public distribution**

## Cloudflare Free-Tier Fit For This Client

If you host licensing remotely, your scale is tiny.

Example:

- 4 devices
- lease refresh every 6 hours
- 4 refreshes/day/device
- 16 refreshes/day total

Even if you refresh every hour:

- 4 devices x 24 = 96 requests/day

That is tiny compared with Workers Free at 100,000 requests/day. (Source: [CF-Workers])

If every refresh performs:

- 1 read from D1
- 1 write to D1

Then 96 requests/day would mean approximately:

- 96 reads/day
- 96 writes/day

That is trivial compared with D1 Free:

- 5 million rows read/day
- 100,000 rows written/day
- 5 GB storage

(Source: [CF-D1])

Conclusion:

- Cloudflare Workers + D1 is more than enough for the subscription/lease service at this scale.

## OpenAI Cost Note

The current repo includes an optional OpenAI-backed chat feature in [`backend/master_overview_chat.py`](backend/master_overview_chat.py), and its current default model string is `gpt-4o-mini`. (Source: [R-Chat])

OpenAI's current pricing page lists `gpt-4o-mini` at:

- $0.15 / 1M input tokens
- $0.075 / 1M cached input tokens
- $0.60 / 1M output tokens

(Source: [OAI-Pricing])

This means:

- The desktop packaging itself can stay free
- The app as a product is **not fully free to run** if the OpenAI chat feature is enabled and used

If you want a strict zero-cost deployment:

- disable the AI chat feature, or
- hide it behind a separate paid/usage-controlled setting

## Licensing And Open-Source Compliance Notes

This section is not legal advice. It is a technical licensing flag list for follow-up with counsel or the client's compliance team.

### Electron

Electron is MIT-licensed. (Source: [E-License])

### Electron Forge

Electron Forge is MIT-licensed. (Source: [Forge-License])

### PyInstaller

PyInstaller explicitly says you may use it to bundle commercial applications and ship the resulting executable bundles under your own license, subject to dependency licenses. (Source: [PyI-License])

### Tesseract

Tesseract is available under Apache 2.0 and is generally commercially workable to redistribute. (Source: [Tesseract-License])

### Poppler

This is the biggest packaging compliance flag in the current stack.

The current repo searches for `pdfinfo.exe` and `pdftoppm.exe`, which are Poppler tools, from locations such as `Program Files` and `LOCALAPPDATA`. (Source: [R-COA])

The Poppler upstream `COPYING` file says the project is licensed under **GNU GPL v2.0 or later**. (Source: [Poppler-License])

Why this matters:

- If you bundle Poppler binaries in a commercial desktop app installer, GPL obligations may be triggered.
- If you do not bundle them and instead require separate client installation, the legal analysis may change, but it still needs review.

Recommendation:

- Treat Poppler as a release blocker until licensing strategy is explicitly approved.
- Either:
  - get legal sign-off on redistributing Poppler with your app, or
  - redesign the OCR/PDF flow to avoid bundling Poppler binaries

## Shared Drive Implications

The client's shared-drive setup is actually a good fit in one important way:

- all 4 installs can read and write against the same `Master.xlsx`
- all 4 installs can read the same `COA` folder
- this creates a single source of truth

But it also introduces the main operational risk:

- multiple app instances can attempt to write at the same time

### What the repo already does

The repo already checks whether Excel itself has locked `Master.xlsx`, and exposes that lock state through the backend. (Source: [R-ExcelLock])

That is helpful, but it only solves one class of conflict:

- human editing in Excel

It does **not** fully solve:

- app instance A and app instance B both saving workbook changes at nearly the same time
- app instance A writing `fulfillments.json` while app instance B also writes it

### Current concurrency gaps in this repo

The repo currently:

- writes `Master.xlsx` directly via `wb.save(...)` in [`backend/v3_master.py`](backend/v3_master.py) and [`backend/v3_fulfillments.py`](backend/v3_fulfillments.py)
- stores ledger state in [`backend/fulfillments.json`](backend/fulfillments.json)
- stores audit data in [`backend/inventory_audit.csv`](backend/inventory_audit.csv)
- stores edit dates and overrides in JSON side files

There is no explicit cross-process file lock around these writes in the current code. (Source: [R-MasterSave], [R-FulfillmentSave], [R-Ledger])

### Recommendation for 4-machine shared-drive use

For this client size, you probably do **not** need a cloud database just to solve concurrency.

You **do** need strong local/shared-drive write coordination:

1. Add a real cross-process file lock around every write to `Master.xlsx`.
2. Add a real cross-process file lock around every write to `fulfillments.json`, `inventory_audit.csv`, `inventory_edit_dates.json`, and `customer_overrides.json`.
3. Ensure each write path re-reads fresh state inside the lock before saving.
4. If the lock cannot be acquired quickly, show a "system busy, retrying" message instead of saving optimistically.
5. Keep the Excel lock check, but treat it as only one part of the solution.

If usage grows later, a small central service or database can be introduced. For 4 seats on one shared drive, proper locking is likely enough.

## Subscription Enforcement And 72-Hour Offline Lock

Yes, this can be done.

The cleanest design is **server-authoritative lease validation**.

### Recommended model

The hosted licensing service should be the source of truth for:

- customer subscription active/inactive
- allowed device IDs
- optional minimum required app version
- lease expiration

The app should never treat locally stored license data as permanent truth. Local data is only a cached lease.

### Recommended lease payload

At minimum:

```json
{
  "customer_id": "dcw-client-001",
  "device_id": "machine-guid-or-generated-device-id",
  "status": "active",
  "issued_at": "2026-05-28T08:00:00Z",
  "expires_at": "2026-05-31T08:00:00Z",
  "min_app_version": "1.0.0"
}
```

The payload should be signed by the server so the client can detect tampering.

### Recommended enforcement flow

1. On app start, Electron main process requests a fresh lease.
2. If the server says subscription is inactive, the app shows a lock screen and does not start the backend.
3. If the lease is valid, Electron stores it encrypted locally and starts the backend.
4. While running, Electron refreshes the lease on a schedule.
5. If refresh fails continuously and the cached lease becomes older than 72 hours, the app locks.
6. If the server returns a higher `min_app_version`, the app can force an update before normal use.

### Where to store the cached lease

Electron's `safeStorage` API is the right local storage primitive for this cache:

- Electron recommends the async `encryptStringAsync` / `decryptStringAsync` APIs
- on Windows, keys are protected through DPAPI

(Source: [E-SafeStorage])

Important limitation:

- `safeStorage` helps protect local data at rest
- it is not a substitute for server-side licensing logic

### Where enforcement should live

Do not enforce licensing only in the React UI.

Recommended enforcement points:

- Electron **main process** is the primary gatekeeper
- the bundled Python backend only starts when the lease is valid
- backend write operations should reject requests if the Electron session token is invalid or expired

This matters because hiding buttons in React is easy to bypass on a compromised local machine.

### Suggested refresh cadence

Given the "normally online" assumption:

- refresh every 1 to 6 hours
- lease validity window: 72 hours

Practical recommendation:

- refresh every 6 hours
- expire after 72 hours without successful refresh

This creates:

- normal low traffic
- enough resilience for short outages
- reliable disable behavior for unpaid clients or disconnected installs

## Update Policy And License Policy Should Work Together

For this project, updates and licensing should be separate but coordinated.

Recommended rules:

- App Installer handles package updates.
- License service decides whether the app may be used.
- Lease payload may include `min_app_version`.
- If current app version is below `min_app_version`, block normal use and require update.

This gives you two control levers:

- commercial control: active subscription required
- operational control: minimum version required

Microsoft's App Installer update model also supports blocking activation until the latest update is installed. (Source: [W-AppInstaller-Auto])

## Security Notes Specific To Electron

The packaging and licensing choices above do not remove the need for normal Electron security hygiene.

Electron currently recommends:

- load only secure content
- do not enable Node integration for remote content
- enable context isolation
- enable renderer sandboxing
- define a restrictive CSP
- validate IPC senders

(Source: [E-Security], [E-ContextIsolation])

Important repo-specific implication:

- if you ever load remote web content inside the desktop app, do not expose broad IPC or Node APIs to it

Electron's context isolation docs explicitly warn that simply exposing raw IPC methods is unsafe; they recommend one method per approved IPC action. (Source: [E-ContextIsolation])

## What You Would Need To Build

This is the practical build checklist for the recommended path.

### Packaging and app shell

- Add an Electron main process and preload layer
- Build the React frontend into static assets and load them locally
- Bundle the Flask backend as a local executable or managed Python runtime
- Start the backend as a child process from Electron main

### Data path and shared-drive config

- Add a config screen or admin setting for the shared `FS - SIOP` path
- Store the configured UNC path outside the app package
- Validate access to `Master.xlsx` and `COA` at startup

### Update pipeline

- Package the app as `.msix`
- Create and maintain an `.appinstaller` file
- Host the `.msix` and `.appinstaller` files on the client's share
- Configure update-on-launch behavior

### Signing

- Create a self-signed certificate for package signing
- Export the certificate for IT deployment
- Sign every released MSIX with the same trusted publisher identity

### Shared-drive safety

- Add cross-process write locking for workbook and JSON/CSV side files
- Add retry logic and user-facing "busy" states
- Keep the existing Excel lock detection

### Licensing

- Generate stable device IDs
- Build lease endpoint
- Encrypt cached lease locally with `safeStorage`
- Enforce startup lock and 72-hour offline lock
- Add device revoke and customer deactivate tools

### Optional AI feature decision

- Either keep the OpenAI chat feature and accept usage-based API cost
- Or disable/remove it to keep runtime cost at zero

### OCR/PDF compliance decision

- Resolve Poppler redistribution strategy before packaging

## Recommended Decision

For this client, the best decision is:

- Build a **Windows-only Electron app**
- Package it as **MSIX**
- Distribute it privately with **`.appinstaller` from the client's network share**
- Sign it with a **self-signed certificate trusted by client IT**
- Use a tiny hosted **license lease service**
- Lock the app immediately for inactive subscriptions
- Lock the app after **72 hours without a successful lease refresh**
- Add **real cross-process file locking** before rollout
- Resolve **Poppler licensing** before bundling OCR/PDF binaries

This path has the best balance of:

- lowest cost
- simplest rollout
- best fit for the repo
- strongest control over updates and subscription enforcement

## Sources Used In This Document

Checked on: 2026-05-28 unless otherwise noted.

### Official external sources

- **[E-Updates]** Electron, "Updating Applications"  
  https://www.electronjs.org/docs/latest/tutorial/updates

- **[E-AutoUpdater]** Electron, "`autoUpdater`"  
  https://www.electronjs.org/docs/latest/api/auto-updater

- **[E-SafeStorage]** Electron, "`safeStorage`"  
  https://www.electronjs.org/docs/latest/api/safe-storage

- **[E-ContextIsolation]** Electron, "Context Isolation"  
  https://www.electronjs.org/docs/latest/tutorial/context-isolation

- **[E-Security]** Electron, "Security"  
  https://www.electronjs.org/docs/latest/tutorial/security/

- **[E-License]** Electron license (MIT)  
  https://github.com/electron/electron/blob/main/LICENSE

- **[Forge-License]** Electron Forge license (MIT)  
  https://github.com/electron/forge/blob/main/LICENSE

- **[PyI-License]** PyInstaller license and commercial-use exception  
  https://pyinstaller.org/en/stable/license.html

- **[W-Electron-MSIX]** Microsoft Learn, "Packaging Your Electron App for Distribution"  
  https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/guides/electron-packaging

- **[W-CodeSigning]** Microsoft Learn, "Code signing options for Windows app developers"  
  https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options

- **[W-ArtifactSigning]** Microsoft Learn, "Change an Artifact Signing account SKU (pricing tier)"  
  https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku

- **[W-Distribution]** Microsoft Learn, "Choose a distribution path for your Windows app"  
  https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path

- **[W-Cert]** Microsoft Learn, "Create a certificate for package signing"  
  https://learn.microsoft.com/en-us/windows/msix/package/create-certificate-package-signing

- **[W-AppInstaller-Overview]** Microsoft Learn, "App Installer file overview"  
  https://learn.microsoft.com/en-us/windows/msix/app-installer/app-installer-file-overview

- **[W-AppInstaller-Auto]** Microsoft Learn, "Auto-update and repair apps"  
  https://learn.microsoft.com/en-us/windows/msix/app-installer/auto-update-and-repair--overview

- **[W-AppInstaller-Create]** Microsoft Learn, "Create an App Installer file manually"  
  https://learn.microsoft.com/en-us/windows/msix/app-installer/how-to-create-appinstaller-file

- **[W-MSIX-Container]** Microsoft Learn, "MSIX containerization overview"  
  https://learn.microsoft.com/en-us/windows/msix/msix-containerization-overview

- **[W-Store-Free]** Windows Developer Blog, "Publish to Microsoft Store as a company-now with free registration and faster onboarding"  
  https://blogs.windows.com/windowsdeveloper/2026/05/07/publish-to-microsoft-store-as-a-company-now-with-free-registration-and-faster-onboarding/

- **[CF-Workers]** Cloudflare Workers pricing  
  https://developers.cloudflare.com/workers/platform/pricing/

- **[CF-D1]** Cloudflare D1 pricing  
  https://developers.cloudflare.com/d1/platform/pricing/

- **[CF-R2]** Cloudflare R2 pricing  
  https://developers.cloudflare.com/r2/pricing/

- **[OAI-Pricing]** OpenAI API pricing  
  https://platform.openai.com/docs/pricing/

- **[Tesseract-License]** Tesseract upstream license  
  https://github.com/tesseract-ocr/tesseract/blob/main/LICENSE

- **[Poppler-License]** Poppler upstream `COPYING`  
  https://gitlab.com/freedesktop-sdk/mirrors/freedesktop/poppler/poppler/-/blob/master/COPYING

### Repository evidence used

- **[R-Frontend]** [`frontend/package.json`](frontend/package.json)
- **[R-Backend]** [`backend/app.py`](backend/app.py)
- **[R-Master]** [`backend/v3_master.py`](backend/v3_master.py)
- **[R-COA]** [`backend/v3_coa.py`](backend/v3_coa.py)
- **[R-OpenMaster]** [`backend/v3_api.py`](backend/v3_api.py)
- **[R-ExcelLock]** [`backend/v3_api.py`](backend/v3_api.py)
- **[R-Ledger]** [`backend/v3_fulfillments.py`](backend/v3_fulfillments.py)
- **[R-Audit]** [`backend/v3_master.py`](backend/v3_master.py)
- **[R-Overrides]** [`backend/v3_coa.py`](backend/v3_coa.py)
- **[R-MasterSave]** [`backend/v3_master.py`](backend/v3_master.py)
- **[R-FulfillmentSave]** [`backend/v3_fulfillments.py`](backend/v3_fulfillments.py)
- **[R-Chat]** [`backend/master_overview_chat.py`](backend/master_overview_chat.py)
