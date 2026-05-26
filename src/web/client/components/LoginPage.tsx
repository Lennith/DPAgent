import React, { useState, type FormEvent } from 'react';
import { useTheme } from './providers/ThemeProvider.js';

interface LoginPageProps {
  onLoginSuccess: () => void;
}

export default function LoginPage({ onLoginSuccess }: LoginPageProps): React.ReactElement {
  const { theme } = useTheme();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const isDark = theme === 'dark';

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error || 'Login failed');
        return;
      }
      onLoginSuccess();
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  const cardBg = isDark ? 'bg-gray-800' : 'bg-white';
  const inputBg = isDark ? 'bg-gray-700' : 'bg-gray-50';
  const inputBorder = isDark ? 'border-gray-600' : 'border-gray-300';
  const textColor = isDark ? 'text-gray-100' : 'text-gray-900';
  const subColor = isDark ? 'text-gray-400' : 'text-gray-500';
  const errorBg = isDark ? 'bg-red-900/50 border-red-700 text-red-200' : 'bg-red-50 border-red-200 text-red-700';
  const btnBg = isDark ? 'bg-blue-600 hover:bg-blue-500' : 'bg-blue-600 hover:bg-blue-700';

  return (
    <div className={`flex min-h-screen items-center justify-center ${isDark ? 'bg-gray-900' : 'bg-gray-100'}`}>
      <div className={`w-full max-w-sm rounded-xl border p-8 shadow-lg ${cardBg} ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
        <div className="mb-6 text-center">
          <h1 className={`text-2xl font-bold ${textColor}`}>DPAgent</h1>
          <p className={`mt-1 text-sm ${subColor}`}>Remote Access</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className={`mb-1 block text-sm font-medium ${textColor}`}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              className={`w-full rounded-lg border px-3 py-2 ${inputBg} ${inputBorder} ${textColor} focus:outline-none focus:ring-2 focus:ring-blue-500`}
              placeholder="Enter password"
            />
          </div>
          {error && (
            <div className={`rounded-lg border px-3 py-2 text-sm ${errorBg}`}>{error}</div>
          )}
          <button
            type="submit"
            disabled={loading}
            className={`w-full rounded-lg px-4 py-2 text-sm font-semibold text-white transition ${btnBg} disabled:opacity-50`}
          >
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  );
}
