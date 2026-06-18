# Argentier — the CFO your business will never hire

> Read-only optimization agent for **Qonto**, built on the **Qonto MCP** and
> **Linkup MCP**. It separates your flows by nature, reveals your true
> controllable run-rate, benchmarks prices on the live web (sourced + dated),
> and prepares ready-to-send cancellation & renegotiation letters — **it never
> moves money and never sends anything.**
>
> _Qonto × Anthropic MCP Hackathon submission._

**Operator acts. Analyst explains. Argentier optimizes.** — the missing Qonto agent.

## ▶ Demo (3 min)

▶ **[Watch the demo on Loom](https://www.loom.com/share/e8c79ea61c38450fbefa73739417a458)** · Script → [`DEMO.md`](DEMO.md) · Détails → [`VIDEO.md`](VIDEO.md)

## The problem

90% of small businesses will never hire a CFO. So the founder reads the finances
at midnight, between two client calls. The Qonto account is full of data and
nobody to decode it. **The statement lies**: it blends recurring tools,
structural costs and one-off spend into a single number. So they overpay for
duplicate tools and ghost subscriptions, bleed FX fees, and lose deductible VAT
without ever seeing it.

## What Argentier does

`OBSERVE → ANALYSE → BENCHMARK → RECOMMEND → GATE → LEDGER → VERIFY`

1. **OBSERVE** — reads 90 days live via the Qonto MCP (read-only).
2. **ANALYSE** — a deterministic engine sorts every flow into
   **PRO / PERSO / A-CLARIFIER** and 4 natures, finds duplicates, dormant
   subscriptions and FX fees, and computes the **true controllable run-rate**.
3. **BENCHMARK** — with your green light, the **Linkup MCP** pulls cheaper
   alternatives with their **current public price + dated source**.
4. **RECOMMEND** — one sourced card per lever: current cost, action, alternative,
   €/year saved.
5. **GATE** — writes ready-to-send letters to `drafts/`; **you** approve and send.
6. **LEDGER + VERIFY** — records the decision, then at ≈ J+30 re-reads the account
   and **proves** the money actually dropped.

## Why it's a *quality* agent (the trust layer)

- **The model only labels; `engine.py` does every euro.** No hallucinated
  numbers — every figure is reproducible and auditable. Run
  `python3 engine.py data/flows-*.json` yourself.
- **Read-only, never moves money.** All Qonto write tools are hard-blocked in
  [`.claude/settings.json`](.claude/settings.json) (`deny` > `allow`). Aligns
  with Qonto's own MCP security model.
- **Every price is sourced + dated** (via Linkup) or labelled "not verified" —
  never invented.
- **Zero PII to the web**: only a merchant name + category ever leaves the account.
- **Human gate**: it prepares, you send. **Verify loop**: it proves impact.

## The agent really calls the MCPs

- **Qonto MCP** — `get_organization`, `list_transactions`, `list_labels`
  (read-only) for real account data.
- **Linkup MCP** — `linkup-search` for live, sourced, dated benchmark prices.

See [`SKILL.md`](SKILL.md) for the full orchestration and the exact tool calls.

## Run it

**As a Claude skill (the submission):** open this repo in Claude Code with the
Qonto + Linkup MCPs connected, then:

```
/audit          # OBSERVE → ANALYSE → BENCHMARK → RECOMMEND → drafts
/verify         # ≈ 30 days later: prove the saving landed
```

**Check the deterministic engine:**

```bash
python3 -m unittest discover -s tests      # rule tests (recurrence, FX, duplicates, PRO/PERSO)
python3 engine.py data/exemple-demo.json   # see the engine on a sample
```

**The web dashboard (bonus surface)** — a bilingual FR/EN Next.js app that
renders the same analysis (hero, 3-natures ledger, savings simulator,
sourced letters, printable report):

```bash
cd web && npm install && npm run dev   # http://localhost:3000
```

## Demo

3-minute recording script: [`DEMO.md`](DEMO.md).

## Layout

| Path | Role |
|---|---|
| [`SKILL.md`](SKILL.md) | The Argentier skill — MCP-native orchestration. |
| [`engine.py`](engine.py) | Deterministic calculation engine (the numbers). |
| `tests/` | Rule tests for the engine. |
| `.claude/` | Read-only guardrail (`settings.json`) + `/audit`, `/verify` commands. |
| `web/` | Bonus web dashboard (Next.js, bilingual). |
| `references/` | Architecture schemas (macro + workflow) + methodology. |
| `data/`, `drafts/` | Real flows, ledger, deliverables (gitignored). |

## Safety

Argentier is read-only on Qonto and never initiates a payment, transfer or card
change. Benchmarks send only a merchant name + category. Tax suggestions are
leads to confirm with an accountant. **You are always the one who sends.**

---

**The CFO your business will never hire.**
