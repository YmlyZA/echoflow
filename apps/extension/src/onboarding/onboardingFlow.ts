export const ONBOARDING_STEPS = ["welcome", "connect", "languages", "ready"] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function canAdvance(
  step: OnboardingStep,
  ctx: { connected: boolean }
): boolean {
  if (step === "connect") {
    return ctx.connected;
  }
  return true;
}

export function nextStep(step: OnboardingStep): OnboardingStep {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[Math.min(index + 1, ONBOARDING_STEPS.length - 1)];
}

export function prevStep(step: OnboardingStep): OnboardingStep {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[Math.max(index - 1, 0)];
}
