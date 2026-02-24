/**
 * Kimi Configuration Utilities
 *
 * Utilities for reading Kimi CLI configuration files.
 * Kimi stores config in ~/.kimi/config.toml and credentials in ~/.kimi/credentials/
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '@/ui/logger';
import { KIMI_MODEL_ENV, DEFAULT_KIMI_MODEL } from '../constants';

/**
 * Result of reading Kimi local configuration
 */
export interface KimiLocalConfig {
  /** Model to use (from config.toml) */
  model: string | null;
  /** Whether thinking mode is enabled */
  thinking: boolean;
  /** Whether yolo mode (auto-approve) is enabled */
  yolo: boolean;
}

/**
 * Parse a simple TOML file and extract key values.
 * This is a minimal parser for Kimi's config.toml format.
 */
function parseToml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) {
      continue;
    }

    // Parse key = "value" or key = value
    const match = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      // Remove quotes if present
      const cleanValue = value.trim();
      if (cleanValue.startsWith('"') && cleanValue.endsWith('"')) {
        result[key] = cleanValue.slice(1, -1);
      } else if (cleanValue === 'true') {
        result[key] = true;
      } else if (cleanValue === 'false') {
        result[key] = false;
      } else if (/^\d+$/.test(cleanValue)) {
        result[key] = parseInt(cleanValue, 10);
      } else {
        result[key] = cleanValue;
      }
    }
  }

  return result;
}

/**
 * Read Kimi config from ~/.kimi/config.toml
 */
export function readKimiLocalConfig(): KimiLocalConfig {
  const configPath = join(homedir(), '.kimi', 'config.toml');

  if (!existsSync(configPath)) {
    logger.debug('[Kimi] No config file found at ~/.kimi/config.toml');
    return { model: null, thinking: true, yolo: false };
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = parseToml(content);

    const model = typeof config.default_model === 'string' ? config.default_model : null;
    const thinking = config.default_thinking === true;
    const yolo = config.default_yolo === true;

    logger.debug(`[Kimi] Read config: model=${model}, thinking=${thinking}, yolo=${yolo}`);

    return { model, thinking, yolo };
  } catch (error) {
    logger.debug('[Kimi] Failed to read config:', error);
    return { model: null, thinking: true, yolo: false };
  }
}

/**
 * Determine the model to use based on priority:
 * 1. Explicit model parameter (if provided)
 * 2. Environment variable (KIMI_MODEL)
 * 3. Local config file (~/.kimi/config.toml)
 * 4. Default model
 *
 * @param explicitModel - Model explicitly provided (undefined = check sources, null = skip config)
 * @param localConfig - Local config result from readKimiLocalConfig()
 * @returns The model string to use
 */
export function determineKimiModel(
  explicitModel: string | null | undefined,
  localConfig: KimiLocalConfig
): string {
  if (explicitModel !== undefined) {
    if (explicitModel === null) {
      // Explicitly null - use env or default, skip local config
      return process.env[KIMI_MODEL_ENV] || DEFAULT_KIMI_MODEL;
    } else {
      // Model explicitly provided - use it
      return explicitModel;
    }
  } else {
    // No explicit model - check env var first, then local config, then default
    const envModel = process.env[KIMI_MODEL_ENV];
    const model = envModel || localConfig.model || DEFAULT_KIMI_MODEL;
    logger.debug(`[Kimi] Selected model: ${model}`);
    return model;
  }
}

/**
 * Get the initial model value for UI display
 * Priority: env var > local config > default
 */
export function getInitialKimiModel(): string {
  const localConfig = readKimiLocalConfig();
  return process.env[KIMI_MODEL_ENV] || localConfig.model || DEFAULT_KIMI_MODEL;
}

/**
 * Determine the source of the model for logging purposes
 */
export function getKimiModelSource(
  explicitModel: string | null | undefined,
  localConfig: KimiLocalConfig
): 'explicit' | 'env-var' | 'local-config' | 'default' {
  if (explicitModel !== undefined && explicitModel !== null) {
    return 'explicit';
  } else if (process.env[KIMI_MODEL_ENV]) {
    return 'env-var';
  } else if (localConfig.model) {
    return 'local-config';
  } else {
    return 'default';
  }
}
