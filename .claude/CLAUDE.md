# Hammad Industries MES — Project Constitution for the Dev Team

Packaging & cobalting execution system for safety-glove manufacturing.
Full-stack: vanilla TS/HTML/CSS frontend (`src/main.ts`, 5 screens), Express
API (`server.ts` → `src/routes/api.js` → `src/services/packingService.js`),
SQLite via node:sqlite (`data/gloves_packing.db`), Docker runtime
(`Dockerfile`, `docker-compose.yml`).

## Non-negotiables

- **Grayscale only.** Every color must come from the CSS variables in
  `src/style.css` (`--ink-*`, `--bg-*`, `--border-*`, `--text-*`). Never
  introduce a new hex literal in markup or new CSS. Zero-color-tolerance rule:
  the entire UI, including print templates and SVG, stays monochrome.
- **Clean inspection mode.** No dummy/demo transaction rows. `seedDemoSheet()`
  in `src/db.js` is intentionally disabled; do not re-enable it, do not seed
  fake receivings, defects, or cartons. Reference masters (customers,
  products, materials, BOM) may be seeded as before.
- **Print engine.** Slips print through `#direct-print-stage` +
  `body.printing-slip` + native `window.print()` (defined in `src/main.ts`).
  Keep `@media print` rules in `src/style.css`.
- **Entry point.** `index.html` loads `/src/main.ts` (vanilla 5-screen app:
  grn, packing, repair, qc, admin). There is no React harness in this
  checkout; do not add a second entry without intent.
- **Docker parity.** `docker compose build` must succeed and the container
  must pass `/health` before a task is considered done.

## Quality gates (run before done)

- `npx tsc --noEmit` (`npm run lint`) — typecheck
- `npm run test:unit` — frontend logic/template/token regression suite (`tsx --test src/utils/requisitionLogic.test.ts`)
- `npm test` — backend/DB/order-integrity suite (`node --test`)
- `npx vite build` (`npm run build`) — frontend bundle builds
- `npm run test:e2e` — Playwright Chromium E2E & visual QA harness (`playwright.config.ts`, isolated via `MES_DB_PATH`)
- `npm run graphify` (`npx tsx scripts/graphify.ts update .`) — rebuilds `graphify-out/graph.json` and `graphify-out/GRAPH_REPORT.md` after every code change
- `docker compose build` + `curl -f http://127.0.0.1:3000/health`

## ECC & Playwright Verification Harness (Hard Rule)

**Everything Claude Code (`affaan-m/ECC`)** is installed in `.agents/` with always-on rule `.agents/rules/ecc-harness.md`:
- Use ECC skills/workflows (`tdd-workflow`, `e2e-testing`, `browser-qa`, `click-path-audit`, `verification-loop`, `delivery-gate`) whenever their scope applies.
- Never skip browser verification or leave manual browser inspection steps for the user when UI, CSS, DOM, nav, auth, forms, or interactive handlers change — iterate with targeted `npx playwright test -g "<test name>"` runs during edits, and run the full `npm run verify:all` gate (all E2E tests + `graphify`) once at the end of the batch before committing or reporting completion.

## Graphify Knowledge Graph Harness (`/graphify`)

This project maintains a persistent whole-project knowledge graph in `graphify-out/` (`graph.json`, `GRAPH_REPORT.md`, `wiki/index.md`, `graph.html`), powered by `.claude/skills/graphify/SKILL.md` and `scripts/graphify.ts`:
1. **Read Before Edit**: Consult `graphify-out/GRAPH_REPORT.md`, `graphify-out/wiki/index.md`, or run `npm run graphify:query -- "<question>"` (`npx tsx scripts/graphify.ts query "<question>"`) before reading raw files. The bare `graphify` binary is not on PATH here; always use the project script.
2. **End-of-Batch Graph Update**: Run `npx tsx scripts/graphify.ts update .` (`npm run graphify`, included in `npm run verify:all`) once at the end of a task/batch rather than via a per-edit `PostToolUse` hook, so `graphify-out/graph.json` and `graphify-out/GRAPH_REPORT.md` stay synchronized without paying a `tsx` launch cost on every file save.

## unslop Design Craft Harness

Installed locally at `.agents/skills/unslop/SKILL.md` (`heydamir/unslop`, `CC BY 4.0`):
1. **Direction & 9-Pass Craft**: Follow `.agents/skills/unslop/SKILL.md` ("quiet chrome, one bright moment", Warm/Graphite neutral ramps from `references/tokens.md`, sentence-case labels, weights `400`/`500`, and `tabular-nums`).
2. **Print vs. Screen Separation**: Shop-floor paper slips (`GRN`, `REQ`, `M-REQ`, `A-REQ`, `@media print`) must remain strictly 100% monochrome black-and-white for thermal/laser printers. Screen dashboards use CSS variables defined in `src/style.css`.

## Workflow

The dev-team `/specs → /plan → /build → /pr` workflow
(https://github.com/bdfinst/agentic-dev-team) is **not installed in this
checkout**: `.agentic-dev-team/` is absent, `skills.md` is absent, and the
plugin's hooks are not configured in `.claude/settings.json`. Do not invoke or
promise `/specs`, `/plan`, `/build`, or `/pr` unless the harness is restored.

Work on a feature branch, run the quality gates above before reporting done, and
run `/code-review` before every commit.

