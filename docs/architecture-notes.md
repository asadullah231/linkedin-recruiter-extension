# LinkedIn Recruiter Intelligence — Client Presentation Notes

> Companion notes for `architecture-diagram.excalidraw.md`

## 🎯 The Problem

The client needs to:
- Identify recruiters posting jobs on LinkedIn
- Capture their hiring posts (active job openings)
- Get the data as a clean spreadsheet
- All without manual copy-paste from LinkedIn

## 🏗️ The 3-Stack Architecture

| Layer | Tool | Purpose |
|-------|------|---------|
| **Trigger** | Slack | Client uploads an Excel of LinkedIn URLs |
| **Orchestration** | n8n | Workflows route data between systems |
| **Storage** | NocoDB | Live queue, status tracking |
| **Browser** | Chrome Extension | Actually scrapes LinkedIn pages |
| **Intelligence** | OpenRouter (Gemini) | Picks the most senior role per recruiter |
| **Output** | Slack | Final XLSX delivered to original thread |

## 🔄 The 9 Steps (Flow)

### 1️⃣ Upload (Client → Slack)
Client drops `recruiters.xlsx` into a Slack channel.
The file has a column `Profile URL` with LinkedIn profile links.

### 2️⃣ Slack Triggers n8n WF1
Slack's `file_share` event hits `https://n8n.../webhook/upload-csv`.

### 3️⃣ WF1 Inserts to NocoDB
n8n:
- Downloads the file (Slack credentials)
- Parses the xlsx
- Inserts each row into NocoDB `scrape_queue` table
- Sets `status = 'pending'`
- Replies in Slack: "✅ 21 URLs queued"

### 4️⃣ Extension Auto-Pulls (every 30s)
The extension's background service worker fires `chrome.alarms` every 30 seconds:
- `GET /webhook/pull-urls` → n8n WF2
- WF2 fetches all `pending` rows from NocoDB
- Marks them `in_progress`
- Returns the URLs to the extension

### 5️⃣ Scraping (Extension ↔ LinkedIn)
For each URL:
- Extension opens a LinkedIn tab in background
- Uses the user's logged-in session (no proxy / no cookies file)
- Scrapes:
    - Profile metadata (name, headline, company, followers)
    - **Method 1**: Voyager API hidden data
    - **Method 2**: "Hiring" badge → modal → jobs
    - **Method 3**: Inline `/jobs/view/` links on page
    - **Method 4**: Activity / Recent posts (last 15)
- Deduplicates job IDs across methods
- Each job tagged with `source` field (hiring_badge, activity_post, inline)

### 6️⃣ AI Top-Job Ranking (Extension → OpenRouter)
After all profiles scraped:
- For each profile with multiple jobs, send job titles to OpenRouter
- Model: Gemini Flash 1.5 (fastest, ~$0.0005/profile)
- Prompt asks for index of MOST SENIOR role
- Tags chosen job with `isTopJob: true`
- Falls back gracefully if AI call fails (first job stays top)

### 7️⃣ Build XLSX (in browser, SheetJS)
The service worker bundles SheetJS (`xlsx.full.min.js`) and:
- Builds a flat list: 1 row per (profile × job)
- 15 columns: Profile URL, Full Name, First/Last, Job Title, Job URL, Location, Company, Headline, Source, Post URL, Is Top Job, Followers, Connections, Scraped At
- Writes to ArrayBuffer → Blob

### 8️⃣ POST to n8n WF3 (multipart/form-data)
- `file`: jobs-<timestamp>.xlsx (binary)
- `meta`: JSON with counts + profile URLs
- `profiles`: full raw profile JSON
- POSTed to `/webhook/scrape-results`

### 9️⃣ WF3 Relays to Slack + Marks Complete
n8n WF3:
- Parses `meta` to get `firstUrl`
- Looks up channel/thread from NocoDB (using `LinkedIn-Profile = firstUrl`)
- Uploads the XLSX file directly to Slack thread
- Fetches all `in_progress` rows
- Filters to URLs that came back from extension
- Marks each as `complete`
- Responds 200 OK to extension

## 🛡️ Reliability Features

- **Auto-pull skipped** when scrape is already running (no overlap)
- **Stop after current batch** option in extension (prevents infinite loops)
- **Emergency Stop** button on live status bar
- **Service worker re-arms** alarms after Chrome restart
- **Status indicator** (header pill + icon badge) — never wonder if it's running
- **AI fallback**: If OpenRouter fails for a profile, first job remains top job
- **Multipart fallback to JSON** if XLSX library doesn't load

## 📊 Per-Batch Performance

| Stage | Time | Notes |
|-------|------|-------|
| Slack → NocoDB | 2-3 sec | One-time webhook |
| Auto-pull poll | 30 sec max | First detection lag |
| Scrape per profile | 5-7 sec | With default 6s delay |
| AI ranking | 1-2 sec/profile | Skipped if 0-1 jobs |
| XLSX build | <500 ms | Service worker side |
| Multipart upload | 1-2 sec | Single shot |
| Slack file upload | 2-3 sec | Final delivery |

For a 21-profile batch: **~3 minutes end-to-end**.

## 🔐 Security Notes

- Client's LinkedIn session stays in their own Chrome (no cookie sharing)
- OpenRouter key stored in `chrome.storage.local` only — never committed
- n8n credentials stored in n8n's encrypted credential store
- All HTTPS

## 🎨 Why This Architecture?

1. **Slack = familiar trigger** — clients already use it daily.
2. **NocoDB = visible queue** — client can see live progress (pending → in_progress → complete) in a spreadsheet UI.
3. **Extension = real LinkedIn session** — bypasses LinkedIn bot detection entirely, since it IS the user's browser.
4. **n8n = no-code glue** — workflows are visual, easy to edit, easy to extend.
5. **AI in extension (not n8n)** — keeps each batch self-contained; falls back gracefully.
6. **XLSX in extension (not n8n)** — n8n becomes a thin relay; format owned by extension dev.

## 🔮 Future Extensions (Easy)

- Email column auto-guessed from name + company domain
- Slack reply with summary stats per batch
- AI department classification (Eng/Sales/HR/etc.)
- Salary estimates from title + location
- Rate-limit retries with exponential backoff
- Multi-client tenancy via `client_id` on each row
- Webhook for instant trigger (NocoDB → push notification on row insert)
