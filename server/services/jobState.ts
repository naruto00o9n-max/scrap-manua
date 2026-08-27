export const managedJobStatuses = ["pending", "downloading", "uploading", "completed", "failed", "cancelled"] as const;
export type ManagedJobStatus = (typeof managedJobStatuses)[number];

const allowedTransitions: Record<ManagedJobStatus, readonly ManagedJobStatus[]> = {
  pending: ["downloading", "failed", "cancelled"],
  downloading: ["uploading", "failed", "cancelled"],
  uploading: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionJob(from: ManagedJobStatus, to: ManagedJobStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertJobTransition(from: ManagedJobStatus, to: ManagedJobStatus): void {
  if (!canTransitionJob(from, to)) {
    throw new Error(`انتقال حالة المهمة غير مسموح: ${from} → ${to}`);
  }
}
