# Argentier — the CFO your business will never hire

> A **read-only** agent on the **Qonto MCP** that separates your flows by nature, reveals your
> true controllable run-rate, benchmarks prices on the live web (sourced + dated via **Linkup
> MCP**), and prepares ready-to-send letters — **it never moves money and never sends anything.**
>
> **Operator acts. Analyst explains. Argentier optimizes.**

▶ **[3-min demo (Loom)](https://www.loom.com/share/b9f1a77d8eeb4dd5b0a8699f0c885123)**

---

## What it is

90% of small businesses will never hire a CFO. Their Qonto account is full of data and nobody
to read it — **the statement lies**: it blends recurring tools, structural costs and one-off
spend into one number. Argentier is the agent that reads it for them.

**The one architectural decision:** a brain split in two — the **LLM orchestrates and explains**,
a **deterministic engine (`engine.py`) computes every euro**. The model never does financial
arithmetic. That is what makes every figure auditable.

## The loop

```
OBSERVE ─▶ ANALYSE ─▶ BENCHMARK ─▶ RECOMMEND ─▶ GATE ─▶ LEDGER ─▶ (J+30) VERIFY
Qonto MCP   engine.py   Linkup MCP   sourced      human    decisions   re-read &
(read-only) (the euros)  (sourced+    card        approves  .json       prove the
                          dated)                   & sends              money dropped
```

- `/audit` — OBSERVE → ANALYSE → BENCHMARK → RECOMMEND → drafts in `drafts/`.
- `/verify` — ~30 days after an action, re-reads the account and proves the saving landed.

## The 4 non-negotiable rules

1. **Read-only Qonto** — only `get_organization`, `list_transactions`, `list_labels` and
   `list_transaction_attachments`. Never a write, transfer or card tool.
2. **The engine computes, never the LLM** — every euro comes from `engine.py`.
3. **Zero PII to the web** — only the merchant name + category go to Linkup.
4. **Price = source + date** — otherwise "not verified" (1 retry, then dropped).

## North Star — Annualized Proven Savings

`economies_prouvees_eur_an` in `data/decisions.json`: the engine-computed savings of decisions a
human approved **and sent**, where a J+30 read-only re-read of the Qonto account confirmed the
recurring debit dropped or vanished. Duplicates count as one-shot recoveries, never annualized.

## Install

1. Connect the Qonto MCP as `qonto`:
   `claude mcp add --transport http qonto https://mcp.qonto.com/mcp`
2. Connect the Linkup MCP as `linkup` (used only for the benchmark step, after your OK).
3. Copy `skills/argentier/` into `~/.claude/skills/`, and `commands/` into `~/.claude/commands/`.
4. Run `/audit`.

Check the engine:

```bash
cd skills/argentier
python3 -m unittest discover -s tests      # 24 rule tests (recurrence, ×12, duplicates, FX, PRO/PERSO)
```

## Files

```
argentier/
├─ commands/
│  ├─ audit.md               # /audit
│  └─ verify.md              # /verify (J+30 proof)
└─ skills/argentier/
   ├─ SKILL.md               # the skill
   ├─ engine.py              # deterministic engine (the numbers), standard library only
   ├─ tests/test_engine.py   # rule tests
   └─ references/            # methodology + two architecture diagrams (no real data)
```

`data/` (raw flows, profile, ledger) and `drafts/` (deliverables) are created locally at run time
and gitignored — real banking data never leaves your machine.

## Safety

Read-only on Qonto; never initiates a payment, transfer, or card change. Benchmarks send only a
merchant name + category. Tax suggestions are leads to confirm with an accountant. **You are
always the one who sends.**
