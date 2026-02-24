/**
 * Kimi CLI Entry Point
 *
 * This module provides the main entry point for running the Kimi agent
 * through Happy CLI. It manages the agent lifecycle, session state, and
 * communication with the Happy server and mobile app.
 *
 * Kimi uses local OAuth authentication stored in ~/.kimi/credentials/
 * No cloud token management needed - just spawn kimi-cli acp
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { initialMachineMetadata } from '@/daemon/run';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';

import { createKimiBackend } from '@/agent/factories/kimi';
import type { AgentBackend, AgentMessage } from '@/agent';
import { KimiDisplay } from '@/ui/ink/KimiDisplay';
import { GeminiPermissionHandler } from '@/gemini/utils/permissionHandler';
import type { PermissionMode } from '@/api/types';
import { CHANGE_TITLE_INSTRUCTION } from '@/kimi/constants';
import { getInitialKimiModel } from '@/kimi/utils/config';

type KimiMode = {
  permissionMode: PermissionMode;
  model?: string;
  originalUserMessage: string;
};

/**
 * Main entry point for the kimi command with ink UI
 */
export async function runKimi(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
  const sessionTag = randomUUID();

  // Set backend for offline warnings
  connectionState.setBackend('Kimi');

  const api = await ApiClient.create(opts.credentials);

  //
  // Machine
  //

  const settings = await readSettings();
  const machineId = settings?.machineId;
  const sandboxConfig = settings?.sandboxConfig;
  if (!machineId) {
    console.error(`[START] No machine ID found in settings`);
    process.exit(1);
  }
  logger.debug(`Using machineId: ${machineId}`);
  await api.getOrCreateMachine({
    machineId,
    metadata: initialMachineMetadata
  });

  //
  // Create session
  //

  const { state, metadata } = createSessionMetadata({
    flavor: 'kimi',
    machineId,
    startedBy: opts.startedBy,
    sandbox: sandboxConfig,
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

  let session: ApiSessionClient;
  let permissionHandler: GeminiPermissionHandler;
  let isProcessingMessage = false;
  let pendingSessionSwap: ApiSessionClient | null = null;

  const applyPendingSessionSwap = () => {
    if (pendingSessionSwap) {
      logger.debug('[kimi] Applying pending session swap');
      session = pendingSessionSwap;
      if (permissionHandler) {
        permissionHandler.updateSession(pendingSessionSwap);
      }
      pendingSessionSwap = null;
    }
  };

  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      if (isProcessingMessage) {
        logger.debug('[kimi] Session swap requested during message processing - queueing');
        pendingSessionSwap = newSession;
      } else {
        session = newSession;
        if (permissionHandler) {
          permissionHandler.updateSession(newSession);
        }
      }
    }
  });
  session = initialSession;

  // Report to daemon
  if (response) {
    try {
      const result = await notifyDaemonSessionStarted(response.id, metadata);
      if (result.error) {
        logger.debug(`[START] Failed to report to daemon:`, result.error);
      }
    } catch (error) {
      logger.debug('[START] Failed to report to daemon:', error);
    }
  }

  const messageQueue = new MessageQueue2<KimiMode>((mode) => hashObject({
    permissionMode: mode.permissionMode,
    model: mode.model,
  }));

  let currentPermissionMode: PermissionMode | undefined = undefined;
  let currentModel: string | undefined = undefined;

  session.onUserMessage((message) => {
    let messagePermissionMode = currentPermissionMode;
    if (message.meta?.permissionMode) {
      const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
      if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
        messagePermissionMode = message.meta.permissionMode as PermissionMode;
        currentPermissionMode = messagePermissionMode;
        updatePermissionMode(messagePermissionMode);
      }
    }

    if (currentPermissionMode === undefined) {
      currentPermissionMode = 'default';
      updatePermissionMode('default');
    }

    let messageModel = currentModel;
    if (message.meta?.hasOwnProperty('model')) {
      if (message.meta.model === null) {
        messageModel = undefined;
        currentModel = undefined;
      } else if (message.meta.model) {
        messageModel = message.meta.model;
        currentModel = messageModel;
        updateDisplayedModel(messageModel);
        messageBuffer.addMessage(`Model changed to: ${messageModel}`, 'system');
      }
    }

    const originalUserMessage = message.content.text;
    let fullPrompt = originalUserMessage;
    if (isFirstMessage && message.meta?.appendSystemPrompt) {
      fullPrompt = message.meta.appendSystemPrompt + '\n\n' + originalUserMessage + '\n\n' + CHANGE_TITLE_INSTRUCTION;
      isFirstMessage = false;
    }

    const mode: KimiMode = {
      permissionMode: messagePermissionMode || 'default',
      model: messageModel,
      originalUserMessage,
    };
    messageQueue.push(fullPrompt, mode);
  });

  let thinking = false;
  session.keepAlive(thinking, 'remote');
  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  let isFirstMessage = true;

  const sendReady = () => {
    session.sendSessionEvent({ type: 'ready' });
    try {
      api.push().sendToAllDevices(
        "It's ready!",
        'Kimi is waiting for your command',
        { sessionId: session.sessionId }
      );
    } catch (pushError) {
      logger.debug('[Kimi] Failed to send ready push', pushError);
    }
  };

  const emitReadyIfIdle = (): boolean => {
    if (shouldExit) return false;
    if (thinking) return false;
    if (isResponseInProgress) return false;
    if (messageQueue.size() > 0) return false;
    sendReady();
    return true;
  };

  //
  // Abort handling
  //

  let abortController = new AbortController();
  let shouldExit = false;
  let kimiBackend: AgentBackend | null = null;
  let acpSessionId: string | null = null;
  let wasSessionCreated = false;

  async function handleAbort() {
    logger.debug('[Kimi] Abort requested - stopping current task');

    session.sendAgentMessage('kimi', {
      type: 'turn_aborted',
      id: randomUUID(),
    });

    try {
      abortController.abort();
      messageQueue.reset();
      if (kimiBackend && acpSessionId) {
        await kimiBackend.cancel(acpSessionId);
      }
    } catch (error) {
      logger.debug('[Kimi] Error during abort:', error);
    } finally {
      abortController = new AbortController();
    }
  }

  const handleKillSession = async () => {
    logger.debug('[Kimi] Kill session requested - terminating process');
    await handleAbort();

    try {
      if (session) {
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          lifecycleState: 'archived',
          lifecycleStateSince: Date.now(),
          archivedBy: 'cli',
          archiveReason: 'User terminated'
        }));

        session.sendSessionDeath();
        await session.flush();
        await session.close();
      }

      stopCaffeinate();
      happyServer.stop();

      if (kimiBackend) {
        await kimiBackend.dispose();
      }

      process.exit(0);
    } catch (error) {
      logger.debug('[Kimi] Error during session termination:', error);
      process.exit(1);
    }
  };

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  //
  // Initialize Ink UI
  //

  const messageBuffer = new MessageBuffer();
  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  let inkInstance: ReturnType<typeof render> | null = null;

  let displayedModel: string | undefined = getInitialKimiModel();

  const updateDisplayedModel = (model: string | undefined) => {
    if (model === undefined) return;
    const oldModel = displayedModel;
    displayedModel = model;

    if (hasTTY && oldModel !== model) {
      messageBuffer.addMessage(`[MODEL:${model}]`, 'system');
    }
  };

  if (hasTTY) {
    console.clear();
    const DisplayComponent = () => {
      const currentModelValue = displayedModel || 'kimi-code/kimi-for-coding';
      return React.createElement(KimiDisplay, {
        messageBuffer,
        logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
        currentModel: currentModelValue,
        onExit: async () => {
          logger.debug('[kimi]: Exiting agent via Ctrl-C');
          shouldExit = true;
          await handleAbort();
        }
      });
    };

    inkInstance = render(React.createElement(DisplayComponent), {
      exitOnCtrlC: false,
      patchConsole: false
    });

    const initialModelName = displayedModel || 'kimi-code/kimi-for-coding';
    messageBuffer.addMessage(`[MODEL:${initialModelName}]`, 'system');
  }

  if (hasTTY) {
    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
  }

  //
  // Start Happy MCP server and create Kimi backend
  //

  const happyServer = await startHappyServer(session);
  const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
  const mcpServers = {
    happy: {
      command: bridgeCommand,
      args: ['--url', happyServer.url]
    }
  };

  permissionHandler = new GeminiPermissionHandler(session);

  const updatePermissionMode = (mode: PermissionMode) => {
    permissionHandler.setPermissionMode(mode);
  };

  let accumulatedResponse = '';
  let isResponseInProgress = false;
  let hadToolCallInTurn = false;
  let taskStartedSent = false;

  function setupKimiMessageHandler(backend: AgentBackend): void {
    backend.onMessage((msg: AgentMessage) => {
      switch (msg.type) {
        case 'model-output':
          if (msg.textDelta) {
            if (!isResponseInProgress) {
              messageBuffer.removeLastMessage('system');
              messageBuffer.addMessage(msg.textDelta, 'assistant');
              isResponseInProgress = true;
            } else {
              messageBuffer.updateLastMessage(msg.textDelta, 'assistant');
            }
            accumulatedResponse += msg.textDelta;
          }
          break;

        case 'status':
          const statusDetail = msg.detail
            ? (typeof msg.detail === 'object' ? JSON.stringify(msg.detail) : String(msg.detail))
            : '';
          logger.debug(`[kimi] Status: ${msg.status}${statusDetail ? ` - ${statusDetail}` : ''}`);

          if (msg.status === 'error') {
            session.sendAgentMessage('kimi', {
              type: 'turn_aborted',
              id: randomUUID(),
            });
          }

          if (msg.status === 'running') {
            thinking = true;
            session.keepAlive(thinking, 'remote');

            if (!taskStartedSent) {
              session.sendAgentMessage('kimi', {
                type: 'task_started',
                id: randomUUID(),
              });
              taskStartedSent = true;
            }

            messageBuffer.addMessage('Thinking...', 'system');
          } else if (msg.status === 'idle' || msg.status === 'stopped') {
            // Keep thinking until turn completes
          } else if (msg.status === 'error') {
            thinking = false;
            session.keepAlive(thinking, 'remote');
            accumulatedResponse = '';
            isResponseInProgress = false;

            let errorMessage = 'Unknown error';
            if (msg.detail) {
              if (typeof msg.detail === 'object') {
                const detailObj = msg.detail as Record<string, unknown>;
                errorMessage = (detailObj.message as string) ||
                  (detailObj.details as string) ||
                  JSON.stringify(detailObj);
              } else {
                errorMessage = String(msg.detail);
              }
            }

            messageBuffer.addMessage(`Error: ${errorMessage}`, 'status');
            session.sendAgentMessage('kimi', {
              type: 'message',
              message: `Error: ${errorMessage}`,
            });
          }
          break;

        case 'tool-call':
          hadToolCallInTurn = true;
          const toolArgs = msg.args ? JSON.stringify(msg.args).substring(0, 100) : '';
          logger.debug(`[kimi] Tool call: ${msg.toolName} (${msg.callId})`);

          messageBuffer.addMessage(`Executing: ${msg.toolName}${toolArgs ? ` ${toolArgs}` : ''}`, 'tool');
          session.sendAgentMessage('kimi', {
            type: 'tool-call',
            name: msg.toolName,
            callId: msg.callId,
            input: msg.args,
            id: randomUUID(),
          });
          break;

        case 'tool-result':
          const isError = msg.result && typeof msg.result === 'object' && 'error' in msg.result;
          const resultText = typeof msg.result === 'string'
            ? msg.result.substring(0, 200)
            : JSON.stringify(msg.result).substring(0, 200);

          logger.debug(`[kimi] ${isError ? '❌' : '✅'} Tool result: ${msg.toolName}`);

          if (isError) {
            const errorMsg = (msg.result as any).error || 'Tool call failed';
            messageBuffer.addMessage(`Error: ${errorMsg}`, 'status');
          } else {
            messageBuffer.addMessage(`Result: ${resultText}`, 'result');
          }

          session.sendAgentMessage('kimi', {
            type: 'tool-result',
            callId: msg.callId,
            output: msg.result,
            id: randomUUID(),
          });
          break;

        case 'fs-edit':
          messageBuffer.addMessage(`File edit: ${msg.description}`, 'tool');
          session.sendAgentMessage('kimi', {
            type: 'file-edit',
            description: msg.description,
            diff: msg.diff,
            filePath: msg.path || 'unknown',
            id: randomUUID(),
          });
          break;

        case 'permission-request':
          const payload = (msg as any).payload || {};
          session.sendAgentMessage('kimi', {
            type: 'permission-request',
            permissionId: msg.id,
            toolName: payload.toolName || (msg as any).reason || 'unknown',
            description: (msg as any).reason || payload.toolName || '',
            options: payload,
          });
          break;

        case 'event':
          if (msg.name === 'thinking') {
            const thinkingPayload = msg.payload as { text?: string } | undefined;
            const thinkingText = (thinkingPayload && typeof thinkingPayload === 'object' && 'text' in thinkingPayload)
              ? String(thinkingPayload.text || '')
              : '';
            if (thinkingText) {
              logger.debug(`[kimi] Thinking: ${thinkingText.substring(0, 100)}...`);
              const thinkingPreview = thinkingText.substring(0, 100);
              messageBuffer.updateLastMessage(`[Thinking] ${thinkingPreview}...`, 'system');
            }
            session.sendAgentMessage('kimi', {
              type: 'thinking',
              text: thinkingText,
            });
          }
          break;

        default:
          if ((msg as any).type === 'token-count') {
            session.sendAgentMessage('kimi', {
              type: 'token_count',
              ...(msg as any),
              id: randomUUID(),
            });
          }
          break;
      }
    });
  }

  let first = true;

  try {
    let currentModeHash: string | null = null;

    while (!shouldExit) {
      let message = await messageQueue.waitForMessagesAndGetAsString(abortController.signal);
      if (!message) {
        if (abortController.signal.aborted && !shouldExit) {
          continue;
        }
        break;
      }

      currentModeHash = message.hash;
      const userMessageToShow = message.mode?.originalUserMessage || message.message;
      messageBuffer.addMessage(userMessageToShow, 'user');

      isProcessingMessage = true;

      try {
        if (first || !wasSessionCreated) {
          if (!kimiBackend) {
            const backendResult = createKimiBackend({
              cwd: process.cwd(),
              mcpServers,
              permissionHandler,
              model: message.mode?.model,
            });
            kimiBackend = backendResult.backend;

            setupKimiMessageHandler(kimiBackend);

            const actualModel = backendResult.model;
            logger.debug(`[kimi] Backend created, model: ${actualModel}`);
            updateDisplayedModel(actualModel);
          }

          if (!acpSessionId) {
            logger.debug('[kimi] Starting ACP session...');
            updatePermissionMode(message.mode.permissionMode);
            const { sessionId } = await kimiBackend.startSession();
            acpSessionId = sessionId;
            logger.debug(`[kimi] ACP session started: ${acpSessionId}`);
            wasSessionCreated = true;
            currentModeHash = message.hash;
          }
        }

        if (!acpSessionId) {
          throw new Error('ACP session not started');
        }

        if (!kimiBackend) {
          throw new Error('Kimi backend not initialized');
        }

        accumulatedResponse = '';
        isResponseInProgress = false;
        hadToolCallInTurn = false;
        taskStartedSent = false;

        await kimiBackend.sendPrompt(acpSessionId, message.message);

        // Wait for response to complete
        if (kimiBackend.waitForResponseComplete) {
          await kimiBackend.waitForResponseComplete();
        }

        thinking = false;
        session.keepAlive(thinking, 'remote');

        session.sendAgentMessage('kimi', {
          type: 'task_complete',
          id: randomUUID(),
        });

        if (accumulatedResponse) {
          session.sendAgentMessage('kimi', {
            type: 'message',
            message: accumulatedResponse,
          });
        }

        emitReadyIfIdle();
        first = false;

      } catch (error) {
        thinking = false;
        session.keepAlive(thinking, 'remote');

        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug(`[kimi] Error: ${errorMessage}`);
        messageBuffer.addMessage(`Error: ${errorMessage}`, 'status');

        session.sendAgentMessage('kimi', {
          type: 'turn_aborted',
          id: randomUUID(),
        });

        emitReadyIfIdle();
      } finally {
        isProcessingMessage = false;
        applyPendingSessionSwap();
      }
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();

    try {
      permissionHandler.reset();
    } catch (error) {
      logger.debug('[kimi] Failed to reset permission handler:', error);
    }

    if (kimiBackend) {
      await kimiBackend.dispose();
    }

    try {
      happyServer.stop();
    } catch (error) {
      logger.debug('[kimi] Failed to stop Happy MCP server:', error);
    }

    try {
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'Session ended',
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug('[kimi] Session close failed:', error);
    }

    if (inkInstance) {
      inkInstance.unmount();
    }
  }
}
