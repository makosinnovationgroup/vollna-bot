import {
  fetchMessage,
  postReply,
  verifySignature,
  type SlackMessage,
} from './slack';
import { generateCoverLetter } from './claude';

export interface Env {
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  VOLLNA_BOT_ID: string;
  TARGET_CHANNEL_ID: string;
  DEDUPE: KVNamespace;
}

interface UrlVerification {
  type: 'url_verification';
  challenge: string;
}

interface ReactionAddedEvent {
  type: 'reaction_added';
  reaction: string;
  item: {
    type: string;
    channel: string;
    ts: string;
  };
}

interface EventCallback {
  type: 'event_callback';
  event: ReactionAddedEvent;
}

type SlackPayload = UrlVerification | EventCallback | { type: string };

const DEDUP_TTL_SECONDS = 60 * 60 * 24 * 7;

// Diagnostic logging toggle. Flip to false to silence the `vollna ...`
// trace. The structured console.error in handleEvent's catch block is
// always on regardless of this flag.
const DEBUG = true;

function debug(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }

    if (req.headers.get('x-slack-retry-num')) {
      debug('vollna fetch: slack retry, short-circuiting', {
        retryNum: req.headers.get('x-slack-retry-num'),
        reason: req.headers.get('x-slack-retry-reason'),
      });
      return new Response('ok', { status: 200 });
    }

    const body = await req.text();

    const ok = await verifySignature(req, body, env.SLACK_SIGNING_SECRET);
    if (!ok) {
      debug('vollna fetch: signature verification failed');
      return new Response('invalid signature', { status: 401 });
    }

    let payload: SlackPayload;
    try {
      payload = JSON.parse(body) as SlackPayload;
    } catch {
      return new Response('invalid json', { status: 400 });
    }

    debug('vollna fetch: payload type', payload.type);

    if (payload.type === 'url_verification') {
      const challenge = (payload as UrlVerification).challenge;
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (payload.type === 'event_callback') {
      const event = (payload as EventCallback).event;
      ctx.waitUntil(handleEvent(event, env));
      return new Response('ok', { status: 200 });
    }

    return new Response('ok', { status: 200 });
  },
};

async function handleEvent(event: ReactionAddedEvent, env: Env): Promise<void> {
  try {
    debug('vollna event', JSON.stringify(event));

    if (event.type !== 'reaction_added') return;
    if (event.reaction !== '+1') {
      debug('vollna skip: reaction is not +1', event.reaction);
      return;
    }
    if (!event.item || event.item.type !== 'message') {
      debug('vollna skip: reacted item is not a message', event.item?.type);
      return;
    }
    if (event.item.channel !== env.TARGET_CHANNEL_ID) {
      debug('vollna skip: wrong channel', {
        got: event.item.channel,
        expected: env.TARGET_CHANNEL_ID ?? null,
      });
      return;
    }

    const channel = event.item.channel;
    const ts = event.item.ts;
    const dedupKey = `done:${channel}:${ts}`;

    const seen = await env.DEDUPE.get(dedupKey);
    if (seen) {
      debug('vollna skip: already processed', dedupKey);
      return;
    }

    await env.DEDUPE.put(dedupKey, '1', { expirationTtl: DEDUP_TTL_SECONDS });

    const message = await fetchMessage(channel, ts, env);
    if (!message) {
      debug('vollna skip: fetchMessage returned null', { channel, ts });
      return;
    }

    debug('vollna message', JSON.stringify(message));
    debug('vollna bot_id', {
      got: message.bot_id ?? null,
      expected: env.VOLLNA_BOT_ID ?? null,
      match: message.bot_id === env.VOLLNA_BOT_ID,
    });
    if (message.bot_id !== env.VOLLNA_BOT_ID) {
      debug('vollna skip: bot_id mismatch');
      return;
    }

    const jobText = extractJobText(message);
    if (!jobText) {
      debug('vollna skip: empty jobText after extraction');
      return;
    }
    debug('vollna jobText', JSON.stringify(jobText));

    const reply = (await generateCoverLetter(jobText, env)).trim();
    debug('vollna reply', JSON.stringify(reply));
    if (!reply || reply === 'SKIP') {
      debug('vollna skip: model returned', reply === 'SKIP' ? 'SKIP' : 'empty');
      return;
    }

    await postReply(channel, ts, reply, env);
    debug('vollna posted reply', { channel, ts, replyChars: reply.length });
  } catch (err) {
    console.error('handleEvent failed', {
      channel: event.item?.channel,
      ts: event.item?.ts,
      reaction: event.reaction,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function extractJobText(message: SlackMessage): string {
  const parts: string[] = [];

  // Vollna posts structured content as Block Kit `blocks`. The job
  // title, description, screening questions, budget, and client
  // signals all live in `section` blocks; `actions` and `divider`
  // blocks carry no proposal-relevant text.
  if (Array.isArray(message.blocks)) {
    for (const block of message.blocks) {
      if (block.type === 'section' && block.text?.text) {
        parts.push(block.text.text);
      }
    }
  }

  // Fallback for non-Block-Kit messages: the flat `text` field.
  if (parts.length === 0 && message.text) {
    parts.push(message.text);
  }

  // Legacy attachments, kept for backward compatibility.
  if (Array.isArray(message.attachments)) {
    for (const att of message.attachments) {
      if (att.title) parts.push(att.title);
      if (att.text) parts.push(att.text);
      else if (att.fallback) parts.push(att.fallback);
    }
  }

  return parts.join('\n\n').trim();
}
