import type { Env } from './index';

export interface SlackAttachment {
  title?: string;
  text?: string;
  fallback?: string;
}

export interface SlackBlockText {
  type: string;
  text: string;
}

export interface SlackBlock {
  type: string;
  block_id?: string;
  text?: SlackBlockText;
}

export interface SlackMessage {
  ts: string;
  text?: string;
  bot_id?: string;
  user?: string;
  attachments?: SlackAttachment[];
  blocks?: SlackBlock[];
}

interface ConversationsHistoryResponse {
  ok: boolean;
  messages?: SlackMessage[];
  error?: string;
}

export async function verifySignature(
  req: Request,
  body: string,
  signingSecret: string,
): Promise<boolean> {
  const timestamp = req.headers.get('x-slack-request-timestamp');
  const signature = req.headers.get('x-slack-signature');
  if (!timestamp || !signature) return false;

  const tsNum = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(tsNum)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > 60 * 5) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sigBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(`v0:${timestamp}:${body}`),
  );

  const hex = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const computed = `v0=${hex}`;

  return constantTimeEqual(computed, signature);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function fetchMessage(
  channel: string,
  ts: string,
  env: Env,
): Promise<SlackMessage | null> {
  const url = new URL('https://slack.com/api/conversations.history');
  url.searchParams.set('channel', channel);
  url.searchParams.set('latest', ts);
  url.searchParams.set('inclusive', 'true');
  url.searchParams.set('limit', '1');

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });

  if (!resp.ok) {
    console.error('fetchMessage HTTP error', resp.status);
    return null;
  }

  const data = (await resp.json()) as ConversationsHistoryResponse;
  if (!data.ok) {
    console.error('fetchMessage Slack error', data.error);
    return null;
  }
  if (!data.messages || data.messages.length === 0) return null;
  return data.messages[0];
}

export async function postReply(
  channel: string,
  threadTs: string,
  text: string,
  env: Env,
): Promise<void> {
  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });

  if (!resp.ok) {
    throw new Error(`Slack postMessage HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack postMessage error: ${data.error ?? 'unknown'}`);
  }
}
