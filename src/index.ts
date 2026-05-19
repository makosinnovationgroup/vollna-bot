import {
  fetchMessage,
  postReply,
  postRepost,
  verifySignature,
  type SlackBlock,
  type SlackMessage,
} from './slack';
import { generateCoverLetter, prequalify } from './claude';

export interface Env {
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  VOLLNA_BOT_ID: string;
  TARGET_CHANNEL_ID: string;
  QUALIFIED_CHANNEL_ID: string;
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

// Fresh `message` events carry the message content inline (text + blocks),
// so the autonomous path classifies straight from the event without a
// conversations.history round trip.
interface MessageEvent {
  type: 'message';
  subtype?: string;
  channel: string;
  ts: string;
  bot_id?: string;
  text?: string;
  blocks?: SlackBlock[];
}

type SlackEvent = ReactionAddedEvent | MessageEvent;

interface EventCallback {
  type: 'event_callback';
  event: SlackEvent;
}

type SlackPayload = UrlVerification | EventCallback | { type: string };

const DEDUP_TTL_SECONDS = 60 * 60 * 24 * 7;

// Diagnostic logging toggle. Flip to false to silence the `vollna ...`
// trace. The structured console.error in each handler's catch block is
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
      if (event.type === 'reaction_added') {
        ctx.waitUntil(handleReactionAdded(event, env));
      } else if (event.type === 'message') {
        ctx.waitUntil(handleMessage(event, env));
      }
      return new Response('ok', { status: 200 });
    }

    return new Response('ok', { status: 200 });
  },
};

// ⭐️ manual fallback path: a team member starred a Vollna post the
// autonomous prequalifier missed. The star IS the qualification, so this
// path skips prequalify and goes straight to publishing.
async function handleReactionAdded(
  event: ReactionAddedEvent,
  env: Env,
): Promise<void> {
  try {
    debug('vollna event', JSON.stringify(event));

    if (event.type !== 'reaction_added') return;
    if (event.reaction !== 'star') {
      debug('vollna skip: reaction is not star', event.reaction);
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

    // No prequalify gate: the human's ⭐️ is the qualification.
    await publishQualifiedLead(jobText, message, env);
  } catch (err) {
    console.error('handleReactionAdded failed', {
      channel: event.item?.channel,
      ts: event.item?.ts,
      reaction: event.reaction,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Autonomous path: a fresh Vollna post arrived. Pre-qualify it and, when it
// qualifies, publish it to the #upwork-qualified channel.
async function handleMessage(event: MessageEvent, env: Env): Promise<void> {
  try {
    // Only fresh, new messages. A set subtype means message_changed,
    // message_deleted, a bot edit, etc. — never a new Vollna post.
    if (event.subtype != null) return;
    if (event.bot_id !== env.VOLLNA_BOT_ID) return;
    if (event.channel !== env.TARGET_CHANNEL_ID) return;

    const channel = event.channel;
    const ts = event.ts;

    // The `auto:` prefix is a separate idempotency boundary from the `done:`
    // key the ⭐️ path uses, so both paths can fire on the same post without
    // colliding.
    const dedupKey = `auto:${channel}:${ts}`;

    const seen = await env.DEDUPE.get(dedupKey);
    if (seen) return;

    await env.DEDUPE.put(dedupKey, '1', { expirationTtl: DEDUP_TTL_SECONDS });

    // Fresh message events carry the content inline, so build the message
    // object directly rather than calling fetchMessage.
    const message: SlackMessage = {
      ts: event.ts,
      text: event.text,
      bot_id: event.bot_id,
      blocks: event.blocks,
    };

    const jobText = extractJobText(message);
    if (!jobText) return;

    const verdict = await prequalify(jobText, env);
    // Conservative: only an explicit YES triggers action. NO and MAYBE
    // fall through to the ⭐️ manual path.
    if (verdict !== 'YES') return;

    await publishQualifiedLead(jobText, message, env);
  } catch (err) {
    console.error('handleMessage failed', {
      channel: event.channel,
      ts: event.ts,
      bot_id: event.bot_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Convergence point for both paths: generate the cover letter, repost the
// lead into #upwork-qualified, and thread the letter under the repost. The
// bot never writes back to the vollna firehose channel.
async function publishQualifiedLead(
  jobText: string,
  message: SlackMessage,
  env: Env,
): Promise<void> {
  const letter = (await generateCoverLetter(jobText, env)).trim();
  // The qualifier (or the human ⭐️) said go, but the writer prompt may
  // still SKIP at generation time. Both checks are intentional.
  if (!letter || letter === 'SKIP') return;

  // Notification fallback string for the repost. postRepost strips the
  // inert `actions` blocks from `message.blocks` before sending.
  const fallbackText =
    message.text && message.text.trim().length > 0
      ? message.text
      : 'Qualified Upwork lead';

  const { ts: repostTs } = await postRepost(
    env.QUALIFIED_CHANNEL_ID,
    fallbackText,
    message.blocks,
    env,
  );

  await postReply(env.QUALIFIED_CHANNEL_ID, repostTs, letter, env);
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
