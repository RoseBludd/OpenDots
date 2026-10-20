// Per-Dot model and key resolution (WO-03).
//
// Precedence ported from the private Hermes scheduler (RoseBludd/hermes,
// vendor/hermes-agent/cron/scheduler.py L1358: `job.get("model") or
// os.getenv("HERMES_MODEL")`, and L1493-1514: an explicit per-job provider that
// cannot be resolved fails with a clear error instead of falling back):
//   model = dot.model ?? OPENAI_MODEL ?? cadis-free
//   key   = dot.desk ? CADIS_API_KEY_<DESK> (no fallback) : OPENAI_API_KEY
// A desk key is checked by the gateway against its CADIS_DESK_KEYS hash map
// (cadis-ai-gateway PR #4); X-Cadis-Desk names the desk for its logs.
import type { Dot } from '../shared/types.js';
import { z } from 'zod';
import {
  DEFAULT_DOT_MODEL,
  DESK_PATTERN,
  DOT_MODELS,
  deskKeyEnvName,
} from '../shared/dot-model.js';

/** API fields for the per-Dot setter; null clears back to the server default. */
export const dotModelFields = {
  model: z.enum(DOT_MODELS).nullable().optional(),
  desk: z
    .string()
    .trim()
    .toLowerCase()
    .regex(DESK_PATTERN)
    .nullable()
    .optional(),
};
export const dotLookSchema = z.object({
  pinned: z.boolean().optional(),
  hue: z.number().int().min(0).max(359).nullable().optional(),
});

export const dotOrderSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});

export const dotModelSchema = z.object(dotModelFields).strict();

export class DotModelError extends Error {}

export interface ResolvedDotModel {
  model: string;
  apiKey: string;
  desk: string | null;
  headers: Record<string, string>;
}

export function resolveDotModel(
  dot: Pick<Dot, 'model' | 'desk'>,
  config: { apiKey?: string; model?: string },
  env: Record<string, string | undefined> = process.env,
): ResolvedDotModel {
  const model = dot.model || config.model || DEFAULT_DOT_MODEL;
  if (dot.desk) {
    const name = deskKeyEnvName(dot.desk);
    const apiKey = env[name]?.trim();
    if (!apiKey)
      throw new DotModelError(
        `Model not configured for desk "${dot.desk}": set ${name} on the server. This Dot does not fall back to another key.`,
      );
    return {
      model,
      apiKey,
      desk: dot.desk,
      headers: { 'X-Cadis-Desk': dot.desk },
    };
  }
  if (!config.apiKey)
    throw new DotModelError(
      'Model not configured: set OPENAI_API_KEY on the server.',
    );
  return { model, apiKey: config.apiKey, desk: null, headers: {} };
}
