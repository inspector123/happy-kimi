/**
 * Kimi ACP Backend - Kimi CLI agent via ACP
 *
 * This module provides a factory function for creating a Kimi backend
 * that communicates using the Agent Client Protocol (ACP).
 *
 * Kimi CLI is Moonshot AI's coding assistant that supports ACP via `kimi-cli acp`.
 * Authentication is handled locally via OAuth stored in ~/.kimi/credentials/
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '../acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '../core';
import { agentRegistry } from '../core';
import { kimiTransport } from '../transport';
import { logger } from '@/ui/logger';
import { KIMI_MODEL_ENV, DEFAULT_KIMI_MODEL } from '@/kimi/constants';
import {
  readKimiLocalConfig,
  determineKimiModel,
  getKimiModelSource
} from '@/kimi/utils/config';

/**
 * Options for creating a Kimi ACP backend
 */
export interface KimiBackendOptions extends AgentFactoryOptions {
  /** Model to use. If undefined, will use local config, env var, or default. */
  model?: string | null;

  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;
}

/**
 * Result of creating a Kimi backend
 */
export interface KimiBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used */
  model: string;
  /** Source of the model selection for logging */
  modelSource: 'explicit' | 'env-var' | 'local-config' | 'default';
}

/**
 * Create a Kimi backend using ACP.
 *
 * The Kimi CLI must be installed and authenticated (run `kimi-cli login`).
 * Uses `kimi-cli acp` to run the ACP server.
 *
 * @param options - Configuration options
 * @returns KimiBackendResult with backend and resolved model
 */
export function createKimiBackend(options: KimiBackendOptions): KimiBackendResult {
  // Read local Kimi CLI config (~/.kimi/config.toml)
  const localConfig = readKimiLocalConfig();

  // Get model from options, local config, system environment, or use default
  const model = determineKimiModel(options.model, localConfig);

  // Command to run kimi
  // Kimi CLI supports ACP via `kimi-cli acp` subcommand
  const kimiCommand = 'kimi-cli';
  const kimiArgs = ['acp'];

  const backendOptions: AcpBackendOptions = {
    agentName: 'kimi',
    cwd: options.cwd,
    command: kimiCommand,
    args: kimiArgs,
    env: {
      ...options.env,
      // Pass model via env var
      [KIMI_MODEL_ENV]: model,
      // Suppress debug output to avoid stdout pollution
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: kimiTransport,
    // Check if prompt instructs the agent to change title (for auto-approval of change_title tool)
    hasChangeTitleInstruction: (prompt: string) => {
      const lower = prompt.toLowerCase();
      return lower.includes('change_title') ||
             lower.includes('change title') ||
             lower.includes('set title') ||
             lower.includes('mcp__happy__change_title');
    },
  };

  // Determine model source for logging
  const modelSource = getKimiModelSource(options.model, localConfig);

  logger.debug('[Kimi] Creating ACP backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
    model: model,
    modelSource: modelSource,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
  });

  return {
    backend: new AcpBackend(backendOptions),
    model,
    modelSource,
  };
}

/**
 * Register Kimi backend with the global agent registry.
 *
 * This function should be called during application initialization
 * to make the Kimi agent available for use.
 */
export function registerKimiAgent(): void {
  agentRegistry.register('kimi', (opts) => createKimiBackend(opts).backend);
  logger.debug('[Kimi] Registered with agent registry');
}
