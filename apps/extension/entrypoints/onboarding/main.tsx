import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  CapabilitiesDescriptor,
  ModeCapabilities
} from "@echoflow/protocol";
import {
  OnboardingApp,
  type ConnectState,
  type OnboardingHandlers,
  type OnboardingView
} from "../../src/onboarding/OnboardingApp";
import {
  canAdvance,
  nextStep,
  prevStep,
  type OnboardingStep
} from "../../src/onboarding/onboardingFlow";
import { summarizeCapabilities } from "../../src/onboarding/connectionSummary";
import {
  counterpartSource,
  loadSettings,
  saveSettings,
  DEFAULT_SUBTITLE_FONT_SIZE,
  type ExtensionSettings
} from "../../src/settings/settings";
import { fetchCapabilities } from "../../src/settings/capabilitiesClient";
import { coercePair, targetOptions } from "../../src/settings/languageSelection";

const SETUP_GUIDE_URL =
  "https://github.com/YmlyZA/echoflow#readme";

function OnboardingRoot() {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilitiesDescriptor | null>(null);
  const [connectState, setConnectState] = useState<ConnectState>("idle");

  useEffect(() => {
    void loadSettings().then((loaded) =>
      setSettings({
        ...loaded,
        serverUrl: loaded.serverUrl || "http://127.0.0.1:8787",
        subtitleFontSize: loaded.subtitleFontSize || DEFAULT_SUBTITLE_FONT_SIZE
      })
    );
  }, []);

  // Debounced connection test (mirrors Options).
  useEffect(() => {
    const serverUrl = settings?.serverUrl.trim() ?? "";
    const apiKey = settings?.apiKey.trim() ?? "";
    if (!serverUrl || !apiKey) {
      setCapabilities(null);
      setConnectState("idle");
      return;
    }
    let active = true;
    setConnectState("loading");
    const timer = setTimeout(() => {
      void fetchCapabilities(serverUrl, apiKey).then((caps) => {
        if (!active) return;
        setCapabilities(caps);
        setConnectState(caps ? "ok" : "error");
      });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [settings?.serverUrl, settings?.apiKey]);

  const modeCaps: ModeCapabilities | null = useMemo(
    () => (settings && capabilities ? capabilities.modes[settings.mode] : null),
    [settings, capabilities]
  );
  const connected = connectState === "ok";

  const patch = useCallback((next: Partial<ExtensionSettings>) => {
    setSettings((current) => (current ? { ...current, ...next } : current));
  }, []);

  const persistAndClose = useCallback(async () => {
    if (settings) await saveSettings(settings);
    window.close();
  }, [settings]);

  if (!settings) return null;

  const view: OnboardingView = {
    step,
    canContinue: canAdvance(step, { connected }),
    serverUrl: settings.serverUrl,
    apiKey: settings.apiKey,
    connectState,
    connectSummary: capabilities ? summarizeCapabilities(capabilities) : null,
    mode: settings.mode,
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    targetOptions: modeCaps ? targetOptions(modeCaps, settings.sourceLanguage) : []
  };

  const handlers: OnboardingHandlers = {
    onServerUrlChange: (v) => patch({ serverUrl: v }),
    onApiKeyChange: (v) => patch({ apiKey: v }),
    onModeChange: (mode) => {
      const caps = capabilities?.modes[mode] ?? null;
      if (!caps) return patch({ mode });
      const pair = coercePair(caps, settings.sourceLanguage, settings.targetLanguage);
      patch({ mode, sourceLanguage: pair.source, targetLanguage: pair.target });
    },
    onTargetChange: (code) => {
      if (!modeCaps) return patch({ targetLanguage: code, sourceLanguage: counterpartSource(code) });
      const pair = coercePair(modeCaps, counterpartSource(code), code);
      patch({ sourceLanguage: pair.source, targetLanguage: pair.target });
    },
    onBack: () => setStep((s) => prevStep(s)),
    onNext: () => setStep((s) => (canAdvance(s, { connected }) ? nextStep(s) : s)),
    onFinishAnyway: () => void persistAndClose(),
    onSkip: () => void persistAndClose(),
    onDone: () => void persistAndClose(),
    onOpenOptions: () => void chrome.runtime.openOptionsPage(),
    onOpenSetupGuide: () => void chrome.tabs.create({ url: SETUP_GUIDE_URL })
  };

  return <OnboardingApp view={view} handlers={handlers} />;
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<OnboardingRoot />);
}
