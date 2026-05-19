import Anthropic from '@anthropic-ai/sdk';
import type { Env } from './index';
import { QUALIFIER_SYSTEM_PROMPT, SYSTEM_PROMPT } from './prompts';

export async function generateCoverLetter(jobText: string, env: Env): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // The signer (Adam vs Ahmad) is chosen by the model based on the job's
  // primary practice — see CHOOSING THE SIGNER in the system prompt.
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    temperature: 0.3,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `<job_notification>${jobText}</job_notification>`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return '';
  return textBlock.text;
}

export async function prequalify(
  jobText: string,
  env: Env,
): Promise<'YES' | 'NO' | 'MAYBE'> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16,
    system: [
      {
        type: 'text',
        text: QUALIFIER_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: jobText }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return 'NO';

  const verdict = textBlock.text.trim();
  if (verdict === 'YES' || verdict === 'NO' || verdict === 'MAYBE') {
    return verdict;
  }

  // Ambiguous output means don't act.
  return 'NO';
}
