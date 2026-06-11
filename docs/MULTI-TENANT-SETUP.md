# 👥 Multi-Tenant Setup — har teammate ka apna kaam alag

> Maqsad: 5–9 teammate ek saath kaam karein, magar har banda ki URLs sirf usi ka
> browser pull kare, aur har result row pe pata ho woh **kis ki request** thi.
> **Single table + `owner` tag** — koi naya per-teammate table nahi.

Yeh design 2 cheezon par tika hai:

| Field | Kaam |
|-------|------|
| `owner` | kis teammate ki request (e.g. `usman`, `mahmoud`) |
| `batch_id` *(optional)* | kaun si upload/sheet (har upload pe ek UUID) |

---

## ✅ PART 0 — Extension (already done)

Code change ho chuka hai (v0.19.0). Har teammate ko bas itna karna hai:

1. Extension → **🔗 n8n** tab kholo.
2. **👤 Your Team ID (owner)** field me apna id likho — lowercase, no spaces (e.g. `usman`).
3. Auto Mode ON.

Ab woh browser:
- Pull karega: `GET /pull-urls?owner=usman` (sirf apni URLs).
- Result bhejega: `POST /profile-done` body me `"owner": "usman"`.

> ⚠️ Agar Team ID khaali hoga to auto-pull **chalega hi nahi** (cross-tenant leak se bachne ke liye).

---

## ✅ PART 1 — NocoDB me columns add karo

### Table A — `scrape_queue` (`mpm04yiwo9xyyot`)
Naye columns (sab **SingleLineText**, `uploaded_at` ko DateTime):

```
owner            (text)
batch_id         (text)
batch_name       (text)
slack_channel    (text)
slack_thread_ts  (text)
uploaded_at      (datetime)
```

### Table B — `results` (`my7jgu0qa53oshf`)
Naye columns:

```
owner       (text)
batch_id    (text)
batch_name  (text)
```

### Per-owner Views (yeh "kis ki sheet" wala masla solve karta hai)
`results` table pe har teammate ke liye ek **Grid View** banao, filter:

```
owner  is  usman
```

Phir har teammate ko apni view ka **shared link** de do → sirf apna data dikhega.
(Ya ek hi view me `owner` pe **Group By** kar do.)

---

## ✅ PART 2 — Upload workflow (entry point) — owner + batch yahan set hota hai

> 🔴 **ZAROORI:** Jo workflow xlsx ko `scrape_queue` (`mpm04yiwo9xyyot`) me `pending`
> rows ke tor par daalta hai, woh meri di gayi 4 files me **NAHI** tha. Yeh changes
> usi workflow me karne hain. Agar woh JSON mujhe de do, to main exact nodes edit kar
> ke de dunga. Tab tak yeh karna hai:

1. **"who are you?"** ka jawab (Usman / Mahmoud…) ko ek variable `owner` me lowercase karke rakho.
2. Upload pe ek **`batch_id`** generate karo (Set node, expression):
   ```js
   ={{ $now.toMillis() + '-' + Math.random().toString(36).slice(2,8) }}
   ```
   (Ya Crypto node se UUID.)
3. `batch_name` = uploaded file ka naam.
4. Slack trigger se `channel` + `thread_ts` (message ts) capture karo → `slack_channel`, `slack_thread_ts`.
5. Jab har row `scrape_queue` me **insert/create** karo, in 6 fields ko bhi set karo:
   `owner`, `batch_id`, `batch_name`, `slack_channel`, `slack_thread_ts`, `uploaded_at` (`={{ $now.toISO() }}`).

> Yani har pending row apne owner + batch ke saath paida hoti hai.

---

## ✅ PART 3 — Pull URLs workflow (`2️⃣ NocoDB → Extension`)

**Sirf 1 node badalna hai: `Get Pending Rows`.**

`options.where` ko isse replace karo:

```
=(Status,eq,pending)~and(owner,eq,{{ $('GET /pull-urls').item.json.query.owner }})
```

- Webhook `?owner=usman` query param se aata hai → `$json.query.owner`.
- Ab har browser sirf apni `pending` rows uthayega.
- Agar owner khaali ho to filter `owner,eq,` → **0 rows** (safe, kuch leak nahi hota).

*(Baaki nodes — Mark in_progress, Aggregate, Format Response — waise ke waise. Chaaho to
Format Response me `owner: r.owner` aur `batch_id: r.batch_id` bhi add kar sakte ho, magar
zaroori nahi.)*

---

## ✅ PART 4 — Extension Results workflow (`profile-done`) — owner stamp karo

### 4a) Node `Parse Profile → Jobs` (code) — owner nikaalo
Sabse upar, `const body =` ke baad yeh line add karo:

```js
const owner = (body.owner || items[0].json.body?.owner || '').toString().toLowerCase();
```

Phir **har** returned `json` object me yeh field add kar do (job items, "No jobs", "Invalid payload" — teeno me):

```js
owner: owner,
```

### 4b) Node `Edit Fields1` (set) — owner ko aage le jao
Ek nayi assignment add karo:

| Name | Value | Type |
|------|-------|------|
| `owner` | `={{ $('Loop Over Items').item.json.owner }}` | string |

### 4c) Nodes `Create` **aur** `Update` (results table) — owner likho
Dono nodes ke `fieldsUi` me yeh field add karo:

| fieldName | fieldValue |
|-----------|------------|
| `owner` | `={{ $('Edit Fields1').item.json.owner }}` |

> Bas! Ab har result row apne `owner` ke saath save hoga. Extension ne owner bheja,
> n8n ne use results pe laga diya — koi profile re-lookup ki zaroorat nahi.

### 4d) *(Optional)* batch_id bhi chahiye?
Agar same teammate ki **multiple sheets** alag karni hain:
- `profile-done` ke jobs-branch me ek **NocoDB GET** node add karo jo `scrape_queue`
  me `Decision Maker = {{ profile_url }}` search kare → row se `batch_id`, `batch_name`,
  `slack_thread_ts` le lo.
- Unhe `Edit Fields1` me carry karke `Create`/`Update` me likh do (owner jaisa hi).

*(Note: jobs-branch me queue row pehle se `Search NocoDB by Job URL1` → `Delete a row1`
me fetch hoti hai — wahi se batch_id reuse kar sakte ho.)*

---

## ✅ PART 5 — "No jobs" branch bhi tag ho jaye
`profile-done` ke "No jobs found" raste me jab queue row delete hoti hai, agar tum waha
bhi koi `results`/log row likhte ho to usme bhi `owner` (= `body.owner`) daal dena —
taaki "0 jobs" wale bhi sahi teammate ke naam dikhein.

---

## 🧪 Test plan (do teammate, ek saath)

1. NocoDB me upar wale columns + 2 views (`usman`, `mahmoud`) bana lo.
2. Do machines pe extension me Team ID set karo: ek `usman`, ek `mahmoud`.
3. Dono Slack pe apni-apni xlsx upload karein.
4. Check `scrape_queue`: har row pe sahi `owner` + `batch_id`.
5. Dono browsers Auto Mode ON. Dekho:
   - `usman` browser sirf usman ki rows `in_progress` karta hai, `mahmoud` sirf apni.
6. Check `results`: har job pe sahi `owner`.
7. `usman` view → sirf usman ki jobs. `mahmoud` view → sirf mahmoud ki. ✅

---

## 📌 Summary

| Layer | Change |
|-------|--------|
| Extension | ✅ done — Team ID field, scoped pull, owner in result |
| NocoDB | columns (`owner`, `batch_id`…) + per-owner Views |
| Upload WF | owner + batch_id har queue row pe set karo *(workflow chahiye)* |
| Pull WF | `Get Pending Rows` where me `owner` filter |
| Results WF | `owner` ko Parse → Edit Fields1 → Create/Update tak le jao |

5 ho ya 50 teammate — koi naya table/workflow nahi, sirf nayi `owner` value. 🚀
