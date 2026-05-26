import { useEffect, useState } from 'react';
import {
  ONBOARDING_DISMISSED_KEY,
  ONBOARDING_SESSION_COUNT_KEY,
  ONBOARDING_SESSION_MARK_KEY,
} from './chat-input-constants.js';

export function useChatInputOnboarding(): {
  sessionVisitCount: number;
  onboardingVisible: boolean;
  dismissOnboarding: () => void;
} {
  const [sessionVisitCount, setSessionVisitCount] = useState(0);
  const [dismissedOnboarding, setDismissedOnboarding] = useState(
    () => localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1'
  );

  useEffect(() => {
    const alreadyMarked = sessionStorage.getItem(ONBOARDING_SESSION_MARK_KEY) === '1';
    const stored = Number.parseInt(localStorage.getItem(ONBOARDING_SESSION_COUNT_KEY) ?? '0', 10);
    const safeStored = Number.isFinite(stored) && stored > 0 ? stored : 0;
    if (!alreadyMarked) {
      const next = safeStored + 1;
      localStorage.setItem(ONBOARDING_SESSION_COUNT_KEY, String(next));
      sessionStorage.setItem(ONBOARDING_SESSION_MARK_KEY, '1');
      setSessionVisitCount(next);
      return;
    }
    setSessionVisitCount(safeStored);
  }, []);

  const dismissOnboarding = (): void => {
    setDismissedOnboarding(true);
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
  };

  return {
    sessionVisitCount,
    onboardingVisible: sessionVisitCount > 0 && sessionVisitCount <= 3 && !dismissedOnboarding,
    dismissOnboarding,
  };
}
