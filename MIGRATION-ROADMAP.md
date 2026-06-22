# LinkedIn Recruiter Intelligence — WXT Migration Roadmap

**Current Version:** v0.19.0 (Vanilla JS + Manifest V3)  
**Target:** WXT + TypeScript + React  
**Estimated Total Time:** 10–14 working days  

---

## Why Migrating?

| Problem (Now) | Solution (After) |
|---|---|
| `importScripts()` — legacy, no real modules | ES `import/export` — proper module system |
| No TypeScript — bugs at runtime | TypeScript — bugs caught at build time |
| 952KB XLSX loads on every SW start | `await import('xlsx')` — true lazy load |
| Manual extension reload on every change | Hot Module Replacement — auto reloads |
| 34KB popup.js — spaghetti vanilla JS | React components — clean state management |
| Hardcoded `manifest.json` | `wxt.config.ts` — auto-generates manifest |
| No circuit breaker typing | Typed interfaces for all scraping data |

---

## Milestone 0 — Setup & Baseline ✅ COMPLETE (Day 1)

**Goal:** WXT project structure ready, old code preserved, nothing broken.

### Tasks
- [x] Project folder `linkedin-recruiter-v2/` created with full src structure
- [x] Stack chosen: WXT 0.19.29 + TypeScript + React 18 + @wxt-dev/module-react
- [x] `icons/` and `lib/xlsx.full.min.js` copied to `public/`
- [x] `wxt.config.ts` configured with all permissions (storage, activeTab, scripting, tabs, notifications, alarms) and all host_permissions
- [x] Placeholder entrypoints created: `background.ts`, `content.ts`, `popup/App.tsx`
- [x] `npm install` — 465 packages installed, WXT 0.19.29 + Vite 6.4.3
- [x] `npm run build` — clean build in 1.1s, output in `.output/chrome-mv3/`
- [x] Generated `manifest.json` verified — all permissions match v0.19.0

### Build Output
```
.output/chrome-mv3/
  manifest.json        887 B
  popup.html           338 B
  background.js        704 B
  chunks/popup-*.js    144 KB  (React runtime)
  content-scripts/content.js   5.3 KB
Total: 151 KB (vs ~1.5 MB old project with XLSX bundled)
```

### Deliverable ✅
`linkedin-recruiter-v2/` loads in Chrome from `.output/chrome-mv3/`. Ready for Milestone 1.

---

## Milestone 1 — TypeScript Interfaces ✅ COMPLETE (Day 2)

**Goal:** Define typed contracts for all data structures before touching any logic.

### Tasks
- [x] Create `src/types/profile.ts`:
  ```ts
  export interface HiringPost {
    title: string;
    jobUrl?: string;
    postUrl?: string;
    location?: string;
    companyName?: string;
    source: 'hiring_badge' | 'activity_post' | 'job_board';
    isTopJob?: boolean;
    isClosed?: boolean;
  }

  export interface RecruiterProfile {
    profileUrl: string;
    fullName: string;
    firstName?: string;
    lastName?: string;
    headline?: string;
    currentCompany?: string;
    followers?: string;
    connections?: string;
    hiringPosts: HiringPost[];
    hiringPostsCount: number;
    scrapedAt: string;
    enriched?: boolean;
    topJob?: HiringPost;
    owner?: string;
    status?: 'complete' | 'complete_no_jobs' | 'error';
  }
  ```
- [x] Create `src/types/state.ts` (BulkState interface)
- [x] Create `src/types/settings.ts` (N8nSettings, AiSettings interfaces)
- [x] Create `src/types/n8n.ts` (webhook payload shapes)

### Deliverable ✅
All data contracts typed — no implementation yet, just types. `npx tsc --noEmit`
passes clean. Types derived from v0.19.0 source (bg-state.js, bg-n8n.js,
popup.js) so they match the real data shapes, including the v0.19.0 circuit-
breaker field `consecutiveErrors` on BulkState.

---

## Milestone 2 — Storage Layer ✅ COMPLETE (Day 3)

**Goal:** Replace `chrome.storage.local` raw calls with a typed storage module.

### Current Files
- `background/bg-storage.js` → `src/utils/storage.ts`

### Tasks
- [x] Create `src/utils/storage.ts` using WXT's `storage` composable:
  ```ts
  import { storage } from 'wxt/storage';
  import type { RecruiterProfile } from '../types/profile';

  export const profileStore = storage.defineItem<Record<string, RecruiterProfile>>(
    'local:profiles',
    { fallback: {} }
  );

  export async function saveProfile(profile: RecruiterProfile): Promise<void> { ... }
  export async function getAllProfiles(): Promise<RecruiterProfile[]> { ... }
  export async function deleteProfile(url: string): Promise<void> { ... }
  ```
- [x] Create `src/utils/settings.ts` for N8nSettings + AiSettings
- [ ] Write unit tests for storage functions (deferred to M8A — Vitest not yet set up)

### Deliverable ✅
Typed, testable storage layer — replaces raw `chrome.storage.local.get/set`.

**Notes**
- `storage.ts` — `profileStore` (`local:profiles`), `saveProfile` / `getAllProfiles`
  (newest-first) / `deleteProfile`, plus a `watchProfiles()` subscription for live
  popup refresh. Badge sync (`99+` cap, `#0a66c2`) preserved from bg-storage.js.
- `settings.ts` — `n8nSettingsStore` / `aiSettingsStore`, fixed endpoint URL
  constants, `getResolvedN8nSettings()` (merges URLs + normalises owner,
  `stopAfterBatch` always on), `updateN8nSettings` / `setAutoPull`,
  `getAiSettings` (default model `google/gemini-flash-1.5`) / `updateAiSettings`.
- Fixed a pre-existing config gap: added `"jsx": "react-jsx"` to `tsconfig.json`
  (WXT's generated tsconfig omitted it), so `npm run type-check` now passes clean.
- Verified: `npm run type-check` exit 0, `npm run build` exit 0 (151 KB output).

---

## Milestone 3 — Background Service Worker ✅ COMPLETE (Days 4–5)

**Goal:** Migrate all `bg-*.js` files to typed TypeScript ES modules.

### Current Files → New Files
```
background/bg-state.js    →  src/background/state.ts
background/bg-utils.js    →  src/background/utils.ts
background/bg-scrape.js   →  src/background/scraper.ts
background/bg-n8n.js      →  src/background/n8n.ts
background/bg-export.js   →  src/background/exporter.ts
background/bg-ai.js       →  src/background/ai.ts
background/bg-bulk.js     →  src/background/bulk.ts
background.js             →  src/entrypoints/background.ts
```

### Tasks

**Day 4 — Core modules**
- [x] `state.ts` — typed `BulkState`, `resetBulkState()` (mutates in place — see note)
- [x] `utils.ts` — `sleep()`, `shortUrl()`, `extractUrls()`, `bulkLog()`, `updateBadge()`
- [x] `scraper.ts` — `scrapeProfileInTab()`, `scrapeJobInTab()`, `waitForTabComplete()`
- [x] `n8n.ts` — `streamProfileToN8n()`, `sendBulkResultsToN8n()` with typed payloads

**Day 5 — Orchestration modules**
- [x] `exporter.ts` — `pickTopJob()` + `buildXlsxBlob()` with proper `await import('xlsx')`
- [x] `ai.ts` — `filterClosedJobs()`, `isJobClosed()`, `rankTopJobsWithAI()`, `callOpenRouterForTopJob()`
- [x] `bulk.ts` — `startBulkScrape()`, `runBulkQueue()` with circuit breaker
- [x] `background.ts` entrypoint — replaces `background.js` (message/alarm/install/startup listeners)

### Deliverable ✅
Full background service worker in TypeScript. All `importScripts()` gone.

**Notes**
- Added `src/types/messages.ts` — `RuntimeMessage` discriminated union + `BulkStateSnapshot`
  / `BulkProgressMessage`, so the message handler is fully typed.
- `bulkState` is now a single mutable object mutated in place by `resetBulkState()`.
  ES module imports are read-only bindings, so the old "reassign the global" pattern
  isn't possible — every module keeps a live reference to the same object instead.
- Reconciled `BulkLogEntry` to the real runtime shape `{ time, message, type }`
  (the M1 stub had guessed `{ timestamp, level, message }`).
- Fixed n8n endpoint URLs are sourced from `settings.ts` constants; the worker no
  longer persists `pullUrl`/`callbackUrl` into storage (they're code constants now).
- Verified: `npm run type-check` exit 0, `npm run build` exit 0. `background.js`
  went 704 B → **28.7 KB** (logic added) — XLSX is NOT bundled into the worker.
- XLSX lazy chunk: `buildXlsxBlob` is only reached via `sendBulkResultsToN8n`
  (manual "Send Now"), which nothing calls yet, so Vite currently tree-shakes the
  xlsx dynamic import out entirely. The separate chunk will emit once M5 wires the
  Export tab — the lazy-load architecture is correct.
- `job-scraper.js` injection path is kept as a string ref; the entrypoint that
  produces that file is built in M4.

---

## Milestone 4 — Content Scripts (Days 6–7)

**Goal:** Migrate `content.js` (67KB monolith) to split TypeScript modules.

### Note
The `content/` folder already has split files (`content-profile.js`, `content-jobs.js`, `content-ui.js`, `content-utils.js`). These become the TypeScript source files.

### Current Files → New Files
```
content/content-utils.js   →  src/utils/content-utils.ts
content/content-profile.js →  src/content/profile-extractor.ts
content/content-jobs.js    →  src/content/jobs-extractor.ts
content/content-ui.js      →  src/content/ui.ts
content.js (monolith)      →  src/entrypoints/content.ts (thin orchestrator)
job-scraper.js             →  src/entrypoints/job-scraper.ts
```

### Tasks

**Day 6 — Extractors**
- [x] `content-utils.ts` — `q`/`qq`/`sleep`, `extractPublicIdentifier()`, `extractPicUrl()`, `cleanName()`, `normalizeProfileName()`, `getLoggedInUserName()`
- [x] `profile-extractor.ts` — `extractProfileData()` (returns `ScrapedProfile`), `extractVoyagerData()`, `extractDomData()` + meta/title fallbacks
- [x] `jobs-extractor.ts` — `extractHiringPosts()` (returns `HiringPost[]`) + all 5 fallback methods, modal handling, `parseJobFromLink()`

**Day 7 — UI + Entrypoints**
- [x] `ui.ts` — `injectFloatingButton()`, button state machine (loading/success/error), `observeNavigation()`, `initContentScript()`
- [x] `content.ts` entrypoint — thin orchestrator (`initContentScript()`) + `import '../content/content.css'`
- [x] `job-scraper.ts` entrypoint — `defineUnlistedScript`, builds to `job-scraper.js`
- [ ] Manual test on live LinkedIn profiles — deferred to M7 QA (needs a logged-in browser)

### Deliverable ✅
Content scripts fully typed. Old `content.js` monolith retired.

**Notes**
- Verified the shipped `content.js` monolith and the `content/*.js` split files have
  an identical function set — the split files were a faithful decomposition, so they
  were used as the port basis.
- Extended the type contracts to match real extraction output: widened
  `HiringPost` (added `jobId`, `company`, `companyLinkedinUrl`, `postedAt`,
  `applicants`, nullable fields) and `HiringPostSource` (8 real source tags);
  added `src/types/extraction.ts` with `ScrapedProfile`, `VoyagerData`, `DomData`,
  `JobDetails`. `JobDetails` now flows through `scrapeJobInTab` / `pendingJobResolve`.
- `content.css` copied to `src/content/content.css` and imported by the entrypoint —
  WXT bundles it as the content script's `css` automatically.
- `job-scraper.js` added to `web_accessible_resources` so the background can inject it.
- Two deliberate, behaviour-neutral deviations: (1) `fullName` null (total extraction
  failure) is coerced to `''` at the extractor boundary to keep the canonical type
  non-null — downstream already does `fullName || 'Unknown'`; (2) the job-scraper
  message drops the unused `jobUrl`/`error` fields (background only reads `data`).
- Verified: `npm run type-check` exit 0, `npm run build` exit 0.
  Outputs: `content.js` 34.5 KB, `content.css` 1.47 KB, `job-scraper.js` 4.24 KB.
  Generated manifest correctly lists the content script (js+css) and WAR.

---

## Milestone 5 — Popup UI with React ✅ COMPLETE (Days 8–9)

**Goal:** Replace 34KB `popup.js` spaghetti with React components.

### Current Structure → New Structure
```
popup.html + popup.js + popup.css
         ↓
src/entrypoints/popup/
  index.html
  main.tsx
  App.tsx
  components/
    TabBar.tsx
    ProfilesTab.tsx      ← saved profiles list + delete
    ScrapeTab.tsx        ← n8n pull + bulk scrape controls
    ExportTab.tsx        ← CSV / XLSX export
    StatusPill.tsx       ← header status indicator
    BulkProgressBar.tsx  ← live scrape progress
    ProfileCard.tsx      ← individual profile display
  hooks/
    useProfiles.ts       ← getAllProfiles + polling
    useBulkState.ts      ← getBulkState + progress listener
    useN8nSettings.ts    ← settings load/save
```

### Tasks

**Day 8 — Shell + data hooks**
- [x] React entry point (`main.tsx` imports `popup.css`, `App.tsx` shell)
- [x] `useProfiles.ts` — loads via `getProfiles`, delete + clearAll, reloads
- [x] `useBulkState.ts` — seeds from `getBulkState`, listens for `bulkProgress`, polls every 2s
- [x] `useSettings.ts` — n8n owner/autoPull + AI settings via the M2 settings layer
- [x] `StatusPill.tsx` — header indicator (Idle / 🤖 Auto-pull ON / Scraping x/y)

**Day 9 — UI tabs**
- [x] `ProfilesTab.tsx` + `ProfileCard.tsx` — search, cards, hiring jobs, open/copy/delete, empty state
- [x] `N8nTab.tsx` — Team ID, Auto Mode banner+toggle, Test, delay/enrich, Pull, Start/Stop, queue, bulk progress, AI section, activity log, Send/Clear
- [x] `LiveStatusBar.tsx` — across-tabs amber scraping bar + STOP
- [x] Reused `popup.css` verbatim (imported in `main.tsx`) for pixel parity
- [ ] Manual interaction test in Chrome — deferred to M7 QA (needs loaded extension)

### Deliverable ✅
Full popup rebuilt in React. Visual appearance identical to v0.19.0.

**Notes**
- The real v0.19.0 popup has **2 tabs (Saved | n8n)**, not the 3-tab Profiles/Scrape/Export
  the roadmap sketched. Matched the real UI; there is no separate Export tab — CSV
  builders live in `lib/csv.ts` and feed the n8n tab's "Send Saved Profiles Now".
- Component split: `components/` (StatusPill, LiveStatusBar, ProfilesTab, ProfileCard,
  N8nTab), `hooks/` (useProfiles, useBulkState, useSettings), `lib/` (messaging, csv,
  popupN8n). `csv.ts` reuses `pickTopJob` from `background/exporter` (no duplication;
  xlsx stays tree-shaken out of the popup bundle).
- Popup consumes `ScrapedProfile` (the stored superset) so it can read
  `location`/`profilePic`/`hasHiringBadge`/`applicantsCount`.
- Trimmed a pre-existing malformed trailing rule in the source `popup.css`
  (`.info-banner` was cut off mid-`linear-gradient` in v0.19.0 — browser ignored it,
  esbuild warned). The full `.info-banner` is still defined earlier; it's unused anyway.
- Verified: `npm run type-check` exit 0, `npm run build` exit 0.
  Outputs: popup chunk 176 KB, `popup.css` 12.3 KB, no xlsx chunk.

---

## Milestone 6 — Anti-Detection Hardening (Day 10)

**Goal:** Consolidate all LinkedIn anti-blocking logic into one typed module.

### Tasks
- [ ] Create `src/background/anti-detect.ts`:
  ```ts
  export interface AntiDetectConfig {
    minDelayMs: number;       // 10000 (10s)
    maxJitterMs: number;      // 5000 (5s)
    cooldownAfterErrors: number;  // 3 errors → 45-75s pause
    hardStopAfterErrors: number;  // 5 errors → 3-4 min pause
    emptyProfileDelayMs: [number, number]; // [2000, 3500]
  }

  export function computeDelay(hadJobs: boolean, config: AntiDetectConfig): number { ... }
  export async function maybeCircuitBreak(consecutiveErrors: number, config: AntiDetectConfig): Promise<void> { ... }
  ```
- [ ] Move circuit breaker from `bulk.ts` into `anti-detect.ts`
- [ ] Add per-session rate limit: max 150 profiles per 4-hour window
- [ ] Add `SessionGuard` — stops auto-pull if limit hit, logs warning

### Deliverable
All anti-blocking logic in one auditable, typed file. Easy to tune without touching bulk logic.

---

## Milestone 7 — QA, Build & Release (Days 11–12)

**Goal:** Extension loads in Chrome from `dist/`, all features work end-to-end.

### Tasks

**QA Checklist**
- [ ] Load unpacked from `dist/` in Chrome
- [ ] Manual save on 10 LinkedIn profiles → data correct
- [ ] Bulk scrape 20 URLs → all results pushed to NocoDB
- [ ] Auto-pull ON/OFF toggle → alarms fire correctly
- [ ] Export XLSX → file downloads, data matches
- [ ] Export JSON → correct shape
- [ ] AI ranking (OpenRouter) → isTopJob tagged correctly
- [ ] Closed-job filter → closed jobs removed
- [ ] Circuit breaker → simulate 5 failures, verify 3-4 min pause triggers
- [ ] Stop-after-batch → auto-pull disables after batch completes
- [ ] Multi-tenant → different Team IDs get separate results

**Build**
- [ ] `wxt build` → clean `dist/`
- [ ] `wxt zip` → produces `.zip` for distribution
- [ ] Bundle size audit: `dist/` should be < 200KB (excluding `lib/xlsx.full.min.js`)
- [ ] Confirm XLSX lazy loads on first export, not on SW start

**Release**
- [ ] Bump version in `wxt.config.ts` to `0.20.0`
- [ ] Update `README.md` — new install instructions
- [ ] Tag git release: `v0.20.0-wxt`

### Deliverable
Production-ready `v0.20.0` zip file.

---

## Milestone 8 — Optional Enhancements (Days 13–14)

These are not required for the migration but add long-term value.

### 8A — Automated Tests
- [ ] Vitest unit tests for `storage.ts`, `anti-detect.ts`, `profile-extractor.ts`
- [ ] Mock `chrome.*` APIs using `vitest-chrome`
- [ ] CI script: `wxt build && vitest run`

### 8B — Better Session Limits
- [ ] Track daily scrape count in `chrome.storage.local`
- [ ] Show warning in popup if approaching LinkedIn's suspected limits (200/day)
- [ ] Auto-pause at limit, resume next day

### 8C — Error Reporting
- [ ] Capture failed URLs in `chrome.storage.local`
- [ ] Show "Failed URLs" list in popup with retry button
- [ ] Export failed URLs as CSV for manual follow-up

### 8D — Dev Tooling
- [ ] ESLint + Prettier config
- [ ] Pre-commit hook: `lint-staged`
- [ ] GitHub Actions: build on PR

---

## Summary Timeline

```
Day 1   → M0: WXT setup & skeleton
Day 2   → M1: TypeScript interfaces
Day 3   → M2: Storage layer
Day 4-5 → M3: Background service worker
Day 6-7 → M4: Content scripts
Day 8-9 → M5: Popup React UI
Day 10  → M6: Anti-detection module
Day 11-12 → M7: QA + build + release
Day 13-14 → M8: Optional enhancements
```

---

## Files That DON'T Change

These files carry over unchanged:

| File | Reason |
|---|---|
| `icons/` | Same icons |
| `lib/xlsx.full.min.js` | Same library, just loaded differently |
| `content.css` | Same styles (or port to CSS modules later) |
| `docs/` | Architecture docs stay |
| n8n webhook URLs | Same endpoints |

---

## Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Voyager data extraction breaks after LinkedIn update | Medium | Keep extraction logic in its own file, easy to patch |
| XLSX dynamic import blocked in SW | Low | WXT uses Vite, handles this natively |
| React popup larger bundle | Low | Tree-shaking keeps it small; XLSX excluded from bundle |
| Circuit breaker timing needs tuning | Medium | Centralised in `anti-detect.ts`, one file to edit |
| Chrome Extension store re-review needed | Medium | No new permissions added — should be minor review |
