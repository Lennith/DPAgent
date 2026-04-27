/**
 * Auto Loop Controller (Ralph Loop)
 */

import { EventEmitter } from 'events';

export interface AutoLoopConfig {
  enabled: boolean;
  mode?: 'ralph' | 'todo';
  ralphEnabled?: boolean;
  pendingPlanConfirmation?: boolean;
  prompt: string;
  maxRounds: number;
  maxDurationMinutes: number;
  similarityThreshold: number;
  compareRounds: number;
  pausedByUser?: boolean;
}

export interface AutoLoopState {
  isRunning: boolean;
  exitRequested: boolean;
  currentRound: number;
  startTime: number;
  lastOutputs: string[];
  stopReason?: 'similarity' | 'max_rounds' | 'timeout' | 'user_stop' | 'error' | 'tool_exit';
}

export const DEFAULT_AUTO_LOOP_CONFIG: AutoLoopConfig = {
  enabled: false,
  mode: 'ralph',
  ralphEnabled: false,
  pendingPlanConfirmation: false,
  prompt:
    'Review the previous round. Continue only if meaningful work remains; otherwise state that the task is complete.',
  maxRounds: 20,
  maxDurationMinutes: 120,
  similarityThreshold: 0.85,
  compareRounds: 3,
  pausedByUser: false,
};

export class AutoLoopController extends EventEmitter {
  private config: AutoLoopConfig;
  private state: AutoLoopState;
  private sessionId: string;

  constructor(sessionId: string, config?: Partial<AutoLoopConfig>) {
    super();
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_AUTO_LOOP_CONFIG, ...config };
    this.state = {
      isRunning: false,
      exitRequested: false,
      currentRound: 0,
      startTime: 0,
      lastOutputs: [],
    };
  }

  start(): void {
    if (this.state.isRunning) return;

    this.state = {
      isRunning: true,
      exitRequested: false,
      currentRound: 0,
      startTime: Date.now(),
      lastOutputs: [],
    };

    this.emit('started', { sessionId: this.sessionId, config: this.config });
    console.log(`[AutoLoop] Started for session ${this.sessionId}`);
  }

  stop(reason: AutoLoopState['stopReason'] = 'user_stop'): void {
    if (!this.state.isRunning) return;

    this.state.isRunning = false;
    this.state.exitRequested = false;
    this.state.stopReason = reason;

    this.emit('stopped', {
      sessionId: this.sessionId,
      reason,
      totalRounds: this.state.currentRound,
      duration: Date.now() - this.state.startTime,
    });
    console.log(`[AutoLoop] Stopped for session ${this.sessionId}, reason: ${reason}`);
  }

  shouldContinue(lastOutput: string, options?: { ignoreSimilarity?: boolean }): { shouldContinue: boolean; reason?: string } {
    if (!this.state.isRunning || !this.config.enabled) {
      return { shouldContinue: false };
    }

    if (this.state.exitRequested) {
      this.stop('tool_exit');
      return { shouldContinue: false, reason: 'exit_auto_loop requested' };
    }

    this.state.currentRound++;
    this.state.lastOutputs.push(lastOutput);

    if (this.state.lastOutputs.length > this.config.compareRounds) {
      this.state.lastOutputs.shift();
    }

    console.log(`[AutoLoop] Round ${this.state.currentRound} completed for ${this.sessionId}`);
    this.emit('round_completed', {
      sessionId: this.sessionId,
      round: this.state.currentRound,
      output: lastOutput.substring(0, 200),
    });

    if (this.state.currentRound >= this.config.maxRounds) {
      this.stop('max_rounds');
      return { shouldContinue: false, reason: 'Reached maximum auto-loop rounds.' };
    }

    const elapsedMinutes = (Date.now() - this.state.startTime) / 1000 / 60;
    if (elapsedMinutes >= this.config.maxDurationMinutes) {
      this.stop('timeout');
      return { shouldContinue: false, reason: 'Reached maximum auto-loop duration.' };
    }

    if (!options?.ignoreSimilarity && this.state.lastOutputs.length >= this.config.compareRounds) {
      const similarity = this.calculateSimilarity(this.state.lastOutputs);
      console.log(`[AutoLoop] Similarity check: ${similarity.toFixed(3)} (threshold: ${this.config.similarityThreshold})`);

      if (similarity >= this.config.similarityThreshold) {
        this.stop('similarity');
        return { shouldContinue: false, reason: 'Outputs converged and look repetitive.' };
      }
    }

    return { shouldContinue: true };
  }

  getNextPrompt(): string | null {
    if (!this.state.isRunning || !this.config.enabled) {
      return null;
    }
    return this.config.prompt;
  }

  updateConfig(config: Partial<AutoLoopConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('config_updated', { sessionId: this.sessionId, config: this.config });
  }

  getState(): AutoLoopState {
    return { ...this.state };
  }

  getConfig(): AutoLoopConfig {
    return { ...this.config };
  }

  isInLoop(): boolean {
    return this.state.isRunning && this.config.enabled;
  }

  requestExit(reason?: string): { accepted: boolean; message: string } {
    if (!this.isInLoop()) {
      return {
        accepted: false,
        message: 'exit_auto_loop can only be called during auto-loop',
      };
    }

    if (this.state.exitRequested) {
      return {
        accepted: true,
        message: 'auto-loop exit already requested',
      };
    }

    this.state.exitRequested = true;
    const reasonText = String(reason ?? '').trim();
    const extra = reasonText.length > 0 ? ` (${reasonText})` : '';
    console.log(`[AutoLoop] Exit requested for session ${this.sessionId}${extra}`);
    this.emit('exit_requested', {
      sessionId: this.sessionId,
      round: this.state.currentRound,
      reason: reasonText || undefined,
    });

    return {
      accepted: true,
      message: 'auto-loop exit requested',
    };
  }

  private calculateSimilarity(texts: string[]): number {
    if (texts.length < 2) return 0;

    let totalSimilarity = 0;
    let pairs = 0;

    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        totalSimilarity += this.cosineSimilarity(texts[i], texts[j]);
        pairs++;
      }
    }

    return pairs > 0 ? totalSimilarity / pairs : 0;
  }

  private cosineSimilarity(text1: string, text2: string): number {
    const getWordFreq = (text: string): Map<string, number> => {
      const words = text
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1);

      const freq = new Map<string, number>();
      for (const word of words) {
        freq.set(word, (freq.get(word) || 0) + 1);
      }
      return freq;
    };

    const freq1 = getWordFreq(text1);
    const freq2 = getWordFreq(text2);
    const allWords = new Set([...freq1.keys(), ...freq2.keys()]);

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (const word of allWords) {
      const f1 = freq1.get(word) || 0;
      const f2 = freq2.get(word) || 0;
      dotProduct += f1 * f2;
    }

    for (const f of freq1.values()) {
      norm1 += f * f;
    }
    for (const f of freq2.values()) {
      norm2 += f * f;
    }

    if (norm1 === 0 || norm2 === 0) return 0;
    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }
}

export class AutoLoopManager {
  private controllers = new Map<string, AutoLoopController>();
  private globalConfig: AutoLoopConfig = DEFAULT_AUTO_LOOP_CONFIG;

  getOrCreate(sessionId: string, sessionConfig?: Partial<AutoLoopConfig>): AutoLoopController {
    if (!this.controllers.has(sessionId)) {
      const config = { ...this.globalConfig, ...sessionConfig };
      const controller = new AutoLoopController(sessionId, config);
      this.controllers.set(sessionId, controller);
    }
    return this.controllers.get(sessionId)!;
  }

  get(sessionId: string): AutoLoopController | undefined {
    return this.controllers.get(sessionId);
  }

  remove(sessionId: string): void {
    const controller = this.controllers.get(sessionId);
    if (controller) {
      controller.stop('user_stop');
      this.controllers.delete(sessionId);
    }
  }

  updateSessionId(oldSessionId: string, newSessionId: string): void {
    const controller = this.controllers.get(oldSessionId);
    if (controller && oldSessionId !== newSessionId) {
      this.controllers.delete(oldSessionId);
      this.controllers.set(newSessionId, controller);
      console.log(`[AutoLoopManager] Updated session ID: ${oldSessionId} -> ${newSessionId}`);
    }
  }

  updateGlobalConfig(config: Partial<AutoLoopConfig>): void {
    this.globalConfig = { ...this.globalConfig, ...config };
  }

  getGlobalConfig(): AutoLoopConfig {
    return { ...this.globalConfig };
  }
}

export const autoLoopManager = new AutoLoopManager();
