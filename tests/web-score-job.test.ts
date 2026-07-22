import assert from "node:assert/strict";
import { test } from "node:test";
import { parseScoreJobInput, parseScoreJobResponse, ScoreJobContractError } from "../web/src/job-contract.js";

test("score job input canonicalizes a supported YouTube link", () => {
  // Given
  const input = "https://youtu.be/dQw4w9WgXcQ?t=42";

  // When
  const result = parseScoreJobInput(input);

  // Then
  assert.deepEqual(result, {
    ok: true,
    value: {
      videoId: "dQw4w9WgXcQ",
      videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    }
  });
});

test("score job input rejects malformed input with user-facing guidance", () => {
  // Given
  const input = "not-a-youtube-link";

  // When
  const result = parseScoreJobInput(input);

  // Then
  assert.deepEqual(result, {
    ok: false,
    message: "유효한 YouTube 링크를 입력해주세요."
  });
});

test("score job response parses queued and running progress states", () => {
  // Given
  const responses = [
    { jobId: "job_123", status: "queued" },
    { jobId: "job_123", status: "running", progress: 48 }
  ];

  // When
  const results = responses.map(parseScoreJobResponse);

  // Then
  assert.deepEqual(results, responses);
});

test("score job response requires a real result before succeeding", () => {
  // Given
  const response = {
    jobId: "job_123",
    status: "succeeded",
    progress: 100,
    result: {
      downloadUrl: "https://files.example.test/job_123.pdf",
      fileName: "lesson-score.pdf",
      pageCount: 4
    }
  };

  // When
  const result = parseScoreJobResponse(response);

  // Then
  assert.deepEqual(result, response);
});

test("score job response preserves a recoverable backend failure", () => {
  // Given
  const response = {
    jobId: "job_123",
    status: "failed",
    error: {
      code: "VIDEO_UNAVAILABLE",
      message: "영상을 불러오지 못했습니다. 링크를 확인하고 다시 시도해주세요."
    }
  };

  // When
  const result = parseScoreJobResponse(response);

  // Then
  assert.deepEqual(result, response);
});

test("score job response rejects success without a download result", () => {
  // Given
  const response = { jobId: "job_123", status: "succeeded", progress: 100 };

  // When / Then
  assert.throws(() => parseScoreJobResponse(response), /Invalid score job response/);
});

test("score job response rejects a non-HTTP download URL", () => {
  // Given
  const response = {
    jobId: "job_123",
    status: "succeeded",
    progress: 100,
    result: {
      downloadUrl: "javascript:alert(1)",
      fileName: "lesson-score.pdf",
      pageCount: 1
    }
  };

  // When / Then
  assert.throws(() => parseScoreJobResponse(response), /Invalid score job response/);
});

test("score job response reports a malformed download URL as a contract error", () => {
  // Given
  const response = {
    jobId: "job_123",
    status: "succeeded",
    progress: 100,
    result: {
      downloadUrl: "not-a-url",
      fileName: "lesson-score.pdf",
      pageCount: 1
    }
  };

  // When / Then
  assert.throws(() => parseScoreJobResponse(response), ScoreJobContractError);
});
