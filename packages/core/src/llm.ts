// One place that decides how LLM + Jev calls are routed. Verified 2026-09-26 19:15 JST:
// - Anthropic SDK works through OpenRouter: new Anthropic({ apiKey: OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api' })
//   with model ids 'anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5'.
// - Jev works through OpenRouter's decisions endpoint (NOT chat/completions):
//   POST https://openrouter.ai/api/alpha/decisions, Authorization: Bearer OPENROUTER_API_KEY
//   body { model: '~typesafe/jev-latest', state: string | object | array,
//          questions: { <name>: { type: 'noul', instructions: '<yes/no question>', criteria?: { true?, false? } } } }
//   → { model: 'typesafe/jev-1.13-20260917', answers: { <name>: { type: 'noul', noul: 0.96 } }, usage: {…, cost }, provider: 'TypeSafe' }
//   ~0.35 s round trip from Tokyo; several questions per call is fine (batch them).

const OPENROUTER_MODEL: Record<string, string> = {
  'claude-haiku-4-5-20251001': 'anthropic/claude-haiku-4.5',
  'claude-sonnet-5': 'anthropic/claude-sonnet-5',
};

export interface LlmConfig {
  provider: 'anthropic' | 'openrouter' | 'none';
  apiKey?: string;
  baseURL?: string;
  /** Map a canonical Anthropic model id to the provider's id. */
  model(id: string): string;
}

/** Anthropic key wins; otherwise OpenRouter; otherwise none (callers fall back to offline fakes). */
export function llmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  if (env.ANTHROPIC_API_KEY) return { provider: 'anthropic', apiKey: env.ANTHROPIC_API_KEY, model: (id) => id };
  if (env.OPENROUTER_API_KEY)
    return { provider: 'openrouter', apiKey: env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api', model: (id) => OPENROUTER_MODEL[id] ?? id };
  return { provider: 'none', model: (id) => id };
}

export interface JevConfig {
  provider: 'typesafe' | 'openrouter' | 'none';
  apiKey?: string;
  /** Full URL to POST { model, state, questions } to. */
  url?: string;
  model?: string;
}

export function jevConfig(env: Record<string, string | undefined> = process.env): JevConfig {
  if (env.TYPESAFE_API_KEY) return { provider: 'typesafe', apiKey: env.TYPESAFE_API_KEY, url: 'https://api.typesafe.ai/v1/systemone' };
  if (env.OPENROUTER_API_KEY)
    return { provider: 'openrouter', apiKey: env.OPENROUTER_API_KEY, url: 'https://openrouter.ai/api/alpha/decisions', model: '~typesafe/jev-latest' };
  return { provider: 'none' };
}
