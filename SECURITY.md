# Security Policy

## Purpose

This project enforces strict dependency hygiene because of ongoing npm supply chain attacks — specifically the Mini Shai-Hulud wave that began May 2026 and is still propagating via stolen OIDC tokens through CI/CD pipelines. Any contributor working in this repo (current or future, including the original author) must follow the rules below. They are not optional and not negotiable per-PR.

## Dependency Rules

- All versions in `package.json` are pinned exactly. No caret (`^`), tilde (`~`), or wildcard (`*`) ranges under any circumstances. PRs that introduce range specifiers are rejected.
- New dependencies require justification in the PR description and a Socket.dev or Snyk check before merging.
- Use `npm ci` for all installs after the initial scaffold. Do not use `npm install` except when adding a new pinned dependency — and even then with `--ignore-scripts`.
- When adding a new package: run `npm install <pkg>@<exact-version> --ignore-scripts --save-exact`, then manually inspect `node_modules/<pkg>/package.json` for lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`) before committing. If any are present, read them.
- Global npm installs are forbidden in this project's workflow. `wrangler` runs via `npx`.

## Prohibited Packages

Known compromised in the May 2026 (Mini Shai-Hulud) wave:

- `@tanstack/*` — entire TanStack scope
- `@uipath/*` — entire UiPath scope
- `@mistralai/*` — entire Mistral AI npm scope
- `@squawk/*` — entire Squawk scope
- `@opensearch-project/opensearch` — OpenSearch JavaScript client
- `guardrails-ai`
- `intercom-client@7.0.4`, `intercom-client@7.0.5`
- `lightning@2.6.2`, `lightning@2.6.3`

This list is not exhaustive. The attack is still active. Before adding any new dependency, check [socket.dev](https://socket.dev) for current advisories on that package and its transitive dependencies.

## CI/CD Policy

- No GitHub Actions workflows are permitted in this repo at this time. The May 2026 attack chain exploited `pull_request_target` misconfigurations and extracted OIDC tokens from GitHub Actions runners. Deploys are manual via `npx wrangler deploy` from a trusted local environment.
- When CI is eventually added, it must:
  - Pin every action to a 40-character commit SHA (`actions/checkout@<sha>`). Never floating tags like `@v1`, `@main`, or `@latest`.
  - Scope `permissions:` per workflow to least-privilege OIDC. Default to `permissions: {}` and grant only what each job needs.
  - Gate any publish or deploy step behind a manual approval (GitHub Environments with required reviewers).
  - Never use `pull_request_target` with checkout of the PR head.

## Secrets Policy

- Worker secrets (`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `VOLLNA_BOT_ID`, `TARGET_CHANNEL_ID`) live only in Cloudflare's secret store, set via `npx wrangler secret put`. They never appear in source, in `.env` files committed to the repo, or in CI logs.
- `.dev.vars` (local development secrets) is gitignored. Only `.dev.vars.example` is tracked.
- If a secret is ever committed accidentally, **rotate it before reverting**. Git history is not a safe place for retracted secrets — assume anything pushed is compromised, even if the commit is later removed.

## Incident Response

- If a dependency is found to be compromised after install: rotate every secret reachable from the affected machine — Cloudflare API token, GitHub PAT, npm token (if any), Anthropic API key, Slack bot token. Then audit the install host (shell history, recent processes, outbound connections, browser session cookies) before reinstalling anything.
- Do not delete the affected `node_modules` directory before imaging it if forensics may be needed. Tar it to a quarantine path on a separate disk first, then reinstall in a clean tree.

## Reporting

Suspected supply chain issues or accidental secret exposure: contact the repo owner directly. Do not open a public issue.
