export const CLAUDE_JUDGE_SETTINGS_KEY = "aiJudgeSettings";

export const DEFAULT_CLAUDE_JUDGE_MODEL = "gemini-3.1-flash-lite";
export const GEMINI_API_PERMISSION = "https://generativelanguage.googleapis.com/*";

export type ClaudeJudgeSettings = {
  enabled: boolean;
  apiKey?: string;
  proxyUrl?: string;
  model: string;
};

export function defaultClaudeJudgeSettings(): ClaudeJudgeSettings {
  return {
    enabled: false,
    model: DEFAULT_CLAUDE_JUDGE_MODEL
  };
}

export function normalizeClaudeJudgeSettings(settings: Partial<ClaudeJudgeSettings> | undefined): ClaudeJudgeSettings {
  const defaults = defaultClaudeJudgeSettings();
  const apiKey = settings?.apiKey?.trim();
  const model = settings?.model?.startsWith("gemini-") ? settings.model : defaults.model;
  const normalized: ClaudeJudgeSettings = {
    ...defaults,
    ...settings,
    enabled: settings?.enabled ?? defaults.enabled,
    model
  };

  if (apiKey) {
    normalized.apiKey = apiKey;
  } else {
    delete normalized.apiKey;
  }

  return normalized;
}
