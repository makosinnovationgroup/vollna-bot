import Anthropic from '@anthropic-ai/sdk';
import type { Env } from './index';
import { SYSTEM_PROMPT } from './prompts';

const SIGNERS = ['Adam', 'Ahmad'] as const;

export async function generateCoverLetter(jobText: string, env: Env): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const signer = SIGNERS[Math.floor(Math.random() * SIGNERS.length)];
  const userTurn = `SIGNER: ${signer}\n\n${jobText}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    temperature: 0.3,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userTurn }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return '';
  return textBlock.text;
}
