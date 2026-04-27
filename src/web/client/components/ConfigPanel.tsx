import React, { useState, useEffect } from 'react';

interface Config {
  agent: {
    maxSteps: number;
    tokenLimit: number;
    workspaceDir: string;
    runtimeDataDir?: string;
  };
  api: {
    apiBase: string;
    model: string;
    provider: 'anthropic' | 'openai';
  };
}

export function ConfigPanel() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const response = await fetch('/api/config');
      const data = await response.json() as Config;
      setConfig(data);
    } catch (error) {
      console.error('Failed to fetch config:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Loading config...
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Failed to load config
      </div>
    );
  }

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4">Configuration</h2>

      <div className="space-y-6">
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-medium mb-3 text-white">API Settings</h3>
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Provider</label>
              <div className="bg-gray-700 rounded px-3 py-2 text-gray-200">
                {config.api.provider}
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Model</label>
              <div className="bg-gray-700 rounded px-3 py-2 text-gray-200">
                {config.api.model}
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">API Base</label>
              <div className="bg-gray-700 rounded px-3 py-2 text-gray-200 text-sm font-mono">
                {config.api.apiBase}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-medium mb-3 text-white">Agent Settings</h3>
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Max Steps</label>
              <div className="bg-gray-700 rounded px-3 py-2 text-gray-200">
                {config.agent.maxSteps}
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Token Limit</label>
              <div className="bg-gray-700 rounded px-3 py-2 text-gray-200">
                {config.agent.tokenLimit.toLocaleString()}
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Workspace Directory</label>
              <div className="bg-gray-700 rounded px-3 py-2 text-gray-200 text-sm font-mono">
                {config.agent.workspaceDir}
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Runtime Data Directory</label>
              <div className="bg-gray-700 rounded px-3 py-2 text-gray-200 text-sm font-mono">
                {config.agent.runtimeDataDir || 'Not set'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
