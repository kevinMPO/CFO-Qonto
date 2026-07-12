# Qonto Fisca Co-pilot — a proactive tax co-pilot on Qonto MCP

> Submission for the **Qonto × Anthropic MCP Hackathon** (July 2026).
> One read-only Claude skill built on the [Qonto MCP server](https://docs.qonto.com/mcp/overview).

Your bank account already holds the data. This skill makes it *think*: it turns a
Qonto business account into a proactive assistant that surfaces the tax reflexes a
founder forgets — and closes the gap between the **bank** (where the data lives) and
the **accountant** (who only reviews it at month-end).

Everything is **read-only**: no tool moves money, no data is mutated. Every figure is
**sourced**, and anything uncertain is flagged rather than asserted.

---

## The problem

A founder's bank feed is full of tax signals that go unnoticed until the accountant's
month-end review — or forever:

- a foreign SaaS charge that should be VAT reverse-charged (*autoliquidation*) on the
  next return;
- a client lunch two towns over → unclaimed mileage (*frais kilométriques*);
- a card payment with no invoice attached → non-deductible VAT if not chased;
- under-used tax breaks the founder simply doesn't know exist.

The bank stops at *"here are your transactions."* The accountant arrives weeks later.
This skill fills that gap — proactively, in the moment, on real data — and always hands
off to the accountant for confirmation.

## What it does

Scans a period's transactions and produces two things:

- **🔔 Transaction-triggered nudges** — reflexes tied to a real spend, e.g.
  - *foreign SaaS (Anthropic Ireland, Vercel US…)* → reverse-charge the VAT on your CA3;
  - *restaurant in another city* → the agent resolves the merchant's city via web search,
    compares it to your registered office, and proposes mileage only if you actually
    travelled (it drops local restaurants and asks when unsure — no fabricated distance);
  - *hotel* → hotel VAT is not recoverable;
  - *card payment with no invoice* → ask the supplier for a proper invoice.
- **🎯 Standalone tax breaks to activate** — reduced 15% corporate tax band, JEI status,
  home-office redevance, associate-current-account interest, mécénat, etc.

Each suggestion carries **its source and confidence level**, and ends with
*"to be confirmed with your accountant."*

## Demo

📹 **Demo video — attached to this pull request** (2 min 35).

The Qonto MCP connected and **read-only**, then the skill running end-to-end on **de-identified
demo data** (NIMBUS SAS — a small French company), from a single prompt to the final report.

The moment to watch: the **mileage detective**. A cryptic merchant label the web cannot resolve
(*"LE COMPTOIR DU MARCHÉ"* — Nice? Poitiers? Levallois?), so the agent **opens the receipt** and
reads the city off the printed address: **Reims**. A business trip that would otherwise stay invisible.

## How it works

```
get_organization          → country (rules file) + profile facts (legal form, creation date, capital)
list_transactions         → the period's transactions (paginated)
scripts/scan_triggers.py  → deterministic classification into trigger buckets
web search (best-effort)   → resolve merchant cities for mileage
references/rules-<cc>-<regime>.md   → sourced rule catalogue for the detected country
                           → applicability computed against the profile, not hardcoded
report                     → nudges + niches, each with source + confidence
```

- **Deterministic maths in Python, not the LLM.** Aggregation (VAT totals, categories,
  missing receipts) runs in `scripts/*.py`, so 100+ rows never rely on LLM arithmetic.
- **Profile-driven applicability.** A rule's eligibility is evaluated against a profile
  (auto-filled from Qonto + an optional `profile.md` + on-the-fly questions), never
  hardcoded to one company. E.g. *no employees* → employee-benefit schemes (CESU, meal
  vouchers) are disabled automatically.

## Qonto MCP tools used (read-only)

`get_organization`, `list_transactions`, `get_transaction`, `list_supplier_invoices`,
`list_transaction_attachments`, `list_labels`, `list_cash_flow_categories`.

**No** create / update / delete / transfer tool is ever called.

## Safety & guardrails

- **Read-only by design** — the skill declares and uses only read tools; it never moves
  money (the Qonto MCP couldn't anyway — outbound transfers aren't exposed).
- **Advisory, not tax advice** — every suggestion is a prompt to discuss with the
  accountant, never a certainty.
- **No invented figures** — amounts come only from the sourced rules file; uncertain
  items are flagged ⚠️ *to verify*, never quoted firmly.

## Accuracy & sourcing

Every figure is sourced, and the base is **verified in layers** — because for tax data,
"plausible" is not good enough:

- **France (the core)** — hand-built against official references (BOFIP, impots.gouv.fr,
  URSSAF) and human-verified as of July 2026 against the 2026 Finance Act. It catches, e.g.,
  that the *director training tax credit* was abolished, keeps the CIR at its real **30%** rate,
  and leaves contested points (ACRE eligibility, the exact PER ceiling, the reformed CSG rate)
  explicitly flagged ⚠️ rather than guessed.
- **The 7 other countries** — first drafted, then run through an adversarial verification pass,
  then a **second human (Opus) pass on every load-bearing figure** against the national authority
  (Bundesfinanzministerium, Agenzia delle Entrate, Agencia Tributaria, BMF, SPF Finances,
  Belastingdienst, Portal das Finanças). That pass earned its keep: it caught real slips — a German
  *business* mileage rate confused with the *commuting* rate, a Spanish social rate quoting only one
  of its five components, an Italian retention period off by years — **and** the automated verifier
  *introducing* errors of its own, which is exactly why a human confirms each key number.

The country packs stay labelled **`⚠️ AUTO-GENERATED DRAFT`**: headline figures human-checked, long
tail machine-checked, and — like every suggestion — they end with *"confirm with a local tax advisor."*
Nothing unverified is ever presented as settled fact.

## Multi-country by design

The trigger engine is country-agnostic; the tax knowledge lives in `references/rules-<cc>-<regime>.md`,
selected automatically from the organization's `legal_country` + `legal_form` (mapped in
`references/_coverage-map.md`). **France is the fully-verified core** (4 regime packs: micro /
IR-réel / IS-TNS / IS-assimilé). The **7 other Qonto markets** — Germany, Italy, Spain, Austria,
Belgium, the Netherlands, Portugal — ship as **draft packs** (a sole-trader/small pack + an
owner-managed-company pack each), covering the common legal forms by their tax regime. The EU
VAT-reverse-charge and invoice-required nudges transfer almost as-is; adding a market or regime =
one rules file (see `references/_template.md`).

## Run it

1. In Claude, turn on **Code execution** and **File creation** (Settings → Capabilities) — the
   skill runs a small Python script (standard library only, nothing to install).
2. Connect the Qonto MCP server (`https://mcp.qonto.com/mcp`, OAuth) to Claude — see the
   [Claude Code install guide](https://docs.qonto.com/mcp/install/claude-code).
3. Drop the skill folder into your skills directory.
4. Ask, e.g.: *"What tax reflexes did I miss last month?"* or *"Which tax breaks could I activate?"*

## Included in this submission

```
qonto-fisca-copilot/     # proactive tax co-pilot
  SKILL.md
  references/            # 4 France packs (verified) + 14 country packs (DE/IT/ES/AT/BE/NL/PT ×2, draft),
                         #   _coverage-map.md, profile.example.md, _template.md
  scripts/scan_triggers.py
  evals/                 # evals.jsonl (6 scenarios) + README.md
  demo/                  # de-identified demo data + fake receipts
```

## Author

François Guerlez — [FRANSYS](https://fransys.io) · [github.com/fransys-code](https://github.com/fransys-code)
