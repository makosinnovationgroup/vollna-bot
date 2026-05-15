import Anthropic from '@anthropic-ai/sdk';
import type { Env } from './index';
import { SYSTEM_PROMPT } from './prompts';

export async function generateCoverLetter(jobText: string, env: Env): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // The signer (Adam vs Ahmad) is chosen by the model based on the job's
  // primary practice — see CHOOSING THE SIGNER in the system prompt.
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    temperature: 0.3,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: jobText }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return '';
  return textBlock.text;
}
