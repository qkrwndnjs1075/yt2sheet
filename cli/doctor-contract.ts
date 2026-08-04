export type DoctorCheckStatus = "pass" | "warn" | "fail" | "skip";

export type DoctorCheck = {
  readonly key: string;
  readonly label: string;
  readonly status: DoctorCheckStatus;
  readonly message: string;
  readonly detail?: string;
};

export type DoctorStage = {
  readonly index: number;
  readonly total: number;
  readonly label: string;
};

export type DoctorResult = {
  readonly checks: readonly DoctorCheck[];
  readonly status: "ready" | "warning" | "failed";
  readonly exitCode: 0 | 1;
};
