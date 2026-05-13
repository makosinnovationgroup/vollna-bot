# vollna-bot

A Cloudflare Worker that watches a Slack channel for 👍 reactions on Vollna's Upwork job notifications and replies in-thread with an AI-generated proposal opener via the Anthropic Messages API.

## Setup

Install dependencies with lifecycle scripts disabled (active npm supply-chain attack as of 2026-05-11):

```sh
npm install --ignore-scripts
```

For all subsequent installs after the lockfile is committed, use:

```sh
npm ci --ignore-scripts
```

## Create the DEDUPE KV namespace

```sh
npx wrangler kv namespace create DEDUPE
```

Copy the returned `id` value into `wrangler.toml` in place of `REPLACE_WITH_KV_NAMESPACE_ID`.

## Set secrets

The worker reads five secrets at runtime. Set each one for the deployed environment:

```sh
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put VOLLNA_BOT_ID
npx wrangler secret put TARGET_CHANNEL_ID
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in the values. `.dev.vars` is gitignored.

## Slack app configuration checklist

- Create a Slack app and install it into the workspace where Vollna posts.
- Bot Token Scopes: `channels:history`, `groups:history`, `chat:write`, `reactions:read`.
- Event Subscriptions: enable, point Request URL at the deployed worker, subscribe to `reaction_added`.
- Invite the bot to the target channel.
- Note the bot's `bot_id` for the Vollna notification bot — that is `VOLLNA_BOT_ID`. Find it by reading a Vollna message via `conversations.history`.
- Note the target channel id — that is `TARGET_CHANNEL_ID`.
- Copy the Signing Secret from the app's Basic Information page — that is `SLACK_SIGNING_SECRET`.

## Local development

```sh
npx wrangler dev
```

Wrangler reads `.dev.vars` and uses a local KV simulator.

## Deploy

```sh
npx wrangler deploy
```

Deploy is run manually from local for now. No GitHub Actions workflow is configured.

## Behavior

1. Slack POSTs a `reaction_added` event to the worker.
2. The worker verifies the Slack signature (HMAC-SHA256 over `v0:{ts}:{body}`) and rejects requests older than 5 minutes.
3. If the reaction is 👍 on a message in `TARGET_CHANNEL_ID`, the worker queues `handleEvent` via `ctx.waitUntil` and returns 200 immediately.
4. `handleEvent` dedupes via KV (`done:{channel}:{ts}`, 7-day TTL), fetches the message, confirms `bot_id` matches `VOLLNA_BOT_ID`, and calls the Anthropic API.
5. If the model returns `SKIP` (or empty), the dedup key is set and the worker exits without posting.
6. Otherwise the response is posted as a threaded reply.
