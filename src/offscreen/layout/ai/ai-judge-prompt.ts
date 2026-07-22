import type { CandidateForJudge } from "./candidate-judge-types";

export function buildCandidateJudgePrompt(candidates: CandidateForJudge[]): string {
  return `${CANDIDATE_JUDGE_PROMPT}

Required JSON schema:
{
  "candidates": [
    {
      "candidateId": "A",
      "label": "score_system",
      "isScoreCandidate": true,
      "confidence": 0.0,
      "reason": "short reason"
    }
  ]
}

Classify every candidate ID shown in the contact sheet: ${candidates.map((candidate) => candidate.id).join(", ")}.
Return only valid JSON.`;
}

export const CANDIDATE_JUDGE_PROMPT = `You are a visual classifier for a sheet-music extraction pipeline.

You will receive one contact sheet image containing multiple candidate crops from a YouTube music video.
Each crop has a visible ID such as A, B, C, D.

Your task is NOT to read music.
Your task is NOT to transcribe notes.
Your task is NOT to convert anything to MusicXML.

Your task is only to classify each candidate crop.

Use one of these labels:

- score_system: a visible sheet-music system, staff, grand staff, tab staff, or notation line that should be cropped
- score_region: a larger sheet-music region that may contain one or more systems
- piano_keyboard: piano keys or keyboard area
- hands: hands, fingers, or performer area
- subtitle_or_ui: subtitles, captions, YouTube controls, progress bar, overlay UI, or non-score text
- background: non-score background
- unknown: uncertain

Important rules:
- Piano keyboard keys are NOT sheet music.
- Piano roll visualization is NOT sheet music unless it contains actual staff notation.
- A grand staff with right-hand and left-hand staves should be treated as one score_system if both belong to the same musical system.
- A right-hand-only staff line is also a score_system.
- Multiple separate staff systems should be separate score_system candidates if they appear separately.
- If a crop contains both score and non-score content, classify it as score_region only if the score area is dominant.`;

