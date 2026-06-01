# 🎯 LinkedIn Recruiter Intelligence — MVP

Capture recruiter profiles + their **active hiring posts** (the specific jobs they're working on) directly from LinkedIn while you browse.

## ✨ Features (v0.3.0)

- ✅ **Floating "Save Profile" button** on every LinkedIn profile page
- ✅ Extracts profile data: name, headline, location, current company, about
- ✅ ⭐ **Hiring posts extraction** — the specific jobs the recruiter is actively working on
- ✅ **Bulk Mode** — paste many URLs or upload a CSV
- ✅ 🔗 **n8n Integration** — pull URLs from a webhook, auto-POST results when bulk completes
- ✅ Local storage — all data saved in your browser
- ✅ Search/filter saved profiles
- ✅ Export to JSON or CSV
- ✅ No bot detection — uses your real LinkedIn session

## 🔗 n8n Integration

Open the **🔗 n8n** tab in the popup:

| Field | Purpose |
|-------|---------|
| **Pull URLs Webhook (GET)** | n8n endpoint that returns pending LinkedIn URLs |
| **Results Webhook (POST)** | n8n endpoint that receives scraped data |
| **API Key** | Optional — sent as `Authorization: Bearer <key>` |
| **Auto-send** | When checked, results POST automatically after each bulk run |

**Accepted Pull payload shapes:**
```json
["https://linkedin.com/in/foo", ...]
[ { "Profile URL": "..." }, ... ]
{ "urls": [...] }
{ "data": [...] }
```

**Result payload (sent to your n8n webhook):**
```json
{
  "source": "linkedin-recruiter-extension",
  "version": "0.3.0",
  "timestamp": "2026-...",
  "run": { "saved": N, "skipped": N, "total": N },
  "profiles": [ ... ],
  "csv": { "jobs": "...", "profiles": "..." }
}
```

## 🚀 Installation (5 minutes)

### Step 1: Open Chrome Extensions Page

1. Open Chrome
2. Type in URL bar: `chrome://extensions/`
3. Press Enter

### Step 2: Enable Developer Mode

- Top right corner pe **"Developer mode"** toggle ON karo

### Step 3: Load the Extension

1. Click **"Load unpacked"** button (top left)
2. Browse to: `C:\Users\User\Downloads\linkedin-recruiter-extension`
3. Click **"Select Folder"**

### Step 4: Pin the Extension (Optional but recommended)

1. Click the puzzle piece icon (top right of Chrome)
2. Find **"LinkedIn Recruiter Intelligence"**
3. Click the pin icon to keep it visible

✅ **Done!** Extension installed.

---

## 📖 How to Use

### 1. Login to LinkedIn

- Go to https://www.linkedin.com/
- Login normally (use any account — yours, dummy, doesn't matter)

### 2. Visit Any Profile

- Open any LinkedIn profile (e.g. `https://www.linkedin.com/in/SOMEONE`)
- Wait 1-2 seconds for the page to fully load
- You'll see a **blue floating "📥 Save Profile" button** at bottom-right

### 3. Click "Save Profile"

- Click the button
- Extension extracts everything in ~2-3 seconds:
  - Profile data
  - **Hiring posts** (if recruiter has any active jobs)
- Button turns green: "✅ Saved! 5 jobs found"

### 4. View Saved Profiles

- Click the extension icon (top right of Chrome)
- See all saved profiles in popup
- Search, filter, copy, or delete individual profiles
- Export everything as JSON or CSV

---

## 🔍 What Data Gets Captured?

For each profile:

```json
{
  "scrapedAt": "2026-05-02T11:30:00Z",
  "profileUrl": "https://www.linkedin.com/in/michalgolgowski",
  "publicIdentifier": "michalgolgowski",

  "fullName": "Michał Gołgowski",
  "firstName": "Michał",
  "lastName": "Gołgowski",
  "headline": "Talent Acquisition Specialist EMEA",
  "location": "Greater Munich Metropolitan Area, Germany",
  "about": "...",
  "profilePic": "https://media.licdn.com/...",

  "currentCompany": "Sungrow Europe",
  "currentCompanyUrl": "https://www.linkedin.com/company/sungroweurope/",
  "currentJobTitle": "Talent Acquisition Specialist EMEA",

  "followers": "1.2K",
  "connections": "500+",

  "hasHiringBadge": true,
  "isOpenToWork": false,
  "isVerified": false,

  "hiringPosts": [
    {
      "jobId": "4267891234",
      "title": "Field Service Engineer - Belgium",
      "company": "Sungrow Europe",
      "location": "Liège (On-site)",
      "postedAt": "4 months ago",
      "jobUrl": "https://www.linkedin.com/jobs/view/4267891234"
    },
    {
      "jobId": "4267891235",
      "title": "PV & ESS Key Account Manager - Benelux",
      "location": "Amsterdam (On-site)",
      ...
    }
    // ... up to 5-10 jobs the recruiter is actively hiring for
  ],
  "hiringPostsCount": 5
}
```

---

## 🛠️ How It Works (Technical)

1. **Content Script** (`content.js`) — Runs on every LinkedIn profile page
2. **Data Extraction** — Two methods combined:
   - **Voyager API JSON** (hidden in page's `<code>` tags) — most reliable
   - **DOM scraping** — fallback for visible elements
3. **Hiring Posts** — When recruiter has active jobs, extension reads them from:
   - Pre-loaded JSON in page source (most cases)
   - Or auto-clicks "Show jobs" modal and extracts from there
4. **Storage** — Chrome's local storage (yours, encrypted, never sent anywhere)
5. **No Bot Detection** — LinkedIn sees normal user activity (you logged in, you're browsing)

---

## ⚠️ Limitations (MVP)

- **Manual save**: You have to click the button on each profile (auto-mode coming in V2)
- **One profile at a time**: No bulk URL upload yet (V2 feature)
- **Local only**: Data lives in YOUR browser. To sync across devices, you need backend (V2)
- **No cloud dashboard**: Extension popup is the UI (V2 will have web dashboard)
- **Relies on LinkedIn UI**: If LinkedIn major change ho jaye, selectors update karne padenge

---

## 🐛 Troubleshooting

### Button nahi dikh raha?

1. Refresh the LinkedIn page (Ctrl+F5)
2. Check Chrome DevTools console for errors (F12)
3. Make sure extension is enabled at `chrome://extensions/`

### "Save" pe error aata hai?

1. Try on a different profile (some profiles have stricter access)
2. Make sure you're logged in to LinkedIn
3. Check console (F12) for specific error message

### Hiring posts capture nahi ho rahi?

- Profile pe **"Hiring: ... & N others"** badge hona zaroori hai
- If profile owner hasn't enabled #HIRING badge, no hiring posts will show
- Some profiles may need you to click "Show jobs" once manually first

### Data kahan store hota hai?

- Chrome's local storage (`chrome.storage.local`)
- Path: `%LocalAppData%\Google\Chrome\User Data\Default\Local Storage\...`
- Cleared if you uninstall extension

---

## 🚧 Roadmap (Coming in V2)

- [ ] **Auto-capture mode** — automatically save every profile you visit
- [ ] **Bulk URL upload** — paste 500 LinkedIn URLs, extension visits all
- [ ] **Cloud sync** — backend API to sync across devices/team
- [ ] **Web dashboard** — view/analyze captured data outside Chrome
- [ ] **Wikipedia + jobs enrichment** — integrate with our Apify scraper
- [ ] **Google Sheets sync** — auto-export to Sheets
- [ ] **Team mode** — shared database for whole team
- [ ] **AI analysis** — summarize hiring patterns, suggest leads

---

## 📞 Need Help?

If something breaks, check:
1. Chrome console (F12 → Console tab) — paste errors here
2. Extension's background page console (chrome://extensions/ → "service worker" link)

---

**Built for AsadUllah — LinkedIn Recruiter Intelligence v0.18.7 · ⚡ Speed Optimized**
