import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";
import { parseScoreJobInput, parseScoreJobResponse, ScoreJobContractError } from "../web/src/job-contract.js";
import type { ScoreJob, ScoreJobInput } from "../web/src/job-contract.js";
import type { RunScoreJobOptions } from "../web/src/job-client.js";
import { ScoreJobNotFoundError } from "../web/src/job-client.js";
import { initializeWebApp } from "../web/src/main.js";

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
    { jobId: "job_123", status: "running", progress: 48 },
    { jobId: "job_123", status: "cancelled" }
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
      downloadUrl: "/api/score-jobs/job_123/download",
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

test("score job response rejects download URLs outside the exact job-bound path", () => {
  // Given
  const invalidDownloadUrls = [
    "https://files.example.test/job_123.pdf",
    "//files.example.test/job_123.pdf",
    "/api/score-jobs/job_other/download",
    "/api/score-jobs/job_123/download?token=unexpected"
  ];

  // When / Then
  for (const downloadUrl of invalidDownloadUrls) {
    assert.throws(() => parseScoreJobResponse({
      jobId: "job_123",
      status: "succeeded",
      progress: 100,
      result: { downloadUrl, fileName: "lesson-score.pdf", pageCount: 1 }
    }), ScoreJobContractError);
  }
});

test("standalone form marks malformed input invalid and keeps the required keyboard order", () => {
  const harness = createHarness();
  try {
    harness.form.dispatch("submit");

    assert.equal(harness.input.getAttribute("aria-invalid"), "true");
    assert.equal(harness.input.focusCount, 1);
    assert.equal(harness.app.markup.includes('id="pdf-preset"'), false);
    assert.equal(harness.app.markup.includes("PDF 용지"), false);
    assert.ok(harness.app.markup.indexOf('id="youtube-url"') < harness.app.markup.indexOf('type="submit"'));
    assert.ok(harness.app.markup.indexOf('type="submit"') < harness.app.markup.indexOf('id="cancel-job"'));
    assert.match(harness.app.markup, /role="status" aria-live="polite" aria-atomic="true"/);
  } finally {
    harness.restore();
  }
});

test("standalone helper keeps its auxiliary Korean phrase as one semantic unit", () => {
  // Given
  const mainSource = readFileSync(resolve(process.cwd(), "web/src/main.ts"), "utf8");
  const stylesSource = readFileSync(resolve(process.cwd(), "web/src/styles.css"), "utf8");

  // When
  const helperPhraseClass = mainSource.match(/<span class="(field-help__phrase)">[^<]+<\/span>/)?.[1];

  // Then
  assert.equal(helperPhraseClass, "field-help__phrase");
  assert.match(stylesSource, /\.field-help__phrase\s*\{[^}]*white-space:\s*nowrap;/s);
});

test("standalone cancellation DELETEs before local abort and ignores stale prior-run work", async () => {
  const harness = createHarness();
  try {
    harness.input.value = "https://youtu.be/dQw4w9WgXcQ";
    harness.form.dispatch("submit");
    await settle();
    harness.runs[0]?.options.onUpdate({ jobId: "job_first", status: "queued" });

    assert.equal(harness.submit.disabled, true);
    assert.equal(harness.cancel.hidden, false);
    assert.deepEqual(harness.runs[0]?.options.input, {
      videoId: "dQw4w9WgXcQ",
      videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    });

    harness.cancel.dispatch("click");
    harness.form.dispatch("submit");
    await settle();
    harness.runs[1]?.options.onUpdate({ jobId: "job_current", status: "running", progress: 44 });
    harness.cancelled[0]?.resolve({ jobId: "job_first", status: "cancelled" });
    harness.runs[0]?.reject(new DOMException("cancelled", "AbortError"));
    await settle();

    assert.deepEqual(harness.cancelRequests, ["job_first"]);
    assert.equal(harness.runs[0]?.options.signal.aborted, true);
    assert.equal(harness.submit.disabled, true);
    assert.equal(harness.cancel.hidden, false);
    assert.equal(harness.submit.focusCount, 0);

    harness.cancel.dispatch("click");
    harness.cancelled[1]?.resolve({ jobId: "job_current", status: "cancelled" });
    await settle();

    assert.deepEqual(harness.cancelRequests, ["job_first", "job_current"]);
    assert.equal(harness.runs[1]?.options.signal.aborted, true);
    assert.equal(harness.submit.disabled, false);
    assert.equal(harness.cancel.hidden, true);
    assert.equal(harness.submit.focusCount, 1);
  } finally {
    harness.restore();
  }
});

test("standalone known-job 404 restores submission with interrupted-or-expired status", async () => {
  const harness = createHarness();
  try {
    harness.input.value = "https://youtu.be/dQw4w9WgXcQ";
    harness.form.dispatch("submit");
    await settle();
    harness.runs[0]?.options.onUpdate({ jobId: "job_missing", status: "queued" });
    harness.runs[0]?.reject(new ScoreJobNotFoundError("job_missing"));
    await settle();

    assert.equal(harness.submit.disabled, false);
    assert.equal(harness.cancel.hidden, true);
    assert.equal(harness.status.children[0]?.children[0]?.textContent, "작업 확인 필요");
  } finally {
    harness.restore();
  }
});

type TerminalScoreJob = Extract<ScoreJob, { readonly status: "succeeded" | "failed" | "cancelled" }>;

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
};

type RunRecord = {
  readonly options: RunScoreJobOptions;
  readonly resolve: (value: TerminalScoreJob) => void;
  readonly reject: (reason: unknown) => void;
};

type Harness = {
  readonly app: FakeDiv;
  readonly form: FakeForm;
  readonly input: FakeInput;
  readonly status: FakeDiv;
  readonly submit: FakeButton;
  readonly cancel: FakeButton;
  readonly runs: RunRecord[];
  readonly cancelled: Deferred<Extract<ScoreJob, { readonly status: "cancelled" }>>[];
  readonly cancelRequests: string[];
  readonly restore: () => void;
};

function createHarness(): Harness {
  const app = new FakeDiv();
  const form = new FakeForm();
  const input = new FakeInput();
  const submit = new FakeButton();
  const cancel = new FakeButton();
  const inputError = new FakeParagraph();
  const status = new FakeDiv();
  const fakeDocument = new FakeDocument(app);
  app.nodes.set(".link-form", form);
  app.nodes.set("#youtube-url", input);
  app.nodes.set(".link-form button[type=submit]", submit);
  app.nodes.set("#cancel-job", cancel);
  app.nodes.set("#url-error", inputError);
  app.nodes.set("#job-status", status);

  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const constructors = [
    ["HTMLDivElement", FakeDiv],
    ["HTMLFormElement", FakeForm],
    ["HTMLInputElement", FakeInput],
    ["HTMLButtonElement", FakeButton],
    ["HTMLParagraphElement", FakeParagraph]
  ] as const;
  const constructorDescriptors = constructors.map(([name]) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  for (const [name, constructor] of constructors) {
    Object.defineProperty(globalThis, name, { configurable: true, value: constructor });
  }

  const runs: RunRecord[] = [];
  const cancelled: Deferred<Extract<ScoreJob, { readonly status: "cancelled" }>>[] = [];
  const cancelRequests: string[] = [];
  initializeWebApp(document, {
    runScoreJob: (options) => {
      const deferred = createDeferred<TerminalScoreJob>();
      runs.push({ options, resolve: deferred.resolve, reject: deferred.reject });
      return deferred.promise;
    },
    cancelScoreJob: (jobId) => {
      const deferred = createDeferred<Extract<ScoreJob, { readonly status: "cancelled" }>>();
      cancelRequests.push(jobId);
      cancelled.push(deferred);
      return deferred.promise;
    }
  });

  return {
    app,
    form,
    input,
    status,
    submit,
    cancel,
    runs,
    cancelled,
    cancelRequests,
    restore: () => {
      restoreProperty("document", documentDescriptor);
      for (const [name, descriptor] of constructorDescriptors) {
        restoreProperty(name, descriptor);
      }
    }
  };
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (!resolve || !reject) {
    throw new Error("Deferred callbacks were not initialized.");
  }
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function restoreProperty(key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, key);
}

class FakeDocument {
  constructor(private readonly app: FakeDiv) {}

  querySelector(selector: string): FakeElement | null {
    return selector === "#app" ? this.app : null;
  }

  createElement(tag: string): FakeElement {
    return tag === "button" ? new FakeButton() : new FakeElement();
  }
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  readonly nodes = new Map<string, FakeElement>();
  readonly style = { transform: "" };
  className = "";
  disabled = false;
  focusCount = 0;
  hidden = false;
  href = "";
  rel = "";
  markup = "";
  textContent = "";
  value = "";

  set innerHTML(markup: string) {
    this.markup = markup;
  }

  get innerHTML(): string {
    return this.markup;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }

  focus(): void {
    this.focusCount += 1;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.nodes.get(selector) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.length = 0;
    this.children.push(...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeDiv extends FakeElement {}
class FakeForm extends FakeElement {}
class FakeInput extends FakeElement {}
class FakeButton extends FakeElement {}
class FakeParagraph extends FakeElement {}
