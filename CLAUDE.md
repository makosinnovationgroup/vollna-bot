# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Hard rules

Read SECURITY.md before suggesting any dependency changes. All package.json versions must be exact. Never run npm install without --ignore-scripts. No GitHub Actions workflows. Deploys are manual.

## Commands

```sh
npm ci --ignore-scripts        # install from lockfile (use after initial scaffold)
npm run typecheck              # tsc --noEmit
npx wrangler dev               # local dev (reads .dev.vars; emulates KV)
npx wrangler deploy            # manual deploy from local — no CI is configured
npx wrangler kv namespace create DEDUPE   # one-time, needed before deploy
npx wrangler secret put <NAME>            # set SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, ANTHROPIC_API_KEY, VOLLNA_BOT_ID, TARGET_CHANNEL_ID
```

There are no unit tests yet — the test loop is `wrangler dev` plus a Slack event tunneled in.

## Security constraints active in this project

These came from an active npm supply-chain attack flagged 2026-05-11. They apply to **every dependency change**, not just the initial scaffold:

- **Pin exact versions** in `package.json`. No `^`, `~`, or `*`. The lockfile alone is not the contract — the manifest is.
- **Install with `--ignore-scripts`.** Use `npm ci --ignore-scripts` for reproducible installs. Never run a bare `npm install`.
- **Before adding any dependency,** confirm it is not on the compromised list: `@tanstack/*`, `@uipath/*`, `@mistralai/*`, `@squawk/*`, `@opensearch-project/opensearch`, `guardrails-ai`, `intercom-client@7.0.4-7.0.5`, `lightning`. Run `npm view <pkg> version` first.
- **After install,** sweep `node_modules` for the IOC filenames: `router_init.js`, `setup.mjs`, `gh-token-monitor*`, `bun_environment.js`, `setup_bun.js`, `router_runtime.js`. Report any hits before continuing.
- **Wrangler is local-only.** Do not install it globally. Always invoke via `npx`.
- **No GitHub Actions.** CI/CD is deliberately deferred. Do not create `.github/workflows/*`.
- **No `eval`, no dynamic `require`, no shelling out from request input.**

## Architecture

Single Cloudflare Worker, one fetch handler, async fan-out via `ctx.waitUntil`.

**Request path (`src/index.ts`):**
1. `req.text()` is called once and the raw body string is passed to `verifySignature` — re-reading the body after verification would consume the stream.
2. Slack signature verification is HMAC-SHA256 over `v0:{timestamp}:{body}` using `SLACK_SIGNING_SECRET`. Timestamps older than 5 minutes are rejected (replay protection). Comparison is constant-time. Implemented with Web Crypto in `src/slack.ts:verifySignature` — do not pull in `node:crypto`; it is not available in the Workers runtime.
3. `url_verification` is answered synchronously with `payload.challenge` as `text/plain`.
4. `event_callback` is queued via `ctx.waitUntil(handleEvent(...))` and the worker returns 200 immediately. Slack retries on non-2xx, so the ack must come back fast regardless of how long the model call takes.

**`handleEvent` filter pipeline:**
1. Cheap filters first: `type=reaction_added`, `reaction='+1'`, `item.type='message'`, `item.channel === TARGET_CHANNEL_ID`.
2. KV dedup check: key is `done:{channel}:{ts}`, TTL 7 days. The same key is written at the end whether we posted or skipped, so SKIPs don't re-fire on the next 👍.
3. `conversations.history` fetch (`channel`, `latest=ts`, `inclusive=true`, `limit=1`) to get the message body.
4. **Second-stage `bot_id === VOLLNA_BOT_ID` filter.** This runs *after* the API fetch because Slack's `reaction_added` event does not carry the original message's `bot_id`. Reactions on human messages will silently be filtered here.
5. `generateCoverLetter` → Anthropic Messages API (`claude-sonnet-4-6`, `max_tokens: 1024`). System prompt is `SYSTEM_PROMPT` from `src/prompts.ts`; the Slack message text goes in as the user turn.
6. If the model returns empty or exactly `SKIP`, the dedup key is written and the handler exits without posting. Otherwise the reply is posted as a threaded message (`thread_ts = ts`).

**Module boundaries:**
- `src/index.ts` — fetch handler, event filtering, dedup, `Env` interface (the source of truth for bindings/secrets).
- `src/slack.ts` — signature verification + the two Slack Web API calls (`conversations.history`, `chat.postMessage`).
- `src/claude.ts` — Anthropic SDK client + response unwrapping.
- `src/prompts.ts` — the system prompt template. Has two `TODO` markers (capability list, team signatures) that must be filled before the bot produces useful output.

`slack.ts` and `claude.ts` both `import type { Env } from './index'`. This is a circular type-only import — fine because nothing runtime crosses the cycle. If you add a real runtime export to `index.ts` that `slack.ts` or `claude.ts` consumes, lift `Env` to a separate types module first.

## Conventions worth knowing

- **Secrets vs. bindings:** the five string secrets are set via `wrangler secret put` and surface on the `Env` interface as plain strings. The KV namespace is configured in `wrangler.toml` and surfaces as `Env.DEDUPE: KVNamespace`. The `wrangler.toml` `id` placeholder must be replaced before first deploy.
- **Always set the dedup key, even on no-op paths.** This prevents repeated model calls when someone keeps reacting to a SKIPped message.
- **Don't add error handling around the model call to retry inside the handler.** Slack already retries failed deliveries; a model failure should bubble up so the dedup key is *not* set and the next retry attempt has a chance to succeed.
- **Don't widen the reaction filter to `thumbsup` etc.** Slack always normalizes to `+1` in the event payload regardless of which thumbs-up variant the user picked.
