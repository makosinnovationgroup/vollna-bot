import Anthropic from '@anthropic-ai/sdk';
import type { Env } from './index';
import { SYSTEM_PROMPT } from './prompts';

export async function generateCoverLetter(jobText: string, env: Env): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: jobText }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return '';
  return textBlock.text;
}
