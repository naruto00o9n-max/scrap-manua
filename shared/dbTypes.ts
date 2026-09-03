export type User = {
  id: number;
  openId: string;
  name: string | null;
  email: string | null;
  loginMethod: string | null;
  role: "admin" | "user";
  createdAt: Date;
  updatedAt: Date;
  lastSignedIn: Date;
  passwordHash: string | null;
  isBlocked: boolean;
};

export type InsertUser = {
  openId: string;
  name?: string | null;
  email?: string | null;
  loginMethod?: string | null;
  role?: "admin" | "user";
  lastSignedIn?: Date;
  passwordHash?: string | null;
  isBlocked?: boolean;
};

export type ContentSource = {
  id: number;
  name: string;
  hostname: string;
  baseUrl: string;
  suwayomiSourceId: string | null;
  extensionPackage: string | null;
  extensionName: string | null;
  status: "active" | "disabled";
  documentedIntegrationUrl: string | null;
  allowDirectChapterLookup: boolean;
  rejectLoginRequired: boolean;
  rejectCaptchaRequired: boolean;
  notes: string | null;
  /** مصدر إضافة السجل: يدوي من اللوحة أو مزامنة تلقائية من Suwayomi. */
  origin?: "manual" | "suwayomi";
  /** لغة المصدر كما تُبلّغ عنها إضافة Suwayomi (ar/en/…) — لتجميع /مواقع. */
  lang?: string | null;
  /** أوقفه المالك يدويًا من إدارة المواقع — المزامنة لا تعيد تفعيله تلقائيًا. */
  ownerLocked?: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ChapterJob = {
  id: string;
  sourceId: number;
  urlHash: string;
  canonicalUrl: string;
  requestedByDiscordId: string;
  requestedByName: string;
  requestedInChannelId: string | null;
  discordProgressMessageId: string | null;
  sourceChapterId: string | null;
  mangaTitle: string | null;
  chapterTitle: string | null;
  status: "pending" | "downloading" | "uploading" | "completed" | "failed" | "cancelled";
  totalPages: number;
  uploadedPages: number;
  googleDriveFolderId: string | null;
  googleDriveUrl: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  cancelRequested: boolean;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
};
