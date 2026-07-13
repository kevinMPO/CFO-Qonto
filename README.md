# Argentier — the autonomous CFO agent for Qonto

> **The CFO your business will never hire.** A **read-only** agent on the **Qonto MCP**
> that separates your flows by nature, reveals your true controllable run-rate,
> benchmarks prices on the live web (sourced + dated via **Linkup MCP**), and prepares
> ready-to-send letters — **it never moves money and never sends anything.**
>
> _Prototype for the **Qonto × Anthropic MCP Hackathon**._ · **Operator acts. Analyst explains. Argentier optimizes.**

🌐 **[Live · getargentier.com](https://www.getargentier.com)** — landing + one-click demo · ▶ **[3-min demo (Loom)](https://www.loom.com/share/b9f1a77d8eeb4dd5b0a8699f0c885123)** · Script → [`DEMO.md`](DEMO.md)

---

## Table of contents
- [What it is](#what-it-is) · [Surfaces](#surfaces) · [The loop](#the-loop)
- [Architecture](#architecture) — [system](#system-overview) · [user flow](#user-flow) · [data flow](#data-flow)
- [The 4 rules](#the-4-non-negotiable-rules) · [Tech stack](#tech-stack)
- [Setup](#setup) · [File structure](#file-structure) · [Deploy](#deploy) · [Safety](#safety)

---

## What it is

90% of small businesses will never hire a CFO. Their Qonto account is full of data and
nobody to read it — **the statement lies**: it blends recurring tools, structural costs and
one-off spend into one number. Argentier is the missing agent that reads it for them.

**The one architectural decision:** a brain split in two — the **LLM orchestrates and explains**,
a **deterministic engine computes every euro**. The model never does financial arithmetic. That is
what makes every figure auditable.

## Surfaces

| Surface | What it is | State |
|---|---|---|
| **Live site** → **[getargentier.com](https://www.getargentier.com)** | Landing (`/`) + one-click demo (`/demo`): dashboard, **Autopilote**, natures waterfall, savings simulator, tracker board (drag & drop), ready-to-send letters, **5 languages** (FR/EN/DE/ES/IT), **ElevenLabs voice** | ✅ deployed (Vercel) |
| **Claude Code Skill** (`/audit`, `/verify`) | The real agent: Qonto MCP (read-only) → `engine.py` → Linkup MCP → `drafts/` | ✅ works live |
| **MCP server** (`my-app/`) | The deterministic engine exposed as an MCP server on **Cloudflare Workers** — [`argentier-mcp…workers.dev/mcp`](https://argentier-mcp.bonjour-e83.workers.dev/mcp), callable by any MCP client | ✅ live on Cloudflare |
| **Waitlist** | Demo-gate email captured on click → stored in **Cloudflare KV** (`POST /waitlist` on the Worker) | ✅ live |
| **Managed Agent** (`scripts/`) | Script that creates a real **Claude Managed Agent** (hosted autopilot) — verified run | ✅ proof run |

## The loop

```
OBSERVE ─▶ ANALYSE ─▶ BENCHMARK ─▶ RECOMMEND ─▶ GATE ─▶ LEDGER ─▶ (J+30) VERIFY
Qonto MCP   engine.py   Linkup MCP   sourced      human    decisions   re-read &
(read-only) (the euros)  (sourced+    card        approves  .json       prove the
                          dated)                   & sends              money dropped
```

---

## Architecture

### System overview

```mermaid
flowchart TD
    U([You — trigger, review, approve, send])
    subgraph Surfaces
      SK["Claude Code Skill<br/>/audit · /verify"]
      WEB["Web app (Next.js)<br/>landing + dashboard"]
      MCP["MCP server<br/>(Cloudflare Worker)"]
      CMA["Managed Agent<br/>(hosted autopilot)"]
    end
    ENG["engine.py / engine.ts<br/><b>deterministic — every euro</b>"]
    QONTO[("Qonto MCP<br/>read-only")]
    LINK[("Linkup MCP<br/>sourced + dated")]

    U --> SK & WEB & CMA
    SK --> QONTO & ENG & LINK
    WEB --> ENG & LINK
    MCP --> ENG
    CMA --> QONTO & ENG & LINK
    ENG -->|levers, natures, run-rate| U
```

*Guardrail:* every Qonto **write** tool is hard-denied in [`.claude/settings.json`](.claude/settings.json)
(`deny` > `allow`). Argentier cannot move money.

### User flow

```mermaid
sequenceDiagram
    actor You
    participant A as Argentier
    participant Q as Qonto MCP
    participant E as engine
    participant L as Linkup MCP
    You->>A: /audit (or "Voir la démo")
    A->>Q: get_organization, list_transactions (90d, read-only)
    A->>E: run engine on the raw flows
    E-->>A: natures, levers, TVA, silent hikes (euros)
    A->>You: green light to benchmark?
    You-->>A: yes
    A->>L: linkup-search (merchant + category only)
    L-->>A: alternatives + price + dated source
    A->>You: sourced card + draft letter (drafts/)
    You->>You: approve & send (Argentier sends nothing)
    Note over A: ~J+30 → /verify re-reads & proves the saving
```

### Data flow

```mermaid
flowchart LR
    Q["Qonto txs<br/>(raw JSON)"] --> N["normalize<br/>(Tx[])"]
    N --> C["categorize<br/>(rules / Claude)"]
    C --> B["build()<br/><b>deterministic engine</b>"]
    B --> R["AnalyzeResult<br/>natures · levers · tvaPerdue · hausse"]
    R --> UI["Web UI / rapport"]
    R --> D["drafts/ letters"]
    R --> LG["decisions.json (ledger)"]
    B -. only merchant+category .-> LK["Linkup (web)"]
```

**Zero PII to the web:** only the merchant name + category ever leave the machine (never an
IBAN, `transaction_id`, or personal data).

---

## The 4 non-negotiable rules

1. **Read-only Qonto** — only read tools; every write/transfer/card tool is hard-denied.
2. **The engine computes, never the LLM** — every euro comes from `engine.py` / `engine.ts`.
3. **Zero PII to the web** — only merchant + category go to Linkup.
4. **Price = source + date** — otherwise "not verified" (1 retry, then dropped).

## Tech stack

| Layer | Tech |
|---|---|
| Agent engine | **Python** (`engine.py`) — deterministic, `unittest` |
| Web app | **Next.js 15** / React 19 / TypeScript, CSS-in-JS, no UI framework |
| Web engine mirror | **TypeScript** (`web/lib/engine.ts`) — same rules as `engine.py` |
| LLM | **Claude** (Anthropic SDK) — categorization + letters (labels only, never euros) |
| MCPs | **Qonto** (read-only), **Linkup** (benchmark) |
| Voice | **ElevenLabs** — TTS (`/api/voice`) + Conversational widget |
| MCP server | **Cloudflare Workers** + `agents` (`McpAgent`) + `@modelcontextprotocol/sdk` |
| Hosted agent | **Claude Managed Agents** (beta) |

---

## Setup

### 1. Deterministic engine (Python)
```bash
python3 -m unittest discover -s tests      # 24 rule tests (recurrence, ×12, duplicates, FX, PRO/PERSO, hikes, VAT)
python3 engine.py data/exemple-demo.json   # see the engine on a sample
```

### 2. The Claude Code skill (the submission)
Open this repo in **Claude Code** with the Qonto + Linkup MCPs connected, then:
```
/audit      # OBSERVE → ANALYSE → BENCHMARK → RECOMMEND → drafts
/verify     # ~30 days later: prove the saving landed
```

### 3. Web app (landing + dashboard)
```bash
cd web
cp .env.example .env.local     # fill keys (or leave empty → demo data)
npm install
npm run dev                    # http://localhost:3000
```
`.env.local` keys: `ANTHROPIC_API_KEY`, `LINKUP_API_KEY`, `QONTO_LOGIN`/`QONTO_SECRET_KEY`/`QONTO_IBAN`,
`ELEVENLABS_API_KEY` (+ optional `ELEVENLABS_VOICE_ID`, `NEXT_PUBLIC_ELEVENLABS_AGENT_ID`).
Without Qonto/Anthropic keys the app runs on **demo data** (mock).

### 4. MCP server on Cloudflare (`my-app/`)
```bash
cd my-app
npm install --legacy-peer-deps
npx wrangler dev               # local  →  POST http://localhost:8787/mcp
npx wrangler login && npx wrangler deploy   # publish (needs your Cloudflare OAuth)
```
Exposes 4 tools: `argentier_rules`, `argentier_classify_ei`, `argentier_annualize`, `argentier_analyze`.

### 5. Real Managed Agent (`scripts/`)
```bash
node scripts/create-cma-agent.mjs          # reads ANTHROPIC_API_KEY from web/.env.local
```
Creates a hosted CMA agent + session that runs a task in a sandbox. See [`docs/autopilote-cma-spec.md`](docs/autopilote-cma-spec.md).

---

## File structure

```
DAF Qonto/
├─ engine.py                 # deterministic engine (the numbers) — source of truth
├─ tests/test_engine.py      # 24 rule tests
├─ SKILL.md                  # the Argentier skill (MCP-native orchestration)
├─ .claude/
│  ├─ settings.json          # read-only guardrail (deny > allow)
│  └─ commands/              # /audit, /verify
├─ web/                      # Next.js app (landing + dashboard)
│  ├─ app/
│  │  ├─ page.tsx            # landing ↔ app toggle
│  │  ├─ Landing.tsx         # marketing landing (Qonto-styled)
│  │  ├─ Argentier.tsx       # the dashboard (Autopilote, waterfall, board, voice…)
│  │  └─ api/                # analyze · benchmark · letter · voice
│  └─ lib/                   # engine.ts · categorize.ts · types.ts · i18n.ts · mock.ts
├─ my-app/                   # MCP server on Cloudflare Workers (McpAgent)
│  └─ src/index.ts + src/lib # engine reused verbatim
├─ scripts/create-cma-agent.mjs   # real Claude Managed Agent
├─ docs/                     # PRD · CMA spec · landing/Cloudflare · voice setup
└─ data/, drafts/            # real flows, ledger, deliverables (gitignored)
```

---

## Deploy

- **Web app** → Cloudflare Pages (`@cloudflare/next-on-pages`) or Vercel.
- **MCP server** → `cd my-app && npx wrangler login && npx wrangler deploy`.
- **Custom domain** `getargentier.com` → add it in the Cloudflare dashboard (Workers/Pages → Custom domains)
  or `wrangler` route. All keys live in **Cloudflare secrets** (`wrangler secret put`), never in the repo.

## Safety

Read-only on Qonto; never initiates a payment, transfer, or card change. Benchmarks send only a
merchant name + category. Tax suggestions are leads to confirm with an accountant. **You are always
the one who sends.**

---

**The CFO your business will never hire.**
