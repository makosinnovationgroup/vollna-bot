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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }

    const retryNum = req.headers.get('x-slack-retry-num');
    if (retryNum) {
      console.log('vollna skip: slack retry', {
        retryNum,
        reason: req.headers.get('x-slack-retry-reason'),
      });
      return new Response('ok', { status: 200 });
    }

    const body = await req.text();

    const ok = await verifySignature(req, body, env.SLACK_SIGNING_SECRET);
    if (!ok) {
      console.warn('vollna: signature verification failed');
      return new Response('invalid signature', { status: 401 });
    }

    let payload: SlackPayload;
    try {
      payload = JSON.parse(body) as SlackPayload;
    } catch {
      return new Response('invalid json', { status: 400 });
    }

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
    console.log('vollna event', JSON.stringify(event));

    if (event.type !== 'reaction_added') return;
    if (event.reaction !== '+1') {
      console.log('vollna skip: reaction is not +1', event.reaction);
      return;
    }
    if (!event.item || event.item.type !== 'message') {
      console.log('vollna skip: reacted item is not a message', event.item?.type);
      return;
    }
    if (event.item.channel !== env.TARGET_CHANNEL_ID) {
      console.log('vollna skip: wrong channel', {
        got: event.item.channel,
        expected: env.TARGET_CHANNEL_ID,
      });
      return;
    }

    const channel = event.item.channel;
    const ts = event.item.ts;
    const dedupKey = `done:${channel}:${ts}`;

    const seen = await env.DEDUPE.get(dedupKey);
    if (seen) {
      console.log('vollna skip: already processed', dedupKey);
      return;
    }

    await env.DEDUPE.put(dedupKey, '1', { expirationTtl: DEDUP_TTL_SECONDS });

    const message = await fetchMessage(channel, ts, env);
    if (!message) {
      console.log('vollna skip: fetchMessage returned null', { channel, ts });
      return;
    }

    console.log('vollna debug', JSON.stringify(message));

    console.log('vollna bot_id', {
      got: message.bot_id ?? null,
      expected: env.VOLLNA_BOT_ID,
      match: message.bot_id === env.VOLLNA_BOT_ID,
    });

    if (message.bot_id !== env.VOLLNA_BOT_ID) {
      console.log('vollna skip: bot_id mismatch');
      return;
    }

    const jobText = extractJobText(message);
    if (!jobText) {
      console.log('vollna skip: no job text extracted from message');
      return;
    }
    console.log('vollna jobText', JSON.stringify(jobText));

    const reply = (await generateCoverLetter(jobText, env)).trim();
    if (!reply || reply === 'SKIP') {
      console.log('vollna skip: model returned', reply === 'SKIP' ? 'SKIP' : 'empty');
      return;
    }

    await postReply(channel, ts, reply, env);
    console.log('vollna posted reply', { channel, ts, replyChars: reply.length });
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
  if (message.text) parts.push(message.text);
  if (Array.isArray(message.attachments)) {
    for (const att of message.attachments) {
      if (att.title) parts.push(att.title);
      if (att.text) parts.push(att.text);
      else if (att.fallback) parts.push(att.fallback);
    }
  }
  return parts.join('\n\n').trim();
}
