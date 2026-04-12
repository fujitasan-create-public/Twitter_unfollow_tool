export type Phase =
  | "idle"
  | "scanning"
  | "ready"
  | "running"
  | "stopping"
  | "done"
  | "error";

export type RuntimeState = {
  phase: Phase;
  message: string;
  limit: number;
  accountHandle: string | null;
  candidateCount: number;
  targetCount: number;
  followingCount: number;
  followerCount: number;
  processed: number;
  succeeded: number;
  failed: number;
  stopRequested: boolean;
  startedAt: number | null;
  finishedAt: number | null;
};

export type ScanResult = {
  handle: string;
  candidates: string[];
};

export type CollectResult = {
  handles: string[];
};
