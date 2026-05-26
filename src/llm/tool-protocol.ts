import type { Message, ToolProtocolBuildResult } from '../types.js';
import { prepareToolProtocol } from './tool-protocol-analyzer.js';

/**
 * Build canonical protocol frames from sanitized messages.
 * A frame is either a normal message, or an assistant tool bundle that
 * includes the assistant tool_use turn and aligned tool_result messages.
 */
export function buildToolProtocolFrames(messages: Message[]): ToolProtocolBuildResult {
  const analysis = prepareToolProtocol(messages);
  return {
    frames: analysis.frames,
    assistantToolBundleCount: analysis.assistantToolBundleCount,
    toolResultMessageCount: analysis.toolResultMessageCount,
    maxToolResultsPerBundle: analysis.maxToolResultsPerBundle,
  };
}
