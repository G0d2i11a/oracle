---
name: oracle
description: Use Shawn's local workshop Oracle CLI/MCP under /Users/shawn/Workspace/oracle, primarily in ChatGPT browser mode with full-detail attachments, for debugging, refactors, design checks, PRDs, and cross-validation.
---

# Oracle (CLI) - best use

Oracle bundles your prompt + selected files into one “one-shot” request so another model can answer with real repo context (API or browser automation). Treat outputs as advisory: verify against the codebase + tests.

## Main use case (browser, GPT-5.5 Pro Extended)

Default workflow here: `--engine browser` with ChatGPT's GPT-5.5 Pro Extended target. The picker may render this as `5.5 Extended Pro`; in Shawn's workflow report it as `GPT-5.5 Pro Extended` / `Pro Extended`. This is the “human in the loop” path: it can take ~10 minutes to multiple hours; long-running/finalizing/Pro Extended progress UI is normal.

Recommended defaults:

- Engine: browser (`--engine browser`)
- Model: `--model gpt-5.5-pro` resolving to ChatGPT Pro Extended.
- Pro Extended selector: pass `--browser-thinking-time extended`. The flag name is historical; it selects Pro Extended and must not be changed to `heavy` unless Shawn explicitly asks for Thinking Heavy. In user-facing status, call this `Pro Extended`, not `thinking`, `thinkingTime`, or `Thought for ...`.
- Model selection: use `--browser-model-strategy select`; verify the live browser label, not metadata alone.
- Attachments: prefer `--browser-attachments always`; bundling text files is allowed only when it preserves the complete content.
- Evidence gate: if the run resolves to Thinking Heavy, `--browser-thinking-time heavy`, base GPT-5.5, Instant, Auto, or any non-Pro Extended label, mark it tainted and rerun the same full prompt/context on GPT-5.5 Pro Extended. If the artifact only says `configured`, `desiredModel`, `meta.json`, or "live picker proof was not re-run", that is also not valid proof. `Thought for ...` is only progress/completion UI after Pro Extended has been verified; it is not model proof.
- Subscription gate: if ChatGPT shows a subscription/plan/billing warning such as "error loading your subscription", refresh the same tab until it clears, then re-verify Pro Extended before submitting or harvesting. A completed Pro Extended-looking answer without final reasoning UI such as `Thought for ...` is tainted/downgrade-suspect and must be rerun with the same full prompt/context.

## Full-detail rule

Full-detail is the default in Shawn's workflow.

- Do not switch to a lite, small, summary, reduced-reference, reduced-attachment, or downgraded-model run to work around automation problems.
- If upload, model selection, Cloudflare, composer, or status detection fails, fix or retry the browser automation while preserving the same full prompt and references.
- Do not infer a hard attachment/context size limit from one failed browser run. Treat large-upload failures as automation/network/status problems unless a controlled upload-size test proves a threshold.
- If ChatGPT shows a Stop button, treat that as authoritative evidence that the run is still active. Keep waiting while the Stop button remains visible; do not stop the run, declare it timed out, or start a smaller replacement run.
- Finalizing answer, Pro Extended progress UI, iframe progress, or a sidecar progress indicator are also active-progress signals. Use them as additional evidence, but the Stop button alone is enough to keep waiting.
- If the CLI detaches or loses capture while the browser remains open, reattach to the stored session rather than sending a duplicate.

## Golden path

## Commands (preferred)

- Show help (once/session):
  - `npx -y @steipete/oracle --help`

- Preview (no tokens):
  - `npx -y @steipete/oracle --dry-run summary -p "<task>" --file "src/**" --file "!**/*.test.*"`
  - `npx -y @steipete/oracle --dry-run full -p "<task>" --file "src/**"`

- Token/cost sanity:
  - `npx -y @steipete/oracle --dry-run summary --files-report -p "<task>" --file "src/**"`

- Browser run (main path; long-running is normal):
  - `node /Users/shawn/Workspace/oracle/dist/bin/oracle-cli.js --engine browser --browser-attachments always --browser-model-strategy select --model gpt-5.5-pro --browser-thinking-time extended -p "<task>" --file "src/**"`

- Manual paste fallback (assemble bundle, copy to clipboard):
  - `npx -y @steipete/oracle --render --copy -p "<task>" --file "src/**"`
  - Note: `--copy` is a hidden alias for `--copy-markdown`.

## Attaching files (`--file`)

`--file` accepts files, directories, and globs. You can pass it multiple times; entries can be comma-separated.

- Include:
  - `--file "src/**"` (directory glob)
  - `--file src/index.ts` (literal file)
  - `--file docs --file README.md` (literal directory + file)

- Exclude (prefix with `!`):
  - `--file "src/**" --file "!src/**/*.test.ts" --file "!**/*.snap"`

- Defaults (important behavior from the implementation):
  - Default-ignored dirs: `node_modules`, `dist`, `coverage`, `.git`, `.turbo`, `.next`, `build`, `tmp` (skipped unless you explicitly pass them as literal dirs/files).
  - Honors `.gitignore` when expanding globs.
  - Does not follow symlinks (glob expansion uses `followSymbolicLinks: false`).
  - Dotfiles are filtered unless you explicitly opt in with a pattern that includes a dot-segment (e.g. `--file ".github/**"`).
  - Default cap: files > 1 MB are rejected unless you raise `ORACLE_MAX_FILE_SIZE_BYTES` or `maxFileSizeBytes` in `~/.oracle/config.json`.

## Budget + observability

- Target: keep total input under ~196k tokens.
- Use `--files-report` (and/or `--dry-run json`) to spot the token hogs before spending.
- If you need hidden/advanced knobs: `npx -y @steipete/oracle --help --verbose`.

## Engines (API vs browser)

- Auto-pick: uses `api` when `OPENAI_API_KEY` is set, otherwise `browser`.
- Browser engine supports GPT + Gemini only; use `--engine api` for Claude/Grok/Codex or multi-model runs.
- **API runs require explicit user consent** before starting because they incur usage costs.
- Browser attachments:
  - `--browser-attachments auto|never|always` (auto pastes inline up to ~60k chars then uploads).
  - In Shawn's full-detail workflow, use `always` unless explicitly told otherwise.
- Remote browser host (signed-in machine runs automation):
  - Host: `oracle serve --host 0.0.0.0 --port 9473 --token <secret>`
  - Client: `oracle --engine browser --remote-host <host:port> --remote-token <secret> -p "<task>" --file "src/**"`

## Sessions + slugs (don’t lose work)

- Stored under `~/.oracle/sessions` (override with `ORACLE_HOME_DIR`).
- Browser runs save durable files under `~/.oracle/sessions/<id>/artifacts/`, including `transcript.md`, Deep Research reports, and downloaded ChatGPT-generated images when available.
- Runs may detach or take a long time (browser + GPT-5.5 Extended Pro often does). If the CLI times out: don’t re-run; reattach.
  - List: `oracle status --hours 72`
  - Attach: `oracle session <id> --render`
- Use `--slug "<3-5 words>"` to keep session IDs readable.
- Duplicate prompt guard exists; use `--force` only when you truly want a fresh run.

## Prompt template (high signal)

Oracle starts with **zero** project knowledge. Assume the model cannot infer your stack, build tooling, conventions, or “obvious” paths. Include:

- Project briefing (stack + build/test commands + platform constraints).
- “Where things live” (key directories, entrypoints, config files, dependency boundaries).
- Exact question + what you tried + the error text (verbatim).
- Constraints (“don’t change X”, “must keep public API”, “perf budget”, etc).
- Desired output (“return patch plan + tests”, “list risky assumptions”, “give 3 options with tradeoffs”).

### “Exhaustive prompt” pattern (for later restoration)

When you know this will be a long investigation, write a prompt that can stand alone later:

- Top: 6–30 sentence project briefing + current goal.
- Middle: concrete repro steps + exact errors + what you already tried.
- Bottom: attach _all_ context files needed so a fresh model can fully understand (entrypoints, configs, key modules, docs).

If you need to reproduce the same context later, re-run with the same prompt + `--file …` set (Oracle runs are one-shot; the model doesn’t remember prior runs).

## Safety

- Don’t attach secrets by default (`.env`, key files, auth tokens). Redact aggressively; share only what’s required.
- Prefer “just enough context”: fewer files + better prompt beats whole-repo dumps.
