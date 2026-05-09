# LinkedIn Recruiter Intelligence — Architecture

> Clean block flow diagrams using **Mermaid** (built into Obsidian, no plugin needed).
> Just open this file in Obsidian — diagrams render automatically.

---

## 🎯 High-Level Flow (Show this to the client)

```mermaid
flowchart LR
    A[👤 Client]:::user -->|1. Upload xlsx| B[💬 Slack<br/>channel]:::slack
    B -->|2. file_share event| C[⚙️ n8n WF1]:::n8n
    C -->|3. Insert rows<br/>status: pending| D[(🗂️ NocoDB<br/>scrape_queue)]:::db
    D -->|4. Auto-pull every 30s| E[🌐 Chrome<br/>Extension]:::ext
    E -->|5. Open profile tabs| F[🔵 LinkedIn]:::linkedin
    F -->|Profile + jobs data| E
    E -->|6. Rank top job| G[🤖 OpenRouter<br/>Gemini Flash]:::ai
    G -->|isTopJob: true| E
    E -->|7. Skip closed jobs| F
    E -->|8. Build XLSX in browser| H[📊 jobs.xlsx]:::xlsx
    H -->|9. POST multipart/form-data| I[⚙️ n8n WF3]:::n8n
    I -->|10. Mark complete| D
    I -->|11. Upload file<br/>to thread| J[💬 Slack<br/>thread reply]:::slack

    classDef user      fill:#dbeafe,stroke:#1e40af,stroke-width:2px,color:#1e3a8a
    classDef slack     fill:#ede9fe,stroke:#7c3aed,stroke-width:2px,color:#5b21b6
    classDef n8n       fill:#fee2e2,stroke:#dc2626,stroke-width:2px,color:#991b1b
    classDef db        fill:#d1fae5,stroke:#059669,stroke-width:2px,color:#064e3b
    classDef ext       fill:#dbeafe,stroke:#0a66c2,stroke-width:3px,color:#0a66c2
    classDef linkedin  fill:#bfdbfe,stroke:#0077b5,stroke-width:2px,color:#0c4a6e
    classDef ai        fill:#f3e8ff,stroke:#9333ea,stroke-width:2px,color:#581c87
    classDef xlsx      fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#14532d
```

---

## 🔄 Detailed Flow with Subsystems

```mermaid
flowchart TB
    subgraph INPUT [" 📥 INPUT "]
        direction LR
        Client[👤 Client] --> SlackIn[💬 Slack<br/>Upload xlsx]
    end

    subgraph ORCH1 [" ⚙️ Workflow 1 — Slack to NocoDB "]
        direction TB
        WF1Web[Webhook<br/>/upload-csv] --> Parse1[Parse Slack<br/>event]
        Parse1 --> Download[Download xlsx<br/>from Slack]
        Download --> Extract[Extract<br/>rows]
        Extract --> Insert[Insert to<br/>NocoDB]
        Insert --> Notify1[Reply on<br/>Slack thread]
    end

    subgraph STORE [" 🗂️ Storage Layer "]
        direction LR
        Pending[(pending)] -.-> InProgress[(in_progress)]
        InProgress -.-> Complete[(complete)]
    end

    subgraph EXT [" 🌐 Extension Loop "]
        direction TB
        AutoPull[Auto-pull<br/>every 30s] --> WF2Web[GET /pull-urls]
        WF2Web --> ScrapeBatch[Scrape profiles<br/>1 by 1]
        ScrapeBatch --> Activity[Method 4:<br/>Activity posts<br/>last 15]
        Activity --> ClosedFilter[🚫 Filter<br/>closed jobs]
        ClosedFilter --> AIRank[🤖 AI rank<br/>top job]
        AIRank --> BuildXlsx[📊 Build XLSX<br/>SheetJS]
    end

    subgraph ORCH3 [" ⚙️ Workflow 3 — Extension to Slack "]
        direction TB
        WF3Web[POST /scrape-results] --> ParseMulti[Parse multipart<br/>file + meta]
        ParseMulti --> Lookup[Lookup channel<br/>from NocoDB]
        Lookup --> SlackUp[Upload XLSX<br/>to thread]
        SlackUp --> MarkDone[Mark rows<br/>complete]
    end

    subgraph OUTPUT [" 📤 OUTPUT "]
        SlackOut[💬 Slack thread<br/>📎 jobs.xlsx<br/>🎉 done]
    end

    INPUT --> ORCH1
    ORCH1 --> Pending
    Pending --> EXT
    EXT --> InProgress
    EXT --> ORCH3
    ORCH3 --> Complete
    ORCH3 --> OUTPUT

    classDef section fill:#f9fafb,stroke:#374151,stroke-width:1px
    class INPUT,ORCH1,ORCH3,STORE,EXT,OUTPUT section
```

---

## 🏗️ Layer-by-Layer View

```mermaid
flowchart TB
    subgraph L1 ["LAYER 1 · Trigger"]
        S1[Slack file_share]
    end

    subgraph L2 ["LAYER 2 · Orchestration (n8n)"]
        WF1[WF1: Slack → NocoDB]
        WF3[WF3: Extension → Slack]
    end

    subgraph L3 ["LAYER 3 · Storage (NocoDB)"]
        Q[scrape_queue table<br/>pending → in_progress → complete]
    end

    subgraph L4 ["LAYER 4 · Browser Extension"]
        Pull[Auto-Pull]
        Scrape[Scraper]
        AI[AI Ranking]
        XLSX[XLSX Builder]
    end

    subgraph L5 ["LAYER 5 · External APIs"]
        LI[LinkedIn]
        OR[OpenRouter AI]
    end

    S1 --> WF1
    WF1 --> Q
    Q --> Pull
    Pull --> Scrape
    Scrape <--> LI
    Scrape --> AI
    AI <--> OR
    AI --> XLSX
    XLSX --> WF3
    WF3 --> Q
    WF3 --> S1

    style L1 fill:#ede9fe,stroke:#7c3aed
    style L2 fill:#fee2e2,stroke:#dc2626
    style L3 fill:#d1fae5,stroke:#059669
    style L4 fill:#dbeafe,stroke:#0a66c2
    style L5 fill:#f3e8ff,stroke:#9333ea
```

---

## 🔢 Sequence Diagram (Step-by-Step)

```mermaid
sequenceDiagram
    participant U as 👤 Client
    participant S as 💬 Slack
    participant N1 as ⚙️ n8n WF1
    participant DB as 🗂️ NocoDB
    participant EX as 🌐 Extension
    participant LI as 🔵 LinkedIn
    participant AI as 🤖 OpenRouter
    participant N3 as ⚙️ n8n WF3

    U->>S: Upload recruiters.xlsx
    S->>N1: file_share webhook
    N1->>S: Download file
    N1->>DB: Insert 21 rows<br/>(status: pending)
    N1->>S: ✅ 21 URLs queued

    Note over EX: Auto-pull alarm fires (30s)
    EX->>N1: GET /pull-urls
    N1->>DB: Get pending → mark in_progress
    N1-->>EX: [{Profile URL, ...}, ...]

    loop For each URL (1 by 1)
        EX->>LI: Open profile page
        LI-->>EX: HTML + hidden voyager data
        EX->>EX: Extract profile + hiring posts<br/>+ Activity (last 15)
    end

    Note over EX: Scrape complete

    loop For each closed job (filter ON)
        EX->>LI: Fetch job URL
        LI-->>EX: HTML
        EX->>EX: Detect "No longer accepting"
    end

    loop For each profile (AI ON)
        EX->>AI: Rank job titles
        AI-->>EX: {topIndex: 2}
    end

    EX->>EX: Build jobs.xlsx (SheetJS)
    EX->>N3: POST multipart<br/>(file + meta + profiles)
    N3->>DB: Lookup channel
    N3->>S: Upload XLSX to thread
    N3->>DB: Mark rows complete
    N3-->>EX: 200 OK
    S-->>U: 🎉 jobs.xlsx ready
```

---

## 📋 Component Cheat-Sheet

```mermaid
mindmap
  root((LinkedIn<br/>Recruiter<br/>Intelligence))
    Slack
      Upload xlsx
      Receive XLSX result
    n8n
      WF1 Slack to NocoDB
      WF2 Pull pending URLs
      WF3 Receive results to Slack
    NocoDB
      scrape_queue table
      pending state
      in_progress state
      complete state
    Extension
      Auto-pull 30s
      Stop after batch
      Emergency stop
      Hiring badge scraper
      Activity post scanner
      AI top-job ranking
      Closed-job filter
      XLSX builder SheetJS
      Status pill + badge
    APIs
      LinkedIn session
      OpenRouter Gemini
```

---

## 📌 How to Use in Obsidian

```
1. Copy this file to your Obsidian vault
2. Open it — Mermaid renders automatically
3. NO plugin needed (Mermaid is built-in since v0.13)
4. Edit by changing the text inside ` ```mermaid ... ``` `
5. Export: right-click any diagram → "Open as PNG/SVG"
```

## 🎨 Customizing Colors

Replace the `classDef` lines at the bottom of any diagram. Format:
```
classDef name fill:#hexcolor,stroke:#hexcolor,stroke-width:2px
```

## 🛠️ Optional Plugins (if you want fancier)

| Plugin | Purpose |
|--------|---------|
| **Excalidraw** | Hand-drawn / sticky-note style diagrams |
| **Diagrams** (drawio) | Full BPMN / UML / network diagrams |
| **D2** | Modern diagramming language |

For client presentations, **Mermaid is enough** — it's clean, professional, and version-controllable.
