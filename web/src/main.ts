import type { ScoreJob } from "./job-contract";
import { parseScoreJobInput } from "./job-contract";
import type { RunScoreJobOptions, TerminalScoreJob } from "./job-client";
import { cancelScoreJob, runScoreJob, ScoreJobNotFoundError } from "./job-client";

class WebAppBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAppBootstrapError";
  }
}

export type WebAppDependencies = {
  readonly runScoreJob: (options: RunScoreJobOptions) => Promise<TerminalScoreJob>;
  readonly cancelScoreJob: (jobId: string) => Promise<Extract<ScoreJob, { readonly status: "cancelled" }>>;
};

type ActiveRun = {
  readonly controller: AbortController;
  jobId: string | null;
};

const defaultDependencies = { cancelScoreJob, runScoreJob } satisfies WebAppDependencies;

export function initializeWebApp(rootDocument: Document, dependencies: WebAppDependencies = defaultDependencies): void {
  const app = requireElement(rootDocument, "#app", HTMLDivElement);

  app.innerHTML = `
    <a class="skip-link" href="#main-content">본문으로 바로가기</a>
    <header class="site-header">
      <a class="wordmark" href="./" aria-label="yt2sheet 홈">
        <span class="wordmark__mark" aria-hidden="true">y2s</span>
        <span>yt2sheet</span>
      </a>
      <span class="site-header__descriptor">Link to score</span>
    </header>
    <main id="main-content" class="workspace">
      <section class="intro" aria-labelledby="page-title">
        <p class="eyebrow"><span aria-hidden="true"></span>YouTube to score</p>
        <h1 id="page-title"><span>유튜브 링크를</span><span>악보로 바꿔보세요.</span></h1>
        <p class="intro__lead">영상 링크로 악보를 만들어보세요.</p>
        <form class="link-form" novalidate>
          <label for="youtube-url">YouTube 링크</label>
          <div class="link-form__row">
            <input id="youtube-url" name="youtubeUrl" type="url" inputmode="url" autocomplete="url" spellcheck="false" placeholder="https://youtu.be/..." aria-describedby="url-help url-error" />
            <button type="submit">악보 만들기</button>
          </div>
          <button id="cancel-job" class="job-cancel" type="button" hidden>작업 취소</button>
          <p id="url-help" class="field-help">일반 영상, Shorts, youtu.be 링크를 사용할 <span class="field-help__phrase">수 있어요</span>.</p>
          <p id="url-error" class="field-error" role="alert" hidden></p>
        </form>
        <div class="trust-note">
          <span class="trust-note__index">01</span>
          <p><strong>서버에서 안전하게 처리합니다.</strong><span>완료된 결과만 보여드려요.</span></p>
        </div>
      </section>
      <section class="job-panel" aria-labelledby="job-panel-title">
        <div class="job-panel__header">
          <p id="job-panel-title">작업 현황</p>
          <span>Live</span>
        </div>
        <div class="notation-lines" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        <div id="job-status" class="job-status" role="status" aria-live="polite" aria-atomic="true"></div>
      </section>
    </main>
    <footer class="site-footer"><span>yt2sheet</span><span>영상은 결과 생성 목적으로만 처리됩니다.</span></footer>
  `;

  const form = requireElement(app, ".link-form", HTMLFormElement);
  const input = requireElement(app, "#youtube-url", HTMLInputElement);
  const submitButton = requireElement(app, ".link-form button[type=submit]", HTMLButtonElement);
  const cancelButton = requireElement(app, "#cancel-job", HTMLButtonElement);
  const inputError = requireElement(app, "#url-error", HTMLParagraphElement);
  const statusRoot = requireElement(app, "#job-status", HTMLDivElement);

  let activeRun: ActiveRun | null = null;

  renderIdle();

  input.addEventListener("input", clearInputError);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitScoreJob();
  });
  cancelButton.addEventListener("click", () => {
    void cancelActiveScoreJob();
  });

  async function submitScoreJob(): Promise<void> {
    const parsedInput = parseScoreJobInput(input.value);
    if (!parsedInput.ok) {
      showInputError(parsedInput.message);
      return;
    }

    clearInputError();
    activeRun?.controller.abort();
    const run: ActiveRun = { controller: new AbortController(), jobId: null };
    activeRun = run;
    setSubmitting(true);
    setCancellationAvailable(false);
    renderMessage({ tag: "링크 확인 완료", title: "작업을 접수하고 있어요", body: "영상을 확인한 뒤 처리 순서를 안내할게요.", tone: "working" });

    try {
      const terminalJob = await dependencies.runScoreJob({
        input: parsedInput.value,
        onUpdate: (job) => renderActiveJob(run, job),
        signal: run.controller.signal
      });
      if (!isActiveRun(run)) return;
      renderJob(terminalJob);
      finishRun(run, terminalJob.status === "failed" ? "다시 시도" : "다른 링크로 만들기");
    } catch (error) {
      if (!isActiveRun(run)) return;
      if (error instanceof ScoreJobNotFoundError) {
        finishRun(run, "다시 시도");
        renderInterrupted();
        return;
      }
      if (isAbortError(error)) {
        finishRun(run, "다시 시도");
        renderCancelled();
        return;
      }
      finishRun(run, "다시 시도");
      renderMessage({ tag: "연결 실패", title: "서버에 연결하지 못했어요", body: "잠시 후 다시 시도해주세요. 입력한 링크는 그대로 유지됩니다.", tone: "error" });
    } finally {
      if (!isActiveRun(run)) return;
    }
  }

  async function cancelActiveScoreJob(): Promise<void> {
    const run = activeRun;
    if (!run || !run.jobId) return;

    cancelButton.disabled = true;
    try {
      await dependencies.cancelScoreJob(run.jobId);
      if (!isActiveRun(run)) return;
      run.controller.abort();
      if (!finishRun(run, "다시 시도")) return;
      renderCancelled();
      submitButton.focus();
    } catch (error) {
      if (!isActiveRun(run)) return;
      run.controller.abort();
      if (!finishRun(run, "다시 시도")) return;
      if (error instanceof ScoreJobNotFoundError) {
        renderInterrupted();
      } else {
        renderMessage({ tag: "취소 실패", title: "작업 취소를 확인하지 못했어요", body: "다시 시도하거나 새 링크로 작업을 시작해주세요.", tone: "error" });
      }
      submitButton.focus();
    } finally {
      if (!isActiveRun(run)) return;
      cancelButton.disabled = false;
    }
  }

  function renderActiveJob(run: ActiveRun, job: ScoreJob): void {
    if (!isActiveRun(run)) return;
    run.jobId = job.jobId;
    renderJob(job);
    switch (job.status) {
      case "queued":
      case "running":
        setCancellationAvailable(true);
        return;
      case "succeeded":
      case "failed":
      case "cancelled":
        setCancellationAvailable(false);
        return;
      default:
        return assertNever(job);
    }
  }

  function renderJob(job: ScoreJob): void {
    switch (job.status) {
      case "queued":
        renderMessage({ tag: "대기 중", title: "처리 순서를 기다리고 있어요", body: "작업이 시작되면 진행 상황을 바로 알려드릴게요.", tone: "working", progress: job.progress });
        return;
      case "running":
        renderMessage({ tag: "처리 중", title: "악보 장면을 찾고 있어요", body: "악보 장면을 정리 중입니다.", tone: "working", progress: job.progress });
        return;
      case "succeeded":
        renderSuccess(job);
        return;
      case "failed":
        renderMessage({ tag: "작업 실패", title: "악보를 만들지 못했어요", body: job.error.message, tone: "error" });
        return;
      case "cancelled":
        renderCancelled();
        return;
      default:
        return assertNever(job);
    }
  }

  type StatusCopy = {
    readonly tag: string;
    readonly title: string;
    readonly body: string;
    readonly tone: "neutral" | "working" | "error";
    readonly progress?: number;
  };

  function renderIdle(): void {
    renderMessage({ tag: "준비됨", title: "링크 하나면 준비 끝", body: "링크를 붙여넣고 버튼을 눌러주세요.", tone: "neutral" });
  }

  function renderCancelled(): void {
    renderMessage({ tag: "작업 취소", title: "작업을 취소했어요", body: "다른 링크로 새 악보를 만들 수 있어요.", tone: "neutral" });
  }

  function renderInterrupted(): void {
    renderMessage({ tag: "작업 확인 필요", title: "작업이 중단되었거나 만료되었어요", body: "링크는 그대로 두고 다시 시도해주세요.", tone: "error" });
  }

  function renderMessage(copy: StatusCopy): void {
    const view = element("div", `job-status__content job-status__content--${copy.tone}`);
    view.append(element("p", "job-status__tag", copy.tag), element("h2", "job-status__title", copy.title), element("p", "job-status__body", copy.body));
    if (copy.progress !== undefined) {
      view.append(createProgress(copy.progress));
    }
    statusRoot.replaceChildren(view);
  }

  function renderSuccess(job: Extract<ScoreJob, { readonly status: "succeeded" }>): void {
    const view = element("div", "job-status__content job-status__content--success");
    view.append(element("p", "job-status__tag", "완료"), element("h2", "job-status__title", "악보가 준비됐어요"), element("p", "job-status__body", `${job.result.pageCount}페이지 · ${job.result.fileName}`));
    const download = element("a", "result-link", `${job.result.fileName} 받기`);
    download.href = job.result.downloadUrl;
    download.rel = "noopener";
    view.append(download);
    statusRoot.replaceChildren(view);
  }

  function createProgress(progress: number): HTMLDivElement {
    const wrapper = element("div", "progress");
    wrapper.setAttribute("role", "progressbar");
    wrapper.setAttribute("aria-label", "악보 생성 진행률");
    wrapper.setAttribute("aria-valuemin", "0");
    wrapper.setAttribute("aria-valuemax", "100");
    wrapper.setAttribute("aria-valuenow", String(progress));
    const bar = element("span", "progress__bar");
    bar.style.transform = `scaleX(${progress / 100})`;
    wrapper.append(bar, element("span", "progress__label", `${Math.round(progress)}%`));
    return wrapper;
  }

  function setSubmitting(submitting: boolean, label = "악보 만들기"): void {
    submitButton.disabled = submitting;
    submitButton.textContent = submitting ? "접수 중…" : label;
  }

  function setCancellationAvailable(available: boolean): void {
    cancelButton.disabled = !available;
    cancelButton.hidden = !available;
  }

  function finishRun(run: ActiveRun, label: string): boolean {
    if (!isActiveRun(run)) return false;
    activeRun = null;
    setSubmitting(false, label);
    setCancellationAvailable(false);
    return true;
  }

  function isActiveRun(run: ActiveRun): boolean {
    return activeRun === run;
  }

  function showInputError(message: string): void {
    inputError.textContent = message;
    inputError.hidden = false;
    input.setAttribute("aria-invalid", "true");
    input.focus();
  }

  function clearInputError(): void {
    inputError.hidden = true;
    inputError.textContent = "";
    input.removeAttribute("aria-invalid");
  }

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = rootDocument.createElement(tag);
    node.className = className;
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

type ElementConstructor<T extends Element> = {
  readonly prototype: T;
  new(): T;
};

function requireElement<T extends Element>(root: ParentNode, selector: string, constructor: ElementConstructor<T>): T {
  const node = root.querySelector(selector);
  if (!(node instanceof constructor)) {
    throw new WebAppBootstrapError(`Required element is missing: ${selector}`);
  }
  return node;
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected web state: ${String(value)}`);
}

if (typeof document !== "undefined") {
  initializeWebApp(document);
}
