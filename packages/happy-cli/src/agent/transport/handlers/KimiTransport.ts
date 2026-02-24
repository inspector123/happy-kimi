/**
 * Kimi Transport Handler
 *
 * Kimi CLI-specific implementation of TransportHandler.
 * Handles:
 * - Stdout filtering (removes debug output that breaks JSON-RPC)
 * - Stderr parsing (detects errors)
 * - Tool name patterns
 *
 * @module KimiTransport
 */

import type {
  TransportHandler,
  ToolPattern,
  StderrContext,
  StderrResult,
  ToolNameContext,
} from '../TransportHandler';
import type { AgentMessage } from '../../core';
import { logger } from '@/ui/logger';

/**
 * Kimi-specific timeout values (in milliseconds)
 */
export const KIMI_TIMEOUTS = {
  /** Standard init timeout */
  init: 60_000,
  /** Standard tool call timeout */
  toolCall: 120_000,
  /** Investigation tools can run for a long time */
  investigation: 600_000,
  /** Idle detection after last message chunk */
  idle: 500,
} as const;

/**
 * Known tool name patterns for Kimi CLI.
 */
const KIMI_TOOL_PATTERNS: ToolPattern[] = [
  {
    name: 'change_title',
    patterns: ['change_title', 'change-title', 'happy__change_title', 'mcp__happy__change_title'],
  },
  {
    name: 'save_memory',
    patterns: ['save_memory', 'save-memory'],
  },
  {
    name: 'think',
    patterns: ['think'],
  },
];

/**
 * Kimi CLI transport handler.
 */
export class KimiTransport implements TransportHandler {
  readonly agentName = 'kimi';

  /**
   * Get init timeout
   */
  getInitTimeout(): number {
    return KIMI_TIMEOUTS.init;
  }

  /**
   * Filter Kimi CLI debug output from stdout.
   *
   * Only keep valid JSON lines for JSON-RPC parsing.
   */
  filterStdoutLine(line: string): string | null {
    const trimmed = line.trim();

    // Empty lines - skip
    if (!trimmed) {
      return null;
    }

    // Must start with { or [ to be valid JSON-RPC
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return null;
    }

    // Validate it's actually parseable JSON
    try {
      const parsed = JSON.parse(trimmed);
      // Must be an object or array, not a primitive
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      return line;
    } catch {
      return null;
    }
  }

  /**
   * Handle Kimi CLI stderr output.
   */
  handleStderr(text: string, context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) {
      return { message: null, suppress: true };
    }

    // Rate limit error - log but don't show
    if (
      trimmed.includes('status 429') ||
      trimmed.includes('code":429') ||
      trimmed.includes('rateLimitExceeded')
    ) {
      return { message: null, suppress: false };
    }

    // Auth error - show to user
    if (trimmed.includes('401') || trimmed.includes('Unauthorized') || trimmed.includes('authentication')) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Authentication error. Run `kimi-cli login` to authenticate.',
      };
      return { message: errorMessage };
    }

    // During investigation tools, log any errors for debugging
    if (context.hasActiveInvestigation) {
      const hasError =
        trimmed.includes('timeout') ||
        trimmed.includes('failed') ||
        trimmed.includes('error');

      if (hasError) {
        return { message: null, suppress: false };
      }
    }

    return { message: null };
  }

  /**
   * Kimi-specific tool patterns
   */
  getToolPatterns(): ToolPattern[] {
    return KIMI_TOOL_PATTERNS;
  }

  /**
   * Check if tool is an investigation tool (needs longer timeout)
   */
  isInvestigationTool(toolCallId: string, toolKind?: string): boolean {
    const lowerId = toolCallId.toLowerCase();
    return (
      lowerId.includes('investigator') ||
      lowerId.includes('search') ||
      (typeof toolKind === 'string' && toolKind.includes('investigator'))
    );
  }

  /**
   * Get timeout for a tool call
   */
  getToolCallTimeout(toolCallId: string, toolKind?: string): number {
    if (this.isInvestigationTool(toolCallId, toolKind)) {
      return KIMI_TIMEOUTS.investigation;
    }
    return KIMI_TIMEOUTS.toolCall;
  }

  /**
   * Get idle detection timeout
   */
  getIdleTimeout(): number {
    return KIMI_TIMEOUTS.idle;
  }

  /**
   * Extract tool name from toolCallId using Kimi patterns.
   */
  extractToolNameFromId(toolCallId: string): string | null {
    const lowerId = toolCallId.toLowerCase();

    for (const toolPattern of KIMI_TOOL_PATTERNS) {
      for (const pattern of toolPattern.patterns) {
        if (lowerId.includes(pattern.toLowerCase())) {
          return toolPattern.name;
        }
      }
    }

    return null;
  }

  /**
   * Determine the real tool name from various sources.
   */
  determineToolName(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    _context: ToolNameContext
  ): string {
    // If tool name is already known, return it
    if (toolName !== 'other' && toolName !== 'Unknown tool') {
      return toolName;
    }

    // Check toolCallId for known tool names
    const idToolName = this.extractToolNameFromId(toolCallId);
    if (idToolName) {
      return idToolName;
    }

    // Return original tool name if we couldn't determine it
    if (toolName === 'other' || toolName === 'Unknown tool') {
      const inputKeys = input && typeof input === 'object' ? Object.keys(input) : [];
      logger.debug(
        `[KimiTransport] Unknown tool pattern - toolCallId: "${toolCallId}", ` +
        `toolName: "${toolName}", inputKeys: [${inputKeys.join(', ')}]`
      );
    }

    return toolName;
  }
}

/**
 * Singleton instance for convenience
 */
export const kimiTransport = new KimiTransport();
