// LlmClient — the one seam between Sekisho and Claude. Tests inject a scripted client; the server
// injects the Anthropic one when ANTHROPIC_API_KEY is present and the heuristic one otherwise.
// Both LLM calls return raw JSON that planner.ts / reader.ts validate in code.
import Anthropic from '@anthropic-ai/sdk';
import { llmConfig, type LlmConfig } from '@crumple/core';
import { PLANNER_SYSTEM_PROMPT, PLAN_SCHEMA, plannerUserMessage, type PlannerInput } from './planner.js';
import { READER_SYSTEM_PROMPT, READER_SCHEMA, readerUserMessage, type ReaderInput } from './reader.js';
import { ADDRESS_RE } from './util.js';

export interface LlmClient {
  /** false when a fake / heuristic is standing in for Claude — the UI must say "offline" */
  readonly live: boolean;
  readonly plannerModel: string;
  readonly readerModel: string;
  plan(input: PlannerInput): Promise<unknown>;
  read(input: ReaderInput): Promise<unknown>;
}

export const PLANNER_MODEL = 'claude-sonnet-5';
export const READER_MODEL = 'claude-haiku-4-5-20251001';

// ─── Anthropic (direct or via OpenRouter — see packages/core/src/llm.ts) ────

export interface AnthropicLlmOptions {
  /** From core `llmConfig()`. Provider 'none' is rejected here — use llmFromEnv() to get the offline client instead. */
  config?: LlmConfig;
  client?: Anthropic;
  plannerModel?: string;
  readerModel?: string;
  /** per-call timeout, ms (default 30 s — a barrier must not stall the arena) */
  timeoutMs?: number;
  /** output ceilings; OpenRouter reserves credit for max_tokens, so keep these tight (plan ≈ 300 tokens, read ≈ 800) */
  maxTokens?: { plan?: number; read?: number };
}

type JsonMode = 'output_config' | 'tool';

interface StructuredReq {
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  toolName: string;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
}

/**
 * Real Claude. Static system prompts carry a cache breakpoint; the per-barrier text comes after it.
 * JSON is requested with `output_config.format` (structured outputs). A proxy that rejects that field
 * gets a forced strict tool instead; the working mode is remembered per model.
 */
export class AnthropicLlmClient implements LlmClient {
  readonly live = true;
  readonly plannerModel: string;
  readonly readerModel: string;
  readonly provider: LlmConfig['provider'];
  private client: Anthropic;
  private timeoutMs: number;
  private maxTokens: { plan: number; read: number };
  private mode = new Map<string, JsonMode>();

  /** Which JSON mode worked for a model so far ('output_config' = structured outputs, 'tool' = forced strict tool). */
  jsonMode(model: string): JsonMode | undefined {
    return this.mode.get(model);
  }

  constructor(opts: AnthropicLlmOptions = {}) {
    const cfg = opts.config ?? llmConfig();
    if (cfg.provider === 'none' && !opts.client) throw new Error('AnthropicLlmClient: no LLM credentials (ANTHROPIC_API_KEY / OPENROUTER_API_KEY)');
    this.provider = cfg.provider;
    this.client = opts.client ?? new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
    this.plannerModel = cfg.model(opts.plannerModel ?? PLANNER_MODEL);
    this.readerModel = cfg.model(opts.readerModel ?? READER_MODEL);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxTokens = { plan: opts.maxTokens?.plan ?? 1500, read: opts.maxTokens?.read ?? 2500 };
  }

  plan(input: PlannerInput): Promise<unknown> {
    return this.structured({
      model: this.plannerModel,
      system: PLANNER_SYSTEM_PROMPT,
      user: plannerUserMessage(input),
      schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
      toolName: 'emit_plan',
      effort: 'low',
      maxTokens: this.maxTokens.plan,
    });
  }

  read(input: ReaderInput): Promise<unknown> {
    return this.structured({
      model: this.readerModel,
      system: READER_SYSTEM_PROMPT,
      user: readerUserMessage(input),
      schema: READER_SCHEMA as unknown as Record<string, unknown>,
      toolName: 'emit_reading',
      maxTokens: this.maxTokens.read,
    });
  }

  private async structured(req: StructuredReq): Promise<unknown> {
    const mode = this.mode.get(req.model) ?? 'output_config';
    if (mode === 'output_config') {
      try {
        const out = await this.viaOutputConfig(req);
        this.mode.set(req.model, 'output_config');
        return out;
      } catch (e) {
        if (!(e instanceof Anthropic.BadRequestError)) throw e;
        this.mode.set(req.model, 'tool'); // proxy does not accept output_config — remember and fall back
      }
    }
    return this.viaTool(req);
  }

  private async viaOutputConfig(req: StructuredReq): Promise<unknown> {
    const response = await this.client.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }],
        output_config: { ...(req.effort ? { effort: req.effort } : {}), format: { type: 'json_schema', schema: req.schema } },
      },
      { timeout: this.timeoutMs },
    );
    return firstJson(response);
  }

  private async viaTool(req: StructuredReq): Promise<unknown> {
    const response = await this.client.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `${req.user}\n\nCall the ${req.toolName} tool exactly once with your answer.` }],
        tools: [{ name: req.toolName, description: 'Return the structured answer.', strict: true, input_schema: req.schema as Anthropic.Tool['input_schema'] }],
        tool_choice: { type: 'tool', name: req.toolName },
      },
      { timeout: this.timeoutMs },
    );
    if (response.stop_reason === 'refusal') throw new Error('model refused');
    const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === req.toolName);
    if (!call) throw new Error(`model did not call ${req.toolName}`);
    return call.input;
  }
}

function firstJson(response: Anthropic.Message): unknown {
  if (response.stop_reason === 'refusal') throw new Error('model refused');
  if (response.stop_reason === 'max_tokens') throw new Error('model output truncated');
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  // some proxies wrap JSON in a code fence
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  return JSON.parse(fenced ? fenced[1] : text);
}

// ─── Scripted (tests) ────────────────────────────────────────────────────────

export interface Script {
  plan: (input: PlannerInput) => unknown | Promise<unknown>;
  read: (input: ReaderInput) => unknown | Promise<unknown>;
}

/** Deterministic client for tests. Records every call so a test can assert what each stage saw. */
export class ScriptedLlmClient implements LlmClient {
  readonly live = false;
  readonly plannerModel = 'scripted';
  readonly readerModel = 'scripted';
  planCalls: PlannerInput[] = [];
  readCalls: ReaderInput[] = [];
  constructor(private script: Script) {}
  async plan(input: PlannerInput) {
    this.planCalls.push(input);
    return this.script.plan(input);
  }
  async read(input: ReaderInput) {
    this.readCalls.push(input);
    return this.script.read(input);
  }
}

// ─── Heuristic (offline dev, no key) ─────────────────────────────────────────

/**
 * Regex stand-in for Claude so the whole pipeline runs with no ANTHROPIC_API_KEY. It is
 * deliberately naive: it exists to exercise provenance + policy offline, not to be clever.
 */
export class HeuristicLlmClient implements LlmClient {
  readonly live = false;
  readonly plannerModel = 'heuristic';
  readonly readerModel = 'heuristic';

  async plan(input: PlannerInput): Promise<unknown> {
    const req = input.ownerRequest;
    const ens = input.mandatePayees.find((p) => req.toLowerCase().includes(p.toLowerCase()));
    const money = /\$\s?(\d+(?:\.\d+)?)/.exec(req);
    const wantsBuy = /\b(buy|purchase|pay|order|subscribe)\b/i.test(req);
    if (wantsBuy && ens) {
      const maxUsd = money ? Number(money[1]) : null;
      return {
        note: `buy from ${ens}${maxUsd != null ? ` for at most $${maxUsd}` : ''}`,
        steps: [
          { op: 'fetch_quote', payee: ens, ref: 'q', kind: null, amount: null, maxUsd: null, memo: null, reason: null },
          { op: 'pay', payee: ens, ref: null, kind: null, amount: '$q.amount', maxUsd, memo: 'owner purchase', reason: null },
        ],
      };
    }
    return { note: 'read-only request', steps: [{ op: 'read', payee: null, ref: null, kind: null, amount: null, maxUsd: null, memo: null, reason: null }] };
  }

  async read(input: ReaderInput): Promise<unknown> {
    const quotes: unknown[] = [];
    const paymentRequests: unknown[] = [];
    for (const i of input.indexes) {
      const it = input.items[i];
      const addr = it.text.match(ADDRESS_RE.source.replace(/^\^|\$$/g, ''))?.[0] ?? null;
      const amt = /\$\s?(\d+(?:\.\d+)?)/.exec(it.text);
      const token = /\bDRB\b/.test(it.text) ? 'DRB' : 'USDC';
      if (it.kind === 'http402') {
        const payTo = /payTo\W+(0x[0-9a-fA-F]{40})/.exec(it.text)?.[1] ?? addr;
        const priceUsd = /priceUsd\D{0,4}(\d+(?:\.\d+)?)/.exec(it.text)?.[1] ?? amt?.[1];
        const baseUnits = /maxAmountRequired\D{0,4}(\d+)/.exec(it.text)?.[1];
        const price = priceUsd != null ? Number(priceUsd) : baseUnits != null ? Number(baseUnits) / 1e6 : null;
        if (payTo && price != null) quotes.push({ itemIndex: i, from: it.source, payTo, amountUsd: price, token, resource: it.source });
      } else if (/\b(send|pay|transfer|prize|accept)\b/i.test(it.text) || addr) {
        paymentRequests.push({
          itemIndex: i,
          payTo: addr,
          amountUsd: amt ? Number(amt[1]) : null,
          token,
          origin: `a ${it.kind} from ${it.source}`,
          instruction: it.text.slice(0, 100),
        });
      }
    }
    return { summary: `${input.indexes.length} item(s) read offline`, quotes, paymentRequests };
  }
}

/** Claude (direct Anthropic, or OpenRouter) when a key is present, heuristic otherwise. Never logs the key. */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient {
  const config = llmConfig(env);
  return config.provider === 'none' ? new HeuristicLlmClient() : new AnthropicLlmClient({ config });
}
