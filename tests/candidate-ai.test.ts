import assert from "node:assert/strict";
import { test } from "node:test";
import { AiJudgeCache } from "../src/offscreen/layout/ai/ai-judge-cache.js";
import type { CandidateForJudge, CandidateJudgeResultForProposal, ClaudeCandidateJudgeCandidate } from "../src/offscreen/layout/ai/candidate-judge-types.js";
import type { CandidateContactSheetBuilder } from "../src/offscreen/layout/ai/candidate-contact-sheet-builder.js";
import { ClaudeCandidateJudge } from "../src/offscreen/layout/ai/claude-candidate-judge.js";
import { CandidateResolver } from "../src/offscreen/layout/resolver/candidate-resolver.js";
import { DynamicScoreLayoutDetector, selectCandidatesForAiJudge } from "../src/offscreen/layout/dynamic-score-layout-detector.js";
import { TemporalRegionTracker } from "../src/offscreen/layout/temporal-region-tracker.js";
import type { CandidateJudgeLabel, ScoreRegionProposal } from "../src/shared/layout-types.js";
import type { OffscreenInputFrame } from "../src/offscreen/frame-sink.js";

test("resolver rejects piano keyboard, subtitle/UI, and background labels", () => {
  const resolver = new CandidateResolver();

  for (const label of ["piano_keyboard", "subtitle_or_ui", "background"] as const) {
    const [resolved] = resolver.resolve({
      proposals: [makeProposal(label)],
      aiResults: [makeAiResult("proposal_1", label, 0.9)]
    });

    assert.equal(resolved.status, "rejected");
    assert.match(resolved.rejectReason ?? "", /^AI_/);
  }
});

test("resolver promotes score labels and leaves low-confidence or hands labels weak", () => {
  const resolver = new CandidateResolver();
  const [score] = resolver.resolve({
    proposals: [makeProposal("score_system")],
    aiResults: [makeAiResult("proposal_1", "score_system", 0.86)]
  });
  const [unknown] = resolver.resolve({
    proposals: [makeProposal("unknown")],
    aiResults: [makeAiResult("proposal_1", "unknown", 0.52)]
  });
  const [hands] = resolver.resolve({
    proposals: [makeProposal("hands")],
    aiResults: [makeAiResult("proposal_1", "hands", 0.91)]
  });

  assert.equal(score.status, "promoted");
  assert.equal(score.ai?.label, "score_system");
  assert.equal(unknown.status, "weak");
  assert.equal(hands.status, "weak");
});

test("hands label is not promoted by temporal stability alone", () => {
  const resolver = new CandidateResolver();
  const tracker = new TemporalRegionTracker();
  const initial = resolver.resolve({
    proposals: [makeProposal("hands", 0.74)],
    aiResults: [makeAiResult("proposal_1", "hands", 0.92)]
  })[0];

  tracker.update(1, 1, [initial]);
  tracker.update(2, 1.4, [initial]);
  const tracked = tracker.update(3, 1.8, [initial]);
  const [resolved] = resolver.resolve({ proposals: tracked, aiResults: [] });

  assert.equal(resolved.status, "weak");
  assert.equal(resolved.ai?.label, "hands");
});

test("AI judge cache reuses same rounded candidate within TTL", () => {
  let now = 1000;
  const cache = new AiJudgeCache(() => now);
  const candidate = makeCandidate("A");
  cache.set("video_1", candidate, {
    candidateId: "A",
    label: "score_system",
    isScoreCandidate: true,
    confidence: 0.82,
    reason: "staff lines"
  });

  const hit = cache.get("video_1", { ...candidate, id: "B", rect: { ...candidate.rect, x: candidate.rect.x + 3 } });
  assert.equal(hit?.result.candidateId, "B");
  assert.equal(hit?.result.label, "score_system");

  now += 3001;
  assert.equal(cache.get("video_1", candidate), null);
});

test("disabled AI judge ignores cached judgments", async () => {
  const cache = new AiJudgeCache(() => 10_000);
  cache.set("video_1", makeCandidate("A"), {
    candidateId: "A",
    label: "piano_keyboard",
    isScoreCandidate: false,
    confidence: 0.95,
    reason: "cached keyboard"
  });
  const detector = new DynamicScoreLayoutDetector({
    now: () => 10_000,
    aiJudgeCache: cache,
    aiJudge: {
      isEnabled: async () => false,
      judge: async () => {
        throw new Error("should not call");
      }
    }
  }) as unknown as {
    judgeCandidates(frame: OffscreenInputFrame, proposals: ScoreRegionProposal[]): Promise<{
      results: CandidateJudgeResultForProposal[];
      debug: { enabled: boolean; skippedReason?: string; cacheHits: string[] };
    }>;
  };

  const result = await detector.judgeCandidates(makeFrame(), [makeProposal("score_system")]);

  assert.equal(result.debug.enabled, false);
  assert.equal(result.debug.skippedReason, "AI_JUDGE_NOT_CONFIGURED");
  assert.equal(result.debug.cacheHits.length, 0);
  assert.equal(result.results.length, 0);
});

test("direct Gemini judge is disabled without host permission", async () => {
  const previousChrome = (globalThis as { chrome?: unknown }).chrome;
  (globalThis as { chrome?: unknown }).chrome = {
    permissions: {
      contains: async () => false
    }
  };

  try {
    const judge = new ClaudeCandidateJudge({
      readSettings: async () => ({ enabled: true, apiKey: "test-key", model: "gemini-3.1-flash-lite" }),
      fetchImpl: async () => {
        throw new Error("should not call");
      }
    });

    assert.equal(await judge.isEnabled(), false);
    await assert.rejects(
      () => judge.judge({ base64: "abc", mediaType: "image/jpeg", candidateIds: ["A"], width: 256, height: 256 }, [makeCandidate("A")]),
      /Gemini host permission is not granted/
    );
  } finally {
    (globalThis as { chrome?: unknown }).chrome = previousChrome;
  }
});

test("direct Gemini judge is enabled with host permission", async () => {
  const previousChrome = (globalThis as { chrome?: unknown }).chrome;
  (globalThis as { chrome?: unknown }).chrome = {
    permissions: {
      contains: async () => true
    }
  };

  try {
    const judge = new ClaudeCandidateJudge({
      readSettings: async () => ({ enabled: true, apiKey: "test-key", model: "gemini-3.1-flash-lite" }),
      fetchImpl: async () => new Response(JSON.stringify({
        candidates: [
          {
            candidateId: "A",
            label: "score_region",
            isScoreCandidate: true,
            confidence: 0.88,
            reason: "dominant notation"
          }
        ]
      }), { status: 200 })
    });

    assert.equal(await judge.isEnabled(), true);
  } finally {
    (globalThis as { chrome?: unknown }).chrome = previousChrome;
  }
});

test("direct Gemini judge asks background for permission in offscreen-shaped context", async () => {
  const previousChrome = (globalThis as { chrome?: unknown }).chrome;
  const sentMessages: unknown[] = [];
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: async (message: unknown) => {
        sentMessages.push(message);
        return { ok: true, granted: false };
      }
    }
  };

  try {
    const judge = new ClaudeCandidateJudge({
      readSettings: async () => ({ enabled: true, apiKey: "test-key", model: "gemini-3.1-flash-lite" }),
      fetchImpl: async () => {
        throw new Error("should not call");
      }
    });

    assert.equal(await judge.isEnabled(), false);
    assert.deepEqual(sentMessages, [{ type: "CHECK_GEMINI_HOST_PERMISSION" }]);
  } finally {
    (globalThis as { chrome?: unknown }).chrome = previousChrome;
  }
});

test("AI judge reads settings through background in offscreen-shaped context", async () => {
  const previousChrome = (globalThis as { chrome?: unknown }).chrome;
  const sentMessages: unknown[] = [];
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: async (message: { type: string }) => {
        sentMessages.push(message);
        if (message.type === "READ_AI_JUDGE_SETTINGS") {
          return {
            ok: true,
            settings: {
              enabled: true,
              apiKey: "test-key",
              model: "gemini-3.1-flash-lite"
            }
          };
        }

        return { ok: true, granted: true };
      }
    }
  };

  try {
    const judge = new ClaudeCandidateJudge({
      fetchImpl: async () => new Response(JSON.stringify({
        candidates: [
          {
            candidateId: "A",
            label: "score_region",
            isScoreCandidate: true,
            confidence: 0.88,
            reason: "dominant notation"
          }
        ]
      }), { status: 200 })
    });

    assert.equal(await judge.isEnabled(), true);
    const result = await judge.judge({ base64: "abc", mediaType: "image/jpeg", candidateIds: ["A"], width: 256, height: 256 }, [makeCandidate("A")]);
    assert.equal(result.candidates[0].label, "score_region");
    assert.deepEqual(sentMessages.map((message) => (message as { type: string }).type), [
      "READ_AI_JUDGE_SETTINGS",
      "CHECK_GEMINI_HOST_PERMISSION",
      "READ_AI_JUDGE_SETTINGS",
      "CHECK_GEMINI_HOST_PERMISSION"
    ]);
  } finally {
    (globalThis as { chrome?: unknown }).chrome = previousChrome;
  }
});

test("candidate selection assigns A-L IDs and excludes oversized regions", () => {
  const frame = makeFrame();
  const proposals = [
    makeProposal("score_system", 0.9, { x: 0, y: 0, width: 800, height: 500 }),
    ...Array.from({ length: 13 }, (_, index) => makeProposal("score_system", 0.8 - index * 0.01, { x: 10, y: 20 + index * 10, width: 300, height: 40 }))
  ];

  const candidates = selectCandidatesForAiJudge(frame, proposals);

  assert.equal(candidates.length, 12);
  assert.deepEqual(candidates.map((candidate) => candidate.id), "ABCDEFGHIJKL".split(""));
  assert.ok(candidates.every((candidate) => candidate.rect.height < 500));
});

test("Gemini judge sends contact sheet and parses JSON labels", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const judge = new ClaudeCandidateJudge({
    readSettings: async () => ({ enabled: true, apiKey: "test-key", model: "gemini-3.1-flash-lite" }),
    fetchImpl: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    candidates: [
                      {
                        candidateId: "A",
                        label: "score_region",
                        isScoreCandidate: true,
                        confidence: 0.88,
                        reason: "dominant notation"
                      }
                    ]
                  })
                }
              ]
            }
          }
        ]
      }), { status: 200 });
    }
  });

  const result = await judge.judge({
    base64: "abc",
    mediaType: "image/jpeg",
    candidateIds: ["A"],
    width: 256,
    height: 256
  }, [makeCandidate("A")]);

  const headers = capturedInit?.headers as Record<string, string>;
  const body = JSON.parse(String(capturedInit?.body)) as {
    contents: { parts: ({ text: string } | { inline_data: { mime_type: string; data: string } })[] }[];
    generationConfig: { responseMimeType: string };
  };

  assert.equal(capturedUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent");
  assert.equal(headers["x-goog-api-key"], "test-key");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.ok("text" in body.contents[0].parts[0]);
  assert.deepEqual(body.contents[0].parts[1], {
    inline_data: {
      mime_type: "image/jpeg",
      data: "abc"
    }
  });
  assert.equal(result.candidates[0].label, "score_region");
});

test("Gemini judge surfaces HTTP failures", async () => {
  const failingJudge = new ClaudeCandidateJudge({
    readSettings: async () => ({ enabled: true, apiKey: "test-key", model: "gemini-3.1-flash-lite" }),
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })
  });

  await assert.rejects(
    () => failingJudge.judge({ base64: "abc", mediaType: "image/jpeg", candidateIds: ["A"], width: 256, height: 256 }, [makeCandidate("A")]),
    /HTTP 429/
  );
});

test("AI judge accepts direct candidate JSON from proxy", async () => {
  const judge = new ClaudeCandidateJudge({
    readSettings: async () => ({ enabled: true, proxyUrl: "https://proxy.example.com/gemini", model: "gemini-3.1-flash-lite" }),
    fetchImpl: async () => new Response(JSON.stringify({
      candidates: [
        {
          candidateId: "A",
          label: "score_region",
          isScoreCandidate: true,
          confidence: 0.88,
          reason: "dominant notation"
        }
      ]
    }), { status: 200 })
  });

  const result = await judge.judge({
    base64: "abc",
    mediaType: "image/jpeg",
    candidateIds: ["A"],
    width: 256,
    height: 256
  }, [makeCandidate("A")]);

  assert.equal(result.candidates[0].label, "score_region");
});

test("failed AI calls are throttled before retrying", async () => {
  let now = 10_000;
  let calls = 0;
  const detector = new DynamicScoreLayoutDetector({
    now: () => now,
    contactSheetBuilder: {
      build: async () => ({
        base64: "abc",
        mediaType: "image/jpeg" as const,
        candidateIds: ["A"],
        width: 256,
        height: 256
      })
    } as unknown as CandidateContactSheetBuilder,
    aiJudge: {
      isEnabled: async () => true,
      judge: async () => {
        calls += 1;
        throw new Error("rate limited");
      }
    }
  }) as unknown as {
    judgeCandidates(frame: OffscreenInputFrame, proposals: ScoreRegionProposal[]): Promise<{
      debug: { called: boolean; skippedReason?: string; error?: string };
    }>;
  };

  const first = await detector.judgeCandidates(makeFrame(), [makeProposal("score_system")]);
  now += 400;
  const second = await detector.judgeCandidates(makeFrame(), [makeProposal("score_system")]);

  assert.equal(calls, 1);
  assert.equal(first.debug.called, true);
  assert.equal(first.debug.error, "rate limited");
  assert.equal(second.debug.called, false);
  assert.equal(second.debug.skippedReason, "AI_JUDGE_MIN_INTERVAL");
});

test("partial AI labels fail open with debug evidence", async () => {
  const detector = makeDetectorWithJudgeResponse([
    {
      candidateId: "A",
      label: "score_system",
      isScoreCandidate: true,
      confidence: 0.9,
      reason: "staff"
    }
  ]);
  const result = await detector.judgeCandidates(makeFrame(), proposals);

  assert.equal(result.debug.called, true);
  assert.match(result.debug.error ?? "", /invalid candidate labels/);
  assert.match(result.debug.error ?? "", /Missing: B/);
  assert.equal(result.results.length, 0);
});

test("duplicate AI labels fail open with debug evidence", async () => {
  const detector = makeDetectorWithJudgeResponse([
    {
      candidateId: "A",
      label: "score_system",
      isScoreCandidate: true,
      confidence: 0.9,
      reason: "staff"
    },
    {
      candidateId: "A",
      label: "background",
      isScoreCandidate: false,
      confidence: 0.9,
      reason: "duplicate"
    },
    {
      candidateId: "B",
      label: "score_region",
      isScoreCandidate: true,
      confidence: 0.82,
      reason: "region"
    }
  ]);
  const result = await detector.judgeCandidates(makeFrame(), proposals);

  assert.equal(result.debug.called, true);
  assert.match(result.debug.error ?? "", /duplicate: A/);
  assert.equal(result.results.length, 0);
});

const proposals = [
  makeProposal("score_system", 0.8, { x: 10, y: 20, width: 300, height: 40 }),
  { ...makeProposal("score_system", 0.79, { x: 10, y: 80, width: 300, height: 40 }), id: "proposal_2" }
];

function makeAiResult(proposalId: string, label: CandidateJudgeLabel, confidence: number): CandidateJudgeResultForProposal {
  return {
    candidateId: "A",
    proposalId,
    label,
    isScoreCandidate: label === "score_system" || label === "score_region",
    confidence,
    reason: label
  };
}

function makeDetectorWithJudgeResponse(candidates: ClaudeCandidateJudgeCandidate[]): {
  judgeCandidates(frame: OffscreenInputFrame, proposals: ScoreRegionProposal[]): Promise<{
    results: CandidateJudgeResultForProposal[];
    debug: { called: boolean; error?: string };
  }>;
} {
  return new DynamicScoreLayoutDetector({
    now: () => 10_000,
    contactSheetBuilder: {
      build: async () => ({
        base64: "abc",
        mediaType: "image/jpeg" as const,
        candidateIds: ["A", "B"],
        width: 512,
        height: 256
      })
    } as unknown as CandidateContactSheetBuilder,
    aiJudge: {
      isEnabled: async () => true,
      judge: async () => ({ candidates })
    }
  }) as unknown as {
    judgeCandidates(frame: OffscreenInputFrame, proposals: ScoreRegionProposal[]): Promise<{
      results: CandidateJudgeResultForProposal[];
      debug: { called: boolean; error?: string };
    }>;
  };
}

function makeCandidate(id: string): CandidateForJudge {
  return {
    id,
    proposalId: "proposal_1",
    rect: { x: 16, y: 32, width: 220, height: 64 },
    source: "horizontal_line",
    ruleScore: 0.7
  };
}

function makeProposal(label: CandidateJudgeLabel, ruleScore = 0.72, rect = { x: 16, y: 32, width: 220, height: 64 }): ScoreRegionProposal {
  return {
    id: "proposal_1",
    rect,
    source: "horizontal_line",
    ruleScores: {
      horizontalLineScore: ruleScore,
      brightPanelScore: 0.2,
      edgeDensityScore: 0.4,
      aspectRatioScore: 0.9,
      contrastScore: 0.5,
      finalRuleScore: ruleScore
    },
    ai: undefined,
    finalScores: {
      ruleScore,
      aiScore: 0,
      temporalStabilityScore: 0,
      finalScore: ruleScore
    },
    scores: {
      horizontalLineScore: ruleScore,
      brightPanelScore: 0.2,
      edgeDensityScore: 0.4,
      aspectRatioScore: 0.9,
      contrastScore: 0.5,
      temporalStabilityScore: 0,
      finalScore: ruleScore
    },
    status: label === "background" ? "weak" : "promoted"
  };
}

function makeFrame(): OffscreenInputFrame {
  return {
    id: "frame_1",
    sessionId: "session_1",
    source: {
      platform: "youtube",
      videoId: "video_1",
      url: "https://www.youtube.com/watch?v=video_1",
      title: "Synthetic"
    },
    timing: {
      timestampSec: 1,
      sampledAt: new Date(0).toISOString(),
      frameIndex: 1,
      playbackRate: 1
    },
    image: {
      width: 640,
      height: 360,
      bitmapRef: {} as HTMLCanvasElement
    },
    meta: {
      sampleIntervalMs: 400,
      tabId: 1
    }
  };
}
