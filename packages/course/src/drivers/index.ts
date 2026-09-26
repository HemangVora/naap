import type { Car, CarSpec } from '@crumple/core';
import { GullibleDriver, llmConfig } from '@crumple/core';
import { ClaudeDriver } from './claude.js';
import { WebhookDriver } from './webhook.js';
import { OpenAICompatDriver } from './openai.js';
import type { CourseDriver } from './types.js';

export { ClaudeDriver } from './claude.js';
export { WebhookDriver, assertPublicUrl } from './webhook.js';
export { OpenAICompatDriver } from './openai.js';
export { McpDriver, MCP_AGENT_TIMEOUT_MS, MCP_POLL_MS } from './mcp.js';
export type { McpBarrier, NextBarrier, McpDriverOptions } from './mcp.js';
export { sanitiseActions, sanitisePayArgs, isAddress, isEnsName, MAX_ACTIONS } from './sanitize.js';
export type { CourseDriver } from './types.js';

/** Core's GullibleDriver, flagged offline so the UI can say so. */
export class OfflineGullibleDriver extends GullibleDriver implements CourseDriver {
  readonly kind = 'gullible' as const;
  readonly offline = true;
}

/**
 * Builds the driver for a car's BARE run (and the black-box driver a connected car uses in the airbag lane).
 * built + no LLM provider (no ANTHROPIC_API_KEY / OPENROUTER_API_KEY) → GullibleDriver flagged offline, so the pipeline still runs.
 */
export function driverFor(car: Car, spec: CarSpec, env: NodeJS.ProcessEnv = process.env): CourseDriver {
  switch (spec.kind) {
    case 'built': {
      const cfg = llmConfig(env);
      if (cfg.provider === 'none') return new OfflineGullibleDriver();
      return new ClaudeDriver(spec.persona, spec.model, cfg, undefined, { systemPrompt: spec.systemPrompt });
    }
    case 'mcp':
      // The owner's agent is bound to an MCP session held by the server; the server's registry hands out the McpDriver.
      throw new Error(`car ${car.id}: mcp cars are driven through the server's MCP session registry`);
    case 'webhook':
      if (!spec.endpoint) throw new Error(`car ${car.id}: webhook car has no endpoint`);
      return new WebhookDriver(spec.endpoint);
    case 'openai':
      if (!spec.endpoint || !spec.openaiModel || !spec.openaiApiKey) throw new Error(`car ${car.id}: openai car needs endpoint, model and key`);
      return new OpenAICompatDriver(spec.endpoint, spec.openaiModel, spec.openaiApiKey);
    default:
      throw new Error(`car ${car.id}: unknown kind ${(spec as CarSpec).kind}`);
  }
}
