export type StartReason = "ok" | "finish_setup" | "no_tab";

export function evaluateStartGate(input: {
  settingsValid: boolean;
  hasActiveTab: boolean;
}): { canStart: boolean; reason: StartReason } {
  if (!input.settingsValid) {
    return { canStart: false, reason: "finish_setup" };
  }
  if (!input.hasActiveTab) {
    return { canStart: false, reason: "no_tab" };
  }
  return { canStart: true, reason: "ok" };
}
