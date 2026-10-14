export interface ClosePreview {
  code: string;
  endedAt: string | null;
  snapshotHash: string;
  pendingCount: number;
  activeCount: number;
  queuedCount: number;
  averageDurationSeconds: number | null;
}
