'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface AppSettings {
  confirmDeleteFinishedImages: boolean;
  confirmDeleteCancelledJobs: boolean;
  confirmStopJobs: boolean;
  autoSelectNewJobs: boolean;
  persistStudioDraft: boolean;
  defaultAdvancedOpen: boolean;
  showEta: boolean;
  showElapsed: boolean;
  showSeed: boolean;
  showQueuePosition: boolean;
  showPromptFooter: boolean;
  showPhaseChecklist: boolean;
  compactHistoryCards: boolean;
  showModelGuidanceCard: boolean;
  historyPageSize: number;
  leftPaneWidth: number;
  rightPaneWidth: number;
}

interface SettingsContextValue {
  settings: AppSettings;
  setSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  resetSettings: () => void;
}

const SETTINGS_STORAGE_KEY = 'iris-app-settings';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  confirmDeleteFinishedImages: true,
  confirmDeleteCancelledJobs: false,
  confirmStopJobs: true,
  autoSelectNewJobs: true,
  persistStudioDraft: true,
  defaultAdvancedOpen: false,
  showEta: true,
  showElapsed: true,
  showSeed: true,
  showQueuePosition: true,
  showPromptFooter: true,
  showPhaseChecklist: true,
  compactHistoryCards: false,
  showModelGuidanceCard: true,
  historyPageSize: 20,
  leftPaneWidth: 320,
  rightPaneWidth: 320,
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeNumber(value: number | null | undefined, fallback: number, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return clamp(value, min, max);
}

function normalizeSettings(partial: Partial<AppSettings> | null | undefined): AppSettings {
  return {
    confirmDeleteFinishedImages: partial?.confirmDeleteFinishedImages ?? DEFAULT_APP_SETTINGS.confirmDeleteFinishedImages,
    confirmDeleteCancelledJobs: partial?.confirmDeleteCancelledJobs ?? DEFAULT_APP_SETTINGS.confirmDeleteCancelledJobs,
    confirmStopJobs: partial?.confirmStopJobs ?? DEFAULT_APP_SETTINGS.confirmStopJobs,
    autoSelectNewJobs: partial?.autoSelectNewJobs ?? DEFAULT_APP_SETTINGS.autoSelectNewJobs,
    persistStudioDraft: partial?.persistStudioDraft ?? DEFAULT_APP_SETTINGS.persistStudioDraft,
    defaultAdvancedOpen: partial?.defaultAdvancedOpen ?? DEFAULT_APP_SETTINGS.defaultAdvancedOpen,
    showEta: partial?.showEta ?? DEFAULT_APP_SETTINGS.showEta,
    showElapsed: partial?.showElapsed ?? DEFAULT_APP_SETTINGS.showElapsed,
    showSeed: partial?.showSeed ?? DEFAULT_APP_SETTINGS.showSeed,
    showQueuePosition: partial?.showQueuePosition ?? DEFAULT_APP_SETTINGS.showQueuePosition,
    showPromptFooter: partial?.showPromptFooter ?? DEFAULT_APP_SETTINGS.showPromptFooter,
    showPhaseChecklist: partial?.showPhaseChecklist ?? DEFAULT_APP_SETTINGS.showPhaseChecklist,
    compactHistoryCards: partial?.compactHistoryCards ?? DEFAULT_APP_SETTINGS.compactHistoryCards,
    showModelGuidanceCard: partial?.showModelGuidanceCard ?? DEFAULT_APP_SETTINGS.showModelGuidanceCard,
    historyPageSize: normalizeNumber(partial?.historyPageSize, DEFAULT_APP_SETTINGS.historyPageSize, 10, 100),
    leftPaneWidth: normalizeNumber(partial?.leftPaneWidth, DEFAULT_APP_SETTINGS.leftPaneWidth, 280, 520),
    rightPaneWidth: normalizeNumber(partial?.rightPaneWidth, DEFAULT_APP_SETTINGS.rightPaneWidth, 280, 520),
  };
}

function readStoredSettings(): AppSettings {
  if (typeof window === 'undefined') {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_APP_SETTINGS;
    }

    return normalizeSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => readStoredSettings());

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (settings.persistStudioDraft) {
      return;
    }

    window.localStorage.removeItem('iris-studio-draft');
  }, [settings.persistStudioDraft]);

  const value = useMemo<SettingsContextValue>(() => ({
    settings,
    setSetting: (key, nextValue) => {
      setSettings((current) => normalizeSettings({
        ...current,
        [key]: nextValue,
      }));
    },
    resetSettings: () => {
      setSettings(DEFAULT_APP_SETTINGS);
    },
  }), [settings]);

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useAppSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useAppSettings must be used inside SettingsProvider');
  }

  return context;
}
