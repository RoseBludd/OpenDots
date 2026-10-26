// Per-Dot model choices (WO-03). Shared by the server and the Dot settings UI.
export const DOT_MODELS = ['cadis-cursor', 'cadis-free', 'cadis'] as const;
export type DotModel = (typeof DOT_MODELS)[number];
/**
 * The model a Dot uses when none is chosen and the server sets no OPENAI_MODEL.
 * cadis-cursor is the Cursor main brain (Composer 2.5, fast=false): the CADIS gateway
 * tries the Cursor lane first, then Claude, then OpenRouter GLM.
 */
export const DEFAULT_DOT_MODEL: DotModel = 'cadis-cursor';
/** Desk names map to env CADIS_API_KEY_<DESK>, e.g. devvy -> CADIS_API_KEY_DEVVY. */
export const DESK_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export function deskKeyEnvName(desk: string): string {
  return `CADIS_API_KEY_${desk.toUpperCase().replace(/-/g, '_')}`;
}
