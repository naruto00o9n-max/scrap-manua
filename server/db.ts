import { and, desc, eq, gte, inArray, isNotNull, like, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  appSettings,
  chapterJobs,
  contentSources,
  discordRoles,
  integrationAlerts,
  integrationHealth,
  jobAttempts,
  type ChapterJob,
  type ContentSource,
  type InsertUser,
  type User,
  users,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { isChapterRequestDuplicate } from "./services/jobDedupe";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("قاعدة بيانات المنصة غير متاحة حاليًا.");
  return db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: InsertUser = { openId: user.openId, lastSignedIn: user.lastSignedIn ?? new Date() };
  const updateSet: Record<string, unknown> = { lastSignedIn: values.lastSignedIn };
  for (const field of ["name", "email", "loginMethod"] as const) {
    if (user[field] !== undefined) {
      values[field] = user[field] ?? null;
      updateSet[field] = user[field] ?? null;
    }
  }
  values.role = user.role ?? (user.openId === ENV.ownerOpenId ? "admin" : "user");
  updateSet.role = values.role;

  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string): Promise<User | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export type SaveSourceInput = {
  id?: number;
  name: string;
  hostname: string;
  baseUrl: string;
  suwayomiSourceId?: string | null;
  extensionPackage?: string | null;
  extensionName?: string | null;
  status: "active" | "disabled";
  documentedIntegrationUrl?: string | null;
  allowDirectChapterLookup: boolean;
  notes?: string | null;
};

export async function listSources(): Promise<ContentSource[]> {
  const db = await requireDb();
  return db.select().from(contentSources).orderBy(desc(contentSources.updatedAt));
}

export async function getActiveSources(): Promise<ContentSource[]> {
  const db = await requireDb();
  return db.select().from(contentSources).where(eq(contentSources.status, "active"));
}

export async function getSourceById(id: number): Promise<ContentSource | undefined> {
  const db = await requireDb();
  const rows = await db.select().from(contentSources).where(eq(contentSources.id, id)).limit(1);
  return rows[0];
}

export async function saveSource(input: SaveSourceInput): Promise<ContentSource> {
  const db = await requireDb();
  const values = {
    name: input.name,
    hostname: input.hostname,
    baseUrl: input.baseUrl,
    suwayomiSourceId: input.suwayomiSourceId ?? null,
    extensionPackage: input.extensionPackage ?? null,
    extensionName: input.extensionName ?? null,
    status: input.status,
    documentedIntegrationUrl: input.documentedIntegrationUrl ?? null,
    allowDirectChapterLookup: input.allowDirectChapterLookup,
    notes: input.notes ?? null,
  } as const;

  if (input.id) {
    await db.update(contentSources).set(values).where(eq(contentSources.id, input.id));
    const updated = await db.select().from(contentSources).where(eq(contentSources.id, input.id)).limit(1);
    if (!updated[0]) throw new Error("تعذر العثور على المصدر المطلوب.");
    return updated[0];
  }

  const result = await db.insert(contentSources).values(values);
  const inserted = await db
    .select()
    .from(contentSources)
    .where(eq(contentSources.id, Number(result[0].insertId)))
    .limit(1);
  if (!inserted[0]) throw new Error("تعذر حفظ المصدر.");
  return inserted[0];
}

export async function getSetting(key: string): Promise<string | null> {
  const db = await requireDb();
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await requireDb();
  await db
    .insert(appSettings)
    .values({ key, value })
    .onDuplicateKeyUpdate({ set: { value, updatedAt: new Date() } });
}

export async function listDiscordRoles() {
  const db = await requireDb();
  return db.select().from(discordRoles).orderBy(desc(discordRoles.createdAt));
}

export async function listActiveDiscordRoleIds(): Promise<string[]> {
  const db = await requireDb();
  const rows = await db
    .select({ discordRoleId: discordRoles.discordRoleId })
    .from(discordRoles)
    .where(eq(discordRoles.isActive, true));
  return rows.map(row => row.discordRoleId);
}

export async function saveDiscordRole(discordRoleId: string, label: string) {
  const db = await requireDb();
  await db
    .insert(discordRoles)
    .values({ discordRoleId, label, isActive: true })
    .onDuplicateKeyUpdate({ set: { label, isActive: true } });
}

export async function removeDiscordRole(id: number): Promise<void> {
  const db = await requireDb();
  await db.delete(discordRoles).where(eq(discordRoles.id, id));
}

export type QueueChapterJobInput = {
  id: string;
  sourceId: number;
  urlHash: string;
  canonicalUrl: string;
  requestedByDiscordId: string;
  requestedByName: string;
  requestedInChannelId?: string;
};

type ChapterJobStore = {
  findByUrlHash: (urlHash: string) => Promise<ChapterJob | undefined>;
  insert: (input: QueueChapterJobInput) => Promise<void>;
  findById: (id: string) => Promise<ChapterJob | undefined>;
};

export async function resolveChapterJobCreation(
  store: ChapterJobStore,
  input: QueueChapterJobInput,
): Promise<{ job: ChapterJob; created: boolean }> {
  const existing = await store.findByUrlHash(input.urlHash);
  if (existing && isChapterRequestDuplicate(existing.urlHash, input.urlHash)) return { job: existing, created: false };

  try {
    await store.insert(input);
  } catch (error) {
    const conflicting = await store.findByUrlHash(input.urlHash);
    if (conflicting && isChapterRequestDuplicate(conflicting.urlHash, input.urlHash)) return { job: conflicting, created: false };
    throw error;
  }

  const created = await store.findById(input.id);
  if (!created) throw new Error("تعذر إنشاء مهمة الفصل.");
  return { job: created, created: true };
}

export async function createOrGetChapterJob(input: QueueChapterJobInput): Promise<{
  job: ChapterJob;
  created: boolean;
}> {
  const db = await requireDb();
  return resolveChapterJobCreation(
    {
      findByUrlHash: async urlHash => (await db.select().from(chapterJobs).where(eq(chapterJobs.urlHash, urlHash)).limit(1))[0],
      insert: async values => { await db.insert(chapterJobs).values({ ...values }); },
      findById: async id => (await db.select().from(chapterJobs).where(eq(chapterJobs.id, id)).limit(1))[0],
    },
    input,
  );
}

export async function getChapterJob(id: string): Promise<ChapterJob | undefined> {
  const db = await requireDb();
  const rows = await db.select().from(chapterJobs).where(eq(chapterJobs.id, id)).limit(1);
  return rows[0];
}

export async function cancelChapterJob(id: string): Promise<ChapterJob> {
  const db = await requireDb();
  const before = await getChapterJob(id);
  if (!before) throw new Error("لم تُعثر المهمة المطلوب إلغاؤها.");
  if (!["pending", "downloading", "uploading"].includes(before.status)) {
    throw new Error("لا يمكن إلغاء مهمة منتهية أو ملغاة سابقًا.");
  }
  await db
    .update(chapterJobs)
    .set({ cancelRequested: true, status: "cancelled", completedAt: new Date() })
    .where(and(eq(chapterJobs.id, id), inArray(chapterJobs.status, ["pending", "downloading", "uploading"])));
  const job = await getChapterJob(id);
  if (!job) throw new Error("تعذر تأكيد إلغاء المهمة.");
  return job;
}

export async function getNextPendingChapterJob(): Promise<ChapterJob | undefined> {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(chapterJobs)
    .where(eq(chapterJobs.status, "pending"))
    .orderBy(chapterJobs.createdAt)
    .limit(1);
  return rows[0];
}

export async function markJobStarted(id: string): Promise<void> {
  const db = await requireDb();
  await db
    .update(chapterJobs)
    .set({ status: "downloading", startedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(chapterJobs.id, id), eq(chapterJobs.status, "pending")));
}

export async function setJobChapterDetails(
  id: string,
  details: { sourceChapterId: string; mangaTitle: string; chapterTitle: string; totalPages: number },
): Promise<void> {
  const db = await requireDb();
  await db.update(chapterJobs).set({ ...details, updatedAt: new Date() }).where(eq(chapterJobs.id, id));
}

export async function markJobUploading(id: string, googleDriveFolderId: string, googleDriveUrl: string): Promise<void> {
  const db = await requireDb();
  await db
    .update(chapterJobs)
    .set({ status: "uploading", googleDriveFolderId, googleDriveUrl, updatedAt: new Date() })
    .where(eq(chapterJobs.id, id));
}

export async function updateJobUploadProgress(id: string, uploadedPages: number): Promise<void> {
  const db = await requireDb();
  await db.update(chapterJobs).set({ uploadedPages, updatedAt: new Date() }).where(eq(chapterJobs.id, id));
}

export async function markJobCompleted(id: string): Promise<void> {
  const db = await requireDb();
  await db.update(chapterJobs).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() }).where(eq(chapterJobs.id, id));
}

export async function markJobFailed(id: string, code: string, message: string): Promise<void> {
  const db = await requireDb();
  await db
    .update(chapterJobs)
    .set({ status: "failed", failureCode: code, failureMessage: message.slice(0, 4000), completedAt: new Date(), updatedAt: new Date() })
    .where(eq(chapterJobs.id, id));
}

export async function listChapterJobs(filters?: {
  search?: string;
  status?: ChapterJob["status"];
  sourceId?: number;
  from?: Date;
  to?: Date;
  pageCount?: number;
  withDrive?: boolean;
}) {
  const db = await requireDb();
  const conditions = [];
  if (filters?.status) conditions.push(eq(chapterJobs.status, filters.status));
  if (filters?.sourceId) conditions.push(eq(chapterJobs.sourceId, filters.sourceId));
  if (filters?.from) conditions.push(gte(chapterJobs.createdAt, filters.from));
  if (filters?.to) conditions.push(lte(chapterJobs.createdAt, filters.to));
  if (filters?.pageCount) conditions.push(eq(chapterJobs.totalPages, filters.pageCount));
  if (filters?.withDrive) conditions.push(isNotNull(chapterJobs.googleDriveUrl));
  if (filters?.search?.trim()) {
    const search = `%${filters.search.trim()}%`;
    conditions.push(or(like(chapterJobs.canonicalUrl, search), like(chapterJobs.requestedByName, search))!);
  }

  return db
    .select({ job: chapterJobs, sourceName: contentSources.name, sourceHostname: contentSources.hostname })
    .from(chapterJobs)
    .leftJoin(contentSources, eq(chapterJobs.sourceId, contentSources.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(chapterJobs.createdAt))
    .limit(200);
}

export async function addJobAttempt(jobId: string, phase: string, message: string): Promise<void> {
  const db = await requireDb();
  await db.insert(jobAttempts).values({ jobId, phase, message });
}

export async function listJobAttempts(jobId: string) {
  const db = await requireDb();
  return db.select().from(jobAttempts).where(eq(jobAttempts.jobId, jobId)).orderBy(desc(jobAttempts.createdAt));
}

export async function saveIntegrationHealth(
  service: string,
  status: "healthy" | "degraded" | "offline" | "unknown",
  message?: string,
): Promise<{ consecutiveFailures: number }> {
  const db = await requireDb();
  const existing = await db.select().from(integrationHealth).where(eq(integrationHealth.service, service)).limit(1);
  const failed = status === "healthy" ? 0 : (existing[0]?.consecutiveFailures ?? 0) + 1;
  await db
    .insert(integrationHealth)
    .values({ service, status, message: message ?? null, consecutiveFailures: failed, lastCheckedAt: new Date() })
    .onDuplicateKeyUpdate({
      set: { status, message: message ?? null, consecutiveFailures: failed, lastCheckedAt: new Date(), updatedAt: new Date() },
    });
  return { consecutiveFailures: failed };
}

export async function listIntegrationHealth() {
  const db = await requireDb();
  return db.select().from(integrationHealth).orderBy(integrationHealth.service);
}

export async function createIntegrationAlert(input: {
  service: string;
  severity: "warning" | "critical";
  fingerprint: string;
  message: string;
  recipientDiscordUserId?: string;
}): Promise<{ id: number; reused: boolean }> {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(integrationAlerts)
    .where(and(eq(integrationAlerts.service, input.service), eq(integrationAlerts.fingerprint, input.fingerprint)))
    .orderBy(desc(integrationAlerts.createdAt))
    .limit(1);
  const existing = rows[0];
  if (existing && Date.now() - existing.createdAt.getTime() < 30 * 60 * 1000) {
    return { id: existing.id, reused: true };
  }
  const result = await db.insert(integrationAlerts).values({
    service: input.service,
    severity: input.severity,
    fingerprint: input.fingerprint,
    message: input.message.slice(0, 4000),
    recipientDiscordUserId: input.recipientDiscordUserId ?? null,
  });
  return { id: Number(result[0].insertId), reused: false };
}

export async function markIntegrationAlertDelivered(id: number, deliveryStatus: "sent" | "failed"): Promise<void> {
  const db = await requireDb();
  await db.update(integrationAlerts).set({ deliveryStatus, deliveredAt: new Date() }).where(eq(integrationAlerts.id, id));
}

export async function listIntegrationAlerts() {
  const db = await requireDb();
  return db.select().from(integrationAlerts).orderBy(desc(integrationAlerts.createdAt)).limit(50);
}

export async function getDashboardSummary() {
  const db = await requireDb();
  const counts = await db
    .select({ status: chapterJobs.status, count: sql<number>`count(*)` })
    .from(chapterJobs)
    .groupBy(chapterJobs.status);
  const recentJobs = await listChapterJobs();
  const recentAlerts = await listIntegrationAlerts();
  const sourceCount = await db.select({ count: sql<number>`count(*)` }).from(contentSources);
  const activeSourceCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(contentSources)
    .where(eq(contentSources.status, "active"));

  return {
    counts: Object.fromEntries(counts.map(item => [item.status, Number(item.count)])),
    sourceCount: Number(sourceCount[0]?.count ?? 0),
    activeSourceCount: Number(activeSourceCount[0]?.count ?? 0),
    recentJobs: recentJobs.slice(0, 8),
    recentAlerts: recentAlerts.slice(0, 5),
  };
}
