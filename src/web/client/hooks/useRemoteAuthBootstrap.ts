import { useCallback, useEffect, useState } from 'react';

interface AuthStatusResponse {
  required?: boolean;
  authenticated?: boolean;
  local?: boolean;
}

export interface RemoteAuthBootstrapState {
  checked: boolean;
  required: boolean;
  authenticated: boolean;
  websocketEnabled: boolean;
  markAuthenticated: () => void;
}

export function useRemoteAuthBootstrap(): RemoteAuthBootstrapState {
  const [checked, setChecked] = useState(false);
  const [required, setRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(true);

  useEffect(() => {
    let canceled = false;
    void fetch('/api/auth/status')
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Auth status request failed: ${res.status}`);
        }
        const status = (await res.json()) as AuthStatusResponse;
        if (canceled) {
          return;
        }
        const nextRequired = status.required === true;
        const nextAuthenticated = !nextRequired || status.authenticated === true;
        setRequired(nextRequired);
        setAuthenticated(nextAuthenticated);
        setChecked(true);
      })
      .catch(() => {
        if (!canceled) {
          setRequired(true);
          setAuthenticated(false);
          setChecked(true);
        }
      });
    return () => {
      canceled = true;
    };
  }, []);

  const markAuthenticated = useCallback(() => {
    setAuthenticated(true);
    setRequired(false);
    setChecked(true);
  }, []);

  return {
    checked,
    required,
    authenticated,
    websocketEnabled: checked && (!required || authenticated),
    markAuthenticated,
  };
}
