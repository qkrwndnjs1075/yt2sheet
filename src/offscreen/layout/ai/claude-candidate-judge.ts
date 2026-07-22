import { CLAUDE_JUDGE_SETTINGS_KEY, GEMINI_API_PERMISSION, normalizeClaudeJudgeSettings, type ClaudeJudgeSettings } from "../../../shared/ai-judge-settings";
import type { CheckGeminiHostPermissionResponse, ReadAiJudgeSettingsResponse, RuntimeMessage } from "../../../shared/messages";
import { buildCandidateJudgePrompt } from "./ai-judge-prompt";
import {
  parseClaudeCandidateJudgeResult,
  type CandidateContactSheet,
  type CandidateForJudge,
  type ClaudeCandidateJudgeResult
} from "./candidate-judge-types";

const GEMINI_GENERATE_CONTENT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

type ClaudeJudgeFetch = typeof fetch;

type GeminiTextPart = {
  text: string;
};

type GeminiGenerateContentResponse = {
  candidates?: {
    content?: {
      parts?: GeminiTextPart[];
    };
  }[];
};

export class ClaudeCandidateJudge {
  constructor(
    private readonly options: {
      readSettings?: () => Promise<ClaudeJudgeSettings>;
      fetchImpl?: ClaudeJudgeFetch;
    } = {}
  ) {}

  async isEnabled(): Promise<boolean> {
    const settings = await this.readSettings();
    if (!settings.enabled) {
      return false;
    }

    if (settings.proxyUrl) {
      return true;
    }

    return Boolean(settings.apiKey) && await this.hasGeminiHostPermission();
  }

  async judge(contactSheet: CandidateContactSheet, candidates: CandidateForJudge[]): Promise<ClaudeCandidateJudgeResult> {
    const settings = await this.readSettings();

    if (!settings.enabled || (!settings.apiKey && !settings.proxyUrl)) {
      throw new Error("AI candidate judge is not configured.");
    }

    const requestBody = buildGeminiRequestBody(contactSheet, candidates);
    const response = settings.proxyUrl
      ? await this.callProxy(settings.proxyUrl, requestBody, candidates)
      : await this.callGemini(settings.model, settings.apiKey ?? "", requestBody);

    return response;
  }

  private async callGemini(model: string, apiKey: string, requestBody: unknown): Promise<ClaudeCandidateJudgeResult> {
    if (!(await this.hasGeminiHostPermission())) {
      throw new Error("Gemini host permission is not granted.");
    }

    const response = await this.fetchImpl()(`${GEMINI_GENERATE_CONTENT_BASE_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(requestBody)
    });

    return parseJudgeHttpResponse(response);
  }

  private async callProxy(proxyUrl: string, requestBody: unknown, candidates: CandidateForJudge[]): Promise<ClaudeCandidateJudgeResult> {
    const response = await this.fetchImpl()(proxyUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        provider: "gemini",
        geminiRequest: requestBody,
        candidateIds: candidates.map((candidate) => candidate.id)
      })
    });

    return parseJudgeHttpResponse(response);
  }

  private async readSettings(): Promise<ClaudeJudgeSettings> {
    if (this.options.readSettings) {
      return this.options.readSettings();
    }

    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return this.readSettingsFromBackground();
    }

    const stored = await chrome.storage.local.get(CLAUDE_JUDGE_SETTINGS_KEY);
    return normalizeClaudeJudgeSettings(stored[CLAUDE_JUDGE_SETTINGS_KEY] as Partial<ClaudeJudgeSettings> | undefined);
  }

  private fetchImpl(): ClaudeJudgeFetch {
    return this.options.fetchImpl ?? fetch;
  }

  private async readSettingsFromBackground(): Promise<ClaudeJudgeSettings> {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      return normalizeClaudeJudgeSettings(undefined);
    }

    try {
      const response = await chrome.runtime.sendMessage<RuntimeMessage, ReadAiJudgeSettingsResponse>({ type: "READ_AI_JUDGE_SETTINGS" });
      return response?.ok === true ? normalizeClaudeJudgeSettings(response.settings) : normalizeClaudeJudgeSettings(undefined);
    } catch {
      return normalizeClaudeJudgeSettings(undefined);
    }
  }

  private async hasGeminiHostPermission(): Promise<boolean> {
    if (typeof chrome === "undefined") {
      return true;
    }

    if (chrome.permissions?.contains) {
      return chrome.permissions.contains({ origins: [GEMINI_API_PERMISSION] });
    }

    if (chrome.runtime?.sendMessage) {
      try {
        const response = await chrome.runtime.sendMessage<RuntimeMessage, CheckGeminiHostPermissionResponse>({ type: "CHECK_GEMINI_HOST_PERMISSION" });
        return response?.ok === true && response.granted;
      } catch {
        return false;
      }
    }

    return false;
  }
}

function buildGeminiRequestBody(contactSheet: CandidateContactSheet, candidates: CandidateForJudge[]): unknown {
  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: buildCandidateJudgePrompt(candidates)
          },
          {
            inline_data: {
              mime_type: contactSheet.mediaType,
              data: contactSheet.base64
            }
          }
        ]
      }
    ],
    generationConfig: {
      maxOutputTokens: 1200,
      responseMimeType: "application/json"
    }
  };
}

async function parseJudgeHttpResponse(response: Response): Promise<ClaudeCandidateJudgeResult> {
  const body = await response.json() as unknown;

  if (!response.ok) {
    throw new Error(`Gemini candidate judge HTTP ${response.status}: ${extractErrorMessage(body)}`);
  }

  if (isCandidateJudgeResultBody(body)) {
    return parseClaudeCandidateJudgeResult(body);
  }

  const text = extractGeminiText(body);
  return parseClaudeCandidateJudgeResult(JSON.parse(stripJsonFence(text)));
}

function isCandidateJudgeResultBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !Array.isArray((body as { candidates?: unknown }).candidates)) {
    return false;
  }

  return ((body as { candidates: unknown[] }).candidates).some((candidate) => (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { candidateId?: unknown }).candidateId === "string"
  ));
}

function extractGeminiText(body: unknown): string {
  const candidates = (body as GeminiGenerateContentResponse | undefined)?.candidates ?? [];
  const text = candidates
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .find((part) => typeof part.text === "string")?.text;

  if (!text) {
    throw new Error("Gemini candidate judge response did not include a text block.");
  }

  return text;
}

function stripJsonFence(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}

function extractErrorMessage(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return "unknown error";
  }

  const error = (body as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" ? error.message : JSON.stringify(body);
}
