/**
 * Kimi Constants
 *
 * Centralized constants for Kimi integration including environment variable names
 * and default values.
 */

import { trimIdent } from '@/utils/trimIdent';

/** Environment variable name for Kimi API key (optional - Kimi uses local OAuth) */
export const KIMI_API_KEY_ENV = 'KIMI_API_KEY';

/** Environment variable name for Kimi model selection */
export const KIMI_MODEL_ENV = 'KIMI_MODEL';

/** Default Kimi model */
export const DEFAULT_KIMI_MODEL = 'kimi-code/kimi-for-coding';

/**
 * Instruction for changing chat title
 * Used in system prompts to instruct agents to call change_title function
 */
export const CHANGE_TITLE_INSTRUCTION = trimIdent(
  `Based on this message, call functions.happy__change_title to change chat session title that would represent the current task. If chat idea would change dramatically - call this function again to update the title.`
);
