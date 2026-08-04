import assert from "node:assert/strict";
import test from "node:test";
import type { MediaTools } from "../pipeline/media-tools";
import {
  formatDoctorReport,
  runDoctor,
  type DoctorCheck,
  type DoctorDependencies,
  type DoctorResult,
  type DoctorTooling
} from "../cli/doctor";

test("formats a stable human-readable doctor report", () => {
  const result: DoctorResult = {
    status: "warning",
    exitCode: 0,
    checks: [
      { key: "system", label: "실행 환경", status: "pass", message: "macos arm64, Node v22" },
      { key: "cookies", label: "쿠키 설정", status: "warn", message: "선택 사항이며 설정되지 않았습니다." },
      { key: "network", label: "릴리스 네트워크", status: "skip", message: "--offline으로 건너뛰었습니다." }
    ]
  };

  assert.equal(formatDoctorReport(result), [
    "yt2 doctor",
    "",
    "✓ 실행 환경: macos arm64, Node v22",
    "! 쿠키 설정: 선택 사항이며 설정되지 않았습니다.",
    "- 릴리스 네트워크: --offline으로 건너뛰었습니다.",
    "",
    "결과: READY WITH WARNINGS"
  ].join("\n") + "\n");
});

test("offline doctor does not invoke its network probe", async () => {
  const tools: MediaTools = {
    ytDlp: process.execPath,
    ffmpeg: process.execPath,
    ffprobe: process.execPath,
    ytDlpJsRuntime: process.execPath
  };
  const pass = (key: string, label: string, message: string): DoctorCheck => ({
    key,
    label,
    status: "pass",
    message
  });
  const tooling: DoctorTooling = {
    tools,
    checks: [pass("tools", "미디어 도구", "테스트 도구 준비됨")],
    canRunLocalSmoke: true,
    canCheckSource: true
  };
  let networkCalls = 0;
  let smokeCalls = 0;
  const dependencies: DoctorDependencies = {
    inspectTools: async () => tooling,
    runLocalSmoke: async () => {
      smokeCalls += 1;
      return pass("smoke", "로컬 스모크", "통과");
    },
    probeRelease: async () => {
      networkCalls += 1;
      return pass("network", "릴리스 네트워크", "통과");
    }
  };

  const result = await runDoctor({ cwd: process.cwd(), offline: true }, dependencies);

  assert.equal(networkCalls, 0);
  assert.equal(smokeCalls, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.checks.find((check) => check.key === "network")?.status, "skip");
});
