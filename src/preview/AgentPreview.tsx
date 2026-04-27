import React, { useState, useEffect, useCallback } from 'react';

export interface PreviewEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'step' | 'error' | 'complete' | 'reset';
  timestamp: number;
  data: unknown;
}

export interface PreviewState {
  isRunning: boolean;
  currentStep: number;
  maxSteps: number;
  thinking: string | null;
  lastToolCall: { name: string; args: Record<string, unknown> } | null;
  lastToolResult: { name: string; result: { success: boolean; content: string; error?: string } } | null;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  error: string | null;
  result: string | null;
}

export interface AgentPreviewProps {
  state: PreviewState;
  onCancel?: () => void;
  onReset?: () => void;
}

export const AgentPreview: React.FC<AgentPreviewProps> = ({ state, onCancel, onReset }) => {
  const [expandedThinking, setExpandedThinking] = useState(false);
  const [expandedMessages, setExpandedMessages] = useState(false);

  const progressPercent = state.maxSteps > 0 
    ? Math.round((state.currentStep / state.maxSteps) * 100) 
    : 0;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h3 style={styles.title}>MiniMax Agent Preview</h3>
        <div style={styles.status}>
          {state.isRunning ? (
            <span style={styles.running}>Running...</span>
          ) : state.error ? (
            <span style={styles.error}>Error</span>
          ) : state.result ? (
            <span style={styles.complete}>Complete</span>
          ) : (
            <span style={styles.idle}>Idle</span>
          )}
        </div>
      </div>

      <div style={styles.progress}>
        <div style={styles.progressBar}>
          <div 
            style={{ 
              ...styles.progressFill, 
              width: `${progressPercent}%`,
              backgroundColor: state.error ? '#ef4444' : state.result ? '#22c55e' : '#3b82f6'
            }} 
          />
        </div>
        <span style={styles.progressText}>
          Step {state.currentStep} / {state.maxSteps}
        </span>
      </div>

      {state.thinking && (
        <div style={styles.section}>
          <div 
            style={styles.sectionHeader}
            onClick={() => setExpandedThinking(!expandedThinking)}
          >
            <span>Thinking</span>
            <span>{expandedThinking ? '▼' : '▶'}</span>
          </div>
          {expandedThinking && (
            <div style={styles.thinkingContent}>
              {state.thinking}
            </div>
          )}
        </div>
      )}

      {state.lastToolCall && (
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <span>Tool Call: {state.lastToolCall.name}</span>
          </div>
          <pre style={styles.code}>
            {JSON.stringify(state.lastToolCall.args, null, 2)}
          </pre>
        </div>
      )}

      {state.lastToolResult && (
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <span>
              Tool Result: {state.lastToolResult.name} 
              {state.lastToolResult.result.success ? ' ✓' : ' ✗'}
            </span>
          </div>
          <pre style={styles.code}>
            {state.lastToolResult.result.success 
              ? state.lastToolResult.result.content 
              : state.lastToolResult.result.error}
          </pre>
        </div>
      )}

      {state.messages.length > 0 && (
        <div style={styles.section}>
          <div 
            style={styles.sectionHeader}
            onClick={() => setExpandedMessages(!expandedMessages)}
          >
            <span>Messages ({state.messages.length})</span>
            <span>{expandedMessages ? '▼' : '▶'}</span>
          </div>
          {expandedMessages && (
            <div style={styles.messages}>
              {state.messages.map((msg, i) => (
                <div key={i} style={styles.message}>
                  <span style={styles.messageRole}>{msg.role}:</span>
                  <span style={styles.messageContent}>{msg.content}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {state.error && (
        <div style={styles.errorBox}>
          <strong>Error:</strong> {state.error}
        </div>
      )}

      {state.result && (
        <div style={styles.resultBox}>
          <strong>Result:</strong>
          <pre style={styles.resultContent}>{state.result}</pre>
        </div>
      )}

      <div style={styles.actions}>
        {state.isRunning && onCancel && (
          <button style={styles.cancelButton} onClick={onCancel}>
            Cancel
          </button>
        )}
        {!state.isRunning && onReset && (
          <button style={styles.resetButton} onClick={onReset}>
            Reset
          </button>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    backgroundColor: '#1e1e1e',
    color: '#e0e0e0',
    borderRadius: '8px',
    padding: '16px',
    maxWidth: '600px',
    margin: '0 auto',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
  },
  title: {
    margin: 0,
    fontSize: '18px',
    fontWeight: 600,
  },
  status: {
    fontSize: '14px',
    fontWeight: 500,
  },
  running: {
    color: '#3b82f6',
  },
  error: {
    color: '#ef4444',
  },
  complete: {
    color: '#22c55e',
  },
  idle: {
    color: '#6b7280',
  },
  progress: {
    marginBottom: '16px',
  },
  progressBar: {
    height: '4px',
    backgroundColor: '#374151',
    borderRadius: '2px',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    transition: 'width 0.3s ease',
  },
  progressText: {
    fontSize: '12px',
    color: '#9ca3af',
    marginTop: '4px',
    display: 'block',
  },
  section: {
    marginBottom: '12px',
    backgroundColor: '#2d2d2d',
    borderRadius: '6px',
    overflow: 'hidden',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    backgroundColor: '#374151',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500,
  },
  thinkingContent: {
    padding: '12px',
    fontSize: '13px',
    lineHeight: 1.5,
    color: '#a78bfa',
    whiteSpace: 'pre-wrap',
  },
  code: {
    margin: 0,
    padding: '12px',
    fontSize: '12px',
    fontFamily: 'Consolas, Monaco, monospace',
    overflow: 'auto',
    maxHeight: '200px',
    color: '#e0e0e0',
  },
  messages: {
    maxHeight: '200px',
    overflow: 'auto',
  },
  message: {
    padding: '8px 12px',
    borderBottom: '1px solid #374151',
    fontSize: '13px',
  },
  messageRole: {
    fontWeight: 600,
    marginRight: '8px',
    color: '#60a5fa',
  },
  messageContent: {
    color: '#d1d5db',
  },
  errorBox: {
    padding: '12px',
    backgroundColor: '#450a0a',
    border: '1px solid #dc2626',
    borderRadius: '6px',
    marginBottom: '12px',
    fontSize: '13px',
  },
  resultBox: {
    padding: '12px',
    backgroundColor: '#052e16',
    border: '1px solid #22c55e',
    borderRadius: '6px',
    marginBottom: '12px',
  },
  resultContent: {
    margin: '8px 0 0 0',
    fontSize: '13px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  actions: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
  },
  cancelButton: {
    padding: '8px 16px',
    backgroundColor: '#dc2626',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  resetButton: {
    padding: '8px 16px',
    backgroundColor: '#374151',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
  },
};

export default AgentPreview;
