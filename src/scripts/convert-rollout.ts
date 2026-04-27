import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { createPersistedMessage, JSONLWriter } from '../storage/index.js';
import { ContextCompressor } from '../compression/index.js';
import { LLMClient } from '../llm/index.js';
import { ConfigManager } from '../config/index.js';
import type { APIProvider, PersistedMessage } from '../types.js';

const ROLLOUT_FILE = 'D:\\work\\AIAgent\\MiniMaxCli\\assert\\rollout-2026-02-18T01-50-32-019c6cb9-a83c-7e53-a7c3-2a6464652ee4.jsonl';
const OUTPUT_DIR = 'D:\\work\\AIAgent\\MiniMaxCli\\workspace\\minimax-session\\test-from-rollout';
interface RolloutRecord {
  timestamp: string;
  type: string;
  payload: any;
}

interface ResponseItemPayload {
  type: 'message' | 'function_call' | 'function_call_output' | 'reasoning';
  role?: 'user' | 'assistant' | 'developer';
  content?: Array<{ type: string; text?: string }>;
  phase?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: string;
  summary?: Array<{ type: string; text?: string }>;
}

function resolveRuntimeApiConfigFromConfig(): {
  apiKey: string;
  apiBase: string;
  model: string;
  provider: APIProvider;
  maxOutputTokens: number;
} {
  const configManager = new ConfigManager();
  const configPath = path.join(process.cwd(), 'config.yaml');
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.yaml not found: ${configPath}`);
  }
  configManager.loadFromYaml(configPath);
  const loaded = configManager.get().api;
  const configured = loaded.maxOutputTokens;
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
    throw new Error('api.maxOutputTokens must be set in config.');
  }
  if (!loaded.apiKey || loaded.apiKey.trim().length < 20) {
    throw new Error('api.apiKey must be set in config.');
  }
  if (!loaded.apiBase || loaded.apiBase.trim().length === 0) {
    throw new Error('api.apiBase must be set in config.');
  }
  if (!loaded.model || loaded.model.trim().length === 0) {
    throw new Error('api.model must be set in config.');
  }
  return {
    apiKey: loaded.apiKey,
    apiBase: loaded.apiBase,
    model: loaded.model,
    provider: loaded.provider,
    maxOutputTokens: Math.floor(configured),
  };
}

async function convertRollout() {
  console.log('=== Converting Codex Rollout to History Messages ===\n');
  
  console.log('Reading rollout file...');
  const fileStream = fs.createReadStream(ROLLOUT_FILE, 'utf-8');
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const messages: PersistedMessage[] = [];
  let totalRecords = 0;
  let messageRecords = 0;
  let reasoningRecords = 0;
  let functionCallRecords = 0;
  let lastAssistantThinking: string | undefined;

  for await (const line of rl) {
    if (!line.trim()) continue;
    
    totalRecords++;
    
    try {
      const record: RolloutRecord = JSON.parse(line);
      
      if (record.type === 'response_item') {
        const payload: ResponseItemPayload = record.payload;
        
        if (payload.type === 'reasoning' && payload.summary) {
          reasoningRecords++;
          const thinkingText = payload.summary
            .map(s => s.text || '')
            .filter(t => t)
            .join('\n');
          if (thinkingText) {
            lastAssistantThinking = thinkingText;
          }
        }
        
        if (payload.type === 'message' && payload.role) {
          if (payload.role === 'user' || payload.role === 'assistant') {
            messageRecords++;
            
            const contentText = (payload.content || [])
              .map(c => c.text || '')
              .filter(t => t)
              .join('\n');
            
            if (contentText) {
              const msg = createPersistedMessage(
                payload.role,
                contentText,
                {
                  timestamp: record.timestamp,
                  thinking: payload.role === 'assistant' ? lastAssistantThinking : undefined,
                }
              );
              messages.push(msg);
              
              if (payload.role === 'assistant') {
                lastAssistantThinking = undefined;
              }
            }
          }
        }
        
        if (payload.type === 'function_call') {
          functionCallRecords++;
        }
      }
    } catch (e) {
      // Skip invalid lines
    }
  }

  console.log(`\nTotal records: ${totalRecords}`);
  console.log(`Message records: ${messageRecords}`);
  console.log(`Reasoning records: ${reasoningRecords}`);
  console.log(`Function call records: ${functionCallRecords}`);
  console.log(`Extracted messages: ${messages.length}`);

  // Calculate total content size
  const totalSize = messages.reduce((sum, m) => sum + m.content.length, 0);
  console.log(`Total content size: ${(totalSize / 1024).toFixed(2)} KB`);

  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Write history_message_0.jsonl
  const historyFile = path.join(OUTPUT_DIR, 'history_message_0.jsonl');
  const writer = new JSONLWriter(historyFile);
  writer.overwrite(messages);
  console.log(`\nWritten ${messages.length} messages to ${historyFile}`);

  // Write session_meta.json
  const metaFile = path.join(OUTPUT_DIR, 'session_meta.json');
  const meta = {
    id: 'test-from-rollout',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceDir: 'D:\\work\\AIAgent\\MiniMaxCli\\workspace',
    currentIndex: 0,
    totalSize,
    compressedCount: 0,
  };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8');
  console.log(`Written session meta to ${metaFile}`);

  return { messages, totalSize };
}

async function testCompression(messages: PersistedMessage[], totalSize: number) {
  console.log('\n\n=== Testing Compression ===\n');
  const runtimeApiConfig = resolveRuntimeApiConfigFromConfig();
  
  console.log(`Original size: ${(totalSize / 1024).toFixed(2)} KB`);
  console.log(`Message count: ${messages.length}`);
  
  // Create LLM client
  const llmClient = new LLMClient({
    apiKey: runtimeApiConfig.apiKey,
    apiBase: runtimeApiConfig.apiBase,
    model: runtimeApiConfig.model,
    maxTokens: runtimeApiConfig.maxOutputTokens,
    provider: runtimeApiConfig.provider,
  });

  // Create compressor
  const compressor = new ContextCompressor(llmClient, 0.3);

  console.log('\nStarting compression (this may take a while)...');
  const startTime = Date.now();
  
  const result = await compressor.compress(messages);
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  
  if (result.success && result.compressedContent) {
    console.log(`\n✅ Compression successful!`);
    console.log(`Time: ${elapsed}s`);
    console.log(`Original size: ${(result.originalSize / 1024).toFixed(2)} KB`);
    console.log(`Compressed size: ${(result.compressedSize! / 1024).toFixed(2)} KB`);
    console.log(`Compression ratio: ${((result.compressedSize! / result.originalSize) * 100).toFixed(1)}%`);
    
    // Write compressed history
    const compressedFile = path.join(OUTPUT_DIR, 'history_message_1.jsonl');
    const compressedMsg = createPersistedMessage('user', result.compressedContent, {
      metadata: {
        compressed: true,
        originalSize: result.originalSize,
        compressedSize: result.compressedSize,
      }
    });
    
    const writer = new JSONLWriter(compressedFile);
    writer.overwrite([compressedMsg]);
    console.log(`\nWritten compressed history to ${compressedFile}`);
    
    // Update meta
    const metaFile = path.join(OUTPUT_DIR, 'session_meta.json');
    const meta = {
      id: 'test-from-rollout',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceDir: 'D:\\work\\AIAgent\\MiniMaxCli\\workspace',
      currentIndex: 1,
      totalSize: result.compressedSize,
      compressedCount: 1,
    };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8');
    
    // Show preview
    console.log('\n=== Compressed Content Preview ===');
    console.log(result.compressedContent.substring(0, 1000) + '...');
  } else {
    console.log(`\n❌ Compression failed: ${result.error}`);
  }
}

async function main() {
  try {
    const { messages, totalSize } = await convertRollout();
    await testCompression(messages, totalSize);
    console.log('\n\n=== All Done ===');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
