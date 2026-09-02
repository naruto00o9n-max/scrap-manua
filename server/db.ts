import { MongoClient, type Collection, type Db, type Filter } from "mongodb";
import {
  type ChapterJob,
  type ContentSource,
  type InsertUser,
  type User,
} from "../shared/dbTypes";
import { ENV } from "./_core/env";
import { hashPassword } from "./_core/auth";
import { isChapterRequestDuplicate } from "./services/jobDedupe";

type MongoDocument<T> = T & { _id?: unknown };
type DiscordRole = { id: number; discordRoleId: string; label: string; isActive: boolean; createdAt: Date };
type AppSetting = { key: string; value: string; updatedAt: Date };
type JobAttempt = { id: number; jobId: string; phase: string; message: string; createdAt: Date };
type IntegrationHealth = {
  id: number;
  service: string;
  status: "healthy" | "degraded" | "offline" | "unknown";
  message: string | null;
  consecutiveFailures: number;
  lastCheckedAt: Date;
  updatedAt: Date;
};
type IntegrationAlert = {
  id: number;
  service: string;
  severity: "warning" | "critical";
  fingerprint: string;
  message: string;
  recipientDiscordUserId: string | null;
  deliveryStatus: "pending" | "sent" | "failed";
  createdAt: Date;
  deliveredAt: Date | null;
};
type Counter = { _id: string; seq: number };

type Collections = {
  users: Collection<MongoDocument<User>>;
  contentSources: Collection<MongoDocument<ContentSource>>;
  appSettings: Collection<MongoDocument<AppSetting>>;
  discordRoles: Collection<MongoDocument<DiscordRole>>;
  chapterJobs: Collection<MongoDocument<ChapterJob>>;
  jobAttempts: Collection<MongoDocument<JobAttempt>>;
  integrationHealth: Collection<MongoDocument<IntegrationHealth>>;
  integrationAlerts: Collection<MongoDocument<IntegrationAlert>>;
  counters: Collection<Counter>;
};

let clientPromise: Promise<MongoClient> | null = null;
let indexesReady = false;

function stripMongoId<T extends { _id?: unknown }>(doc: T): Omit<T, "_id"> {
  const { _id, ...rest } = doc;
  return rest;
}

function now() {
  return new Date();
}

async function getMongoClient(): Promise<MongoClient | null> {
  if (!ENV.mongodbUri) return null;
  clientPromise ??= new MongoClient(ENV.mongodbUri).connect();
  try {
    return await clientPromise;
  } catch (error) {
    clientPromise = null;
    console.warn("[Database] Failed to connect to MongoDB:", error);
    return null;
  }
}

export async function getDb(): Promise<Db | null> {
  const client = await getMongoClient();
  if (!client) return null;
  const db = client.db();
  if (!indexesReady) {
    await ensureIndexes(db);
    indexesReady = true;
  }
  return db;
}

async function requireDb(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new Error("قاعدة بيانات MongoDB غير متاحة حاليًا. اضبط MONGODB_URI في الأسرار.");
  return db;
}

function collections(db: Db): Collections {
  return {
    users: db.collection("users"),
    contentSources: db.collection("contentSources"),
    appSettings: db.collection("appSettings"),
    discordRoles: db.collection("discordRoles"),
    chapterJobs: db.collection("chapterJobs"),
    jobAttempts: db.collection("jobAttempts"),
    integrationHealth: db.collection("integrationHealth"),
    integrationAlerts: db.collection("integrationAlerts"),
    counters: db.collection<Counter>("counters"),
  };
}

async function ensureIndexes(db: Db): Promise<void> {
  const c = collections(db);
  await Promise.all([
    c.users.createIndex({ openId: 1 }, { unique: true }),
    c.users.createIndex({ email: 1 }, { unique: true, sparse: true }),
    c.contentSources.createIndex({ hostname: 1 }, { unique: true }),
    c.discordRoles.createIndex({ discordRoleId: 1 }, { unique: true }),
    c.chapterJobs.createIndex({ urlHash: 1 }, { unique: true }),
    c.chapterJobs.createIndex({ status: 1, createdAt: 1 }),
    c.chapterJobs.createIndex({ requestedByDiscordId: 1 }),
    c.chapterJobs.createIndex({ sourceId: 1 }),
    c.jobAttempts.createIndex({ jobId: 1, createdAt: -1 }),
    c.integrationHealth.createIndex({ service: 1 }, { unique: true }),
    c.integrationAlerts.createIndex({ service: 1, createdAt: -1 }),
    c.integrationAlerts.createIndex({ service: 1, fingerprint: 1, createdAt: -1 }),
  ]);
}

async function nextSequence(name: string): Promise<number> {
  const db = await requireDb();
  const result = await collections(db).counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  if (!result) throw new Error(`تعذر إنشاء معرف متسلسل لـ ${name}.`);
  return result.seq;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;
  const timestamp = now();
  const update: Partial<User> = {
    lastSignedIn: user.lastSignedIn ?? timestamp,
    updatedAt: timestamp,
    // Only overwrite the role when explicitly provided; otherwise every
    // authenticated request (which upserts with no role) would demote admins.
    ...(user.role !== undefined ? { role: user.role } : {}),
    ...(user.passwordHash !== undefined ? { passwordHash: user.passwordHash } : {}),
    ...(user.isBlocked !== undefined ? { isBlocked: user.isBlocked } : {}),
  };
  for (const field of ["name", "email", "loginMethod"] as const) {
    if (user[field] !== undefined) update[field] = user[field] ?? null;
  }
  await collections(db).users.updateOne(
    { openId: user.openId },
    { $setOnInsert: { id: await nextSequence("users"), openId: user.openId, createdAt: timestamp, role: user.role ?? "user", passwordHash: user.passwordHash ?? null, isBlocked: user.isBlocked ?? false }, $set: update },
    { upsert: true },
  );
}

export async function getUserByOpenId(openId: string): Promise<User | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const row = await collections(db).users.findOne({ openId });
  return row ? stripMongoId(row) as User : undefined;
}


export async function ensureDefaultAdminUser(): Promise<void> {
  const db = await requireDb();
  const c = collections(db).users;
  const existingAdmin = await c.findOne({ role: "admin", passwordHash: { $ne: null } });
  if (existingAdmin) return;
  const timestamp = now();
  const email = ENV.adminEmail.toLowerCase();
  await c.updateOne(
    { email },
    {
      $setOnInsert: {
        id: await nextSequence("users"),
        openId: `local:${email}`,
        email,
        name: "Admin",
        loginMethod: "email",
        role: "admin",
        createdAt: timestamp,
        passwordHash: await hashPassword(ENV.adminPassword),
        isBlocked: false,
      },
      $set: { updatedAt: timestamp, lastSignedIn: timestamp },
    },
    { upsert: true },
  );
}

export async function getUserByEmail(email: string): Promise<User | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const row = await collections(db).users.findOne({ email: email.toLowerCase() });
  return row ? stripMongoId(row) as User : undefined;
}

export async function listUsers(): Promise<User[]> {
  const db = await requireDb();
  return (await collections(db).users.find().sort({ lastSignedIn: -1 }).limit(500).toArray()).map(row => stripMongoId(row) as User);
}

export async function setUserBlocked(id: number, isBlocked: boolean): Promise<void> {
  const db = await requireDb();
  await collections(db).users.updateOne({ id }, { $set: { isBlocked, updatedAt: now() } });
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
  /** مصدر إضافة السجل: يدوي من اللوحة أو مزامنة تلقائية من Suwayomi. */
  origin?: "manual" | "suwayomi" | null;
  /** لغة المصدر من إضافة Suwayomi — تُستخدم لتجميع /مواقع حسب اللغة. */
  lang?: string | null;
};

function normalizeSource(input: SaveSourceInput, existing?: ContentSource): ContentSource {
  const timestamp = now();
  return {
    id: existing?.id ?? input.id ?? 0,
    name: input.name,
    hostname: input.hostname,
    baseUrl: input.baseUrl,
    suwayomiSourceId: input.suwayomiSourceId ?? null,
    extensionPackage: input.extensionPackage ?? null,
    extensionName: input.extensionName ?? null,
    status: input.status,
    documentedIntegrationUrl: input.documentedIntegrationUrl ?? null,
    allowDirectChapterLookup: input.allowDirectChapterLookup,
    rejectLoginRequired: existing?.rejectLoginRequired ?? true,
    rejectCaptchaRequired: existing?.rejectCaptchaRequired ?? true,
    notes: input.notes ?? null,
    origin: input.origin ?? existing?.origin ?? "manual",
    lang: input.lang ?? existing?.lang ?? null,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

export async function listSources(): Promise<ContentSource[]> {
  const db = await requireDb();
  return (await collections(db).contentSources.find().sort({ updatedAt: -1 }).toArray()).map(row => stripMongoId(row) as ContentSource);
}

export async function getActiveSources(): Promise<ContentSource[]> {
  const db = await requireDb();
  return (await collections(db).contentSources.find({ status: "active" }).toArray()).map(row => stripMongoId(row) as ContentSource);
}

export async function getSourceById(id: number): Promise<ContentSource | undefined> {
  const db = await requireDb();
  const row = await collections(db).contentSources.findOne({ id });
  return row ? stripMongoId(row) as ContentSource : undefined;
}

export async function getSourceBySuwayomiId(suwayomiSourceId: string): Promise<ContentSource | undefined> {
  const db = await requireDb();
  const row = await collections(db).contentSources.findOne({ suwayomiSourceId });
  return row ? stripMongoId(row) as ContentSource : undefined;
}

export async function saveSource(input: SaveSourceInput): Promise<ContentSource> {
  const db = await requireDb();
  const c = collections(db).contentSources;
  const existing = input.id ? await c.findOne({ id: input.id }) : null;
  const source = normalizeSource({ ...input, id: input.id ?? await nextSequence("contentSources") }, existing ? stripMongoId(existing) as ContentSource : undefined);
  await c.updateOne({ id: source.id }, { $set: source }, { upsert: true });
  return source;
}

export async function getSetting(key: string): Promise<string | null> {
  const db = await requireDb();
  return (await collections(db).appSettings.findOne({ key }))?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await requireDb();
  await collections(db).appSettings.updateOne({ key }, { $set: { key, value, updatedAt: now() } }, { upsert: true });
}

export async function listDiscordRoles() {
  const db = await requireDb();
  return (await collections(db).discordRoles.find().sort({ createdAt: -1 }).toArray()).map(stripMongoId);
}

export async function listActiveDiscordRoleIds(): Promise<string[]> {
  const db = await requireDb();
  return (await collections(db).discordRoles.find({ isActive: true }).project<{ discordRoleId: string }>({ discordRoleId: 1 }).toArray()).map(row => row.discordRoleId);
}

export async function saveDiscordRole(discordRoleId: string, label: string) {
  const db = await requireDb();
  const timestamp = now();
  await collections(db).discordRoles.updateOne(
    { discordRoleId },
    { $setOnInsert: { id: await nextSequence("discordRoles"), createdAt: timestamp }, $set: { discordRoleId, label, isActive: true } },
    { upsert: true },
  );
}

export async function removeDiscordRole(id: number): Promise<void> {
  const db = await requireDb();
  await collections(db).discordRoles.deleteOne({ id });
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
  requeue: (id: string, input: QueueChapterJobInput) => Promise<ChapterJob>;
};

const ACTIVE_JOB_STATUSES: ChapterJob["status"][] = ["pending", "downloading", "uploading"];

/**
 * منع التكرار يحمي فقط من تشغيل نفس الفصل مرتين **أثناء العمل**.
 * الطلبات الفاشلة أو الملغاة أو المكتملة سابقًا تُعاد تهيئتها وتُعالج من جديد
 * فورًا، بدل الرد ببطاقة قديمة كأن الفصل "جاهز" وهو في الحقيقة فاشل.
 */
export async function resolveChapterJobCreation(
  store: ChapterJobStore,
  input: QueueChapterJobInput,
): Promise<{ job: ChapterJob; created: boolean }> {
  const reuseExisting = async (existing: ChapterJob): Promise<{ job: ChapterJob; created: boolean }> => {
    if (ACTIVE_JOB_STATUSES.includes(existing.status)) return { job: existing, created: false };
    return { job: await store.requeue(existing.id, input), created: true };
  };

  const existing = await store.findByUrlHash(input.urlHash);
  if (existing && isChapterRequestDuplicate(existing.urlHash, input.urlHash)) {
    return reuseExisting(existing);
  }

  try {
    await store.insert(input);
  } catch (error) {
    const conflicting = await store.findByUrlHash(input.urlHash);
    if (conflicting && isChapterRequestDuplicate(conflicting.urlHash, input.urlHash)) return reuseExisting(conflicting);
    throw error;
  }

  const created = await store.findById(input.id);
  if (!created) throw new Error("تعذر إنشاء مهمة الفصل.");
  return { job: created, created: true };
}

function newChapterJob(input: QueueChapterJobInput): ChapterJob {
  const timestamp = now();
  return {
    id: input.id,
    sourceId: input.sourceId,
    urlHash: input.urlHash,
    canonicalUrl: input.canonicalUrl,
    requestedByDiscordId: input.requestedByDiscordId,
    requestedByName: input.requestedByName,
    requestedInChannelId: input.requestedInChannelId ?? null,
    discordProgressMessageId: null,
    sourceChapterId: null,
    mangaTitle: null,
    chapterTitle: null,
    status: "pending",
    totalPages: 0,
    uploadedPages: 0,
    googleDriveFolderId: null,
    googleDriveUrl: null,
    failureCode: null,
    failureMessage: null,
    cancelRequested: false,
    createdAt: timestamp,
    startedAt: null,
    completedAt: null,
    updatedAt: timestamp,
  };
}

export async function createOrGetChapterJob(input: QueueChapterJobInput): Promise<{ job: ChapterJob; created: boolean }> {
  const db = await requireDb();
  const c = collections(db).chapterJobs;
  const toJob = (row: MongoDocument<ChapterJob> | null) => row ? stripMongoId(row) as ChapterJob : undefined;
  return resolveChapterJobCreation({
    findByUrlHash: async urlHash => toJob(await c.findOne({ urlHash })),
    insert: async values => { await c.insertOne(newChapterJob(values)); },
    findById: async id => toJob(await c.findOne({ id })),
    requeue: async (id, values) => {
      // إعادة تهيئة كاملة للسجل مع تحويل الطلب إلى صاحب الطلب الجديد،
      // لتبدأ معالجة فعلية جديدة بدل الرد بنتيجة قديمة.
      const timestamp = now();
      await c.updateOne({ id }, { $set: {
        status: "pending",
        cancelRequested: false,
        totalPages: 0,
        uploadedPages: 0,
        sourceChapterId: null,
        mangaTitle: null,
        chapterTitle: null,
        googleDriveFolderId: null,
        googleDriveUrl: null,
        failureCode: null,
        failureMessage: null,
        startedAt: null,
        completedAt: null,
        requestedByDiscordId: values.requestedByDiscordId,
        requestedByName: values.requestedByName,
        requestedInChannelId: values.requestedInChannelId ?? null,
        canonicalUrl: values.canonicalUrl,
        createdAt: timestamp,
        updatedAt: timestamp,
      } });
      const job = toJob(await c.findOne({ id }));
      if (!job) throw new Error("تعذر إعادة محاولة مهمة الفصل.");
      return job;
    },
  }, input);
}

export async function getChapterJob(id: string): Promise<ChapterJob | undefined> {
  const db = await requireDb();
  const row = await collections(db).chapterJobs.findOne({ id });
  return row ? stripMongoId(row) as ChapterJob : undefined;
}

export async function setDiscordProgressMessage(id: string, messageId: string): Promise<void> {
  const db = await requireDb();
  await collections(db).chapterJobs.updateOne({ id }, { $set: { discordProgressMessageId: messageId, updatedAt: now() } });
}

export async function cancelChapterJob(id: string): Promise<ChapterJob> {
  const db = await requireDb();
  const before = await getChapterJob(id);
  if (!before) throw new Error("لم تُعثر المهمة المطلوب إلغاؤها.");
  if (!["pending", "downloading", "uploading"].includes(before.status)) throw new Error("لا يمكن إلغاء مهمة منتهية أو ملغاة سابقًا.");
  await collections(db).chapterJobs.updateOne({ id, status: { $in: ["pending", "downloading", "uploading"] } }, { $set: { cancelRequested: true, status: "cancelled", completedAt: now(), updatedAt: now() } });
  const job = await getChapterJob(id);
  if (!job) throw new Error("تعذر تأكيد إلغاء المهمة.");
  return job;
}

export async function getNextPendingChapterJob(): Promise<ChapterJob | undefined> {
  const db = await requireDb();
  const row = await collections(db).chapterJobs.findOne({ status: "pending" }, { sort: { createdAt: 1 } });
  return row ? stripMongoId(row) as ChapterJob : undefined;
}

/**
 * يُعيد الطلبات التي كانت قيد المعالجة (downloading/uploading) وتوقفت تحديثاتها
 * لمدة أطول من الحد المحدد، مثلما يحدث عند قتل العملية بسبب نفاد الذاكرة أو
 * إعادة تشغيل الخدمة. بدون هذه المعالجة يبقى الطلب معلقًا للأبد بصمت.
 */
export async function getStaleInFlightChapterJobs(thresholdMs: number = 15 * 60 * 1000): Promise<ChapterJob[]> {
  const db = await requireDb();
  const cutoff = new Date(Date.now() - thresholdMs);
  const rows = await collections(db).chapterJobs
    .find({ status: { $in: ["downloading", "uploading"] as ChapterJob["status"][] }, updatedAt: { $lt: cutoff } })
    .sort({ updatedAt: 1 })
    .toArray();
  return rows.map(row => stripMongoId(row) as ChapterJob);
}

export async function markJobStarted(id: string): Promise<void> {
  const db = await requireDb();
  await collections(db).chapterJobs.updateOne({ id, status: "pending" }, { $set: { status: "downloading", startedAt: now(), updatedAt: now() } });
}

export async function setJobChapterDetails(id: string, details: { sourceChapterId: string; mangaTitle: string; chapterTitle: string; totalPages: number }): Promise<void> {
  const db = await requireDb();
  await collections(db).chapterJobs.updateOne({ id }, { $set: { ...details, updatedAt: now() } });
}

export async function markJobUploading(id: string, googleDriveFolderId: string, googleDriveUrl: string): Promise<void> {
  const db = await requireDb();
  await collections(db).chapterJobs.updateOne({ id }, { $set: { status: "uploading", googleDriveFolderId, googleDriveUrl, updatedAt: now() } });
}

export async function updateJobUploadProgress(id: string, uploadedPages: number): Promise<void> {
  const db = await requireDb();
  await collections(db).chapterJobs.updateOne({ id }, { $set: { uploadedPages, updatedAt: now() } });
}

export async function markJobCompleted(id: string): Promise<void> {
  const db = await requireDb();
  await collections(db).chapterJobs.updateOne({ id }, { $set: { status: "completed", completedAt: now(), updatedAt: now() } });
}

export async function markJobFailed(id: string, code: string, message: string): Promise<void> {
  const db = await requireDb();
  await collections(db).chapterJobs.updateOne({ id }, { $set: { status: "failed", failureCode: code, failureMessage: message.slice(0, 4000), completedAt: now(), updatedAt: now() } });
}

export async function listChapterJobs(filters?: { search?: string; status?: ChapterJob["status"]; sourceId?: number; from?: Date; to?: Date; pageCount?: number; withDrive?: boolean }) {
  const db = await requireDb();
  const c = collections(db);
  const query: Filter<ChapterJob> = {};
  if (filters?.status) query.status = filters.status;
  if (filters?.sourceId) query.sourceId = filters.sourceId;
  if (filters?.from || filters?.to) query.createdAt = { ...(filters.from ? { $gte: filters.from } : {}), ...(filters.to ? { $lte: filters.to } : {}) };
  if (filters?.pageCount) query.totalPages = filters.pageCount;
  if (filters?.withDrive) query.googleDriveUrl = { $ne: null } as never;
  if (filters?.search?.trim()) {
    const regex = new RegExp(filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [{ canonicalUrl: regex }, { requestedByName: regex }] as never;
  }

  const jobs = (await c.chapterJobs.find(query).sort({ createdAt: -1 }).limit(200).toArray()).map(row => stripMongoId(row) as ChapterJob);
  const sourceIds = Array.from(new Set(jobs.map(job => job.sourceId)));
  const sources = await c.contentSources.find({ id: { $in: sourceIds } }).toArray();
  const sourceById = new Map(sources.map(source => [source.id, source]));
  return jobs.map(job => ({ job, sourceName: sourceById.get(job.sourceId)?.name ?? null, sourceHostname: sourceById.get(job.sourceId)?.hostname ?? null }));
}

export async function addJobAttempt(jobId: string, phase: string, message: string): Promise<void> {
  const db = await requireDb();
  await collections(db).jobAttempts.insertOne({ id: await nextSequence("jobAttempts"), jobId, phase, message, createdAt: now() });
}

export async function listJobAttempts(jobId: string) {
  const db = await requireDb();
  return (await collections(db).jobAttempts.find({ jobId }).sort({ createdAt: -1 }).toArray()).map(stripMongoId);
}

export async function saveIntegrationHealth(service: string, status: "healthy" | "degraded" | "offline" | "unknown", message?: string): Promise<{ consecutiveFailures: number }> {
  const db = await requireDb();
  const c = collections(db).integrationHealth;
  const existing = await c.findOne({ service });
  const consecutiveFailures = status === "healthy" ? 0 : (existing?.consecutiveFailures ?? 0) + 1;
  await c.updateOne(
    { service },
    { $setOnInsert: { id: await nextSequence("integrationHealth") }, $set: { service, status, message: message ?? null, consecutiveFailures, lastCheckedAt: now(), updatedAt: now() } },
    { upsert: true },
  );
  return { consecutiveFailures };
}

export async function listIntegrationHealth() {
  const db = await requireDb();
  return (await collections(db).integrationHealth.find().sort({ service: 1 }).toArray()).map(stripMongoId);
}

export async function createIntegrationAlert(input: { service: string; severity: "warning" | "critical"; fingerprint: string; message: string; recipientDiscordUserId?: string }): Promise<{ id: number; reused: boolean }> {
  const db = await requireDb();
  const c = collections(db).integrationAlerts;
  const existing = await c.find({ service: input.service, fingerprint: input.fingerprint }).sort({ createdAt: -1 }).limit(1).next();
  if (existing && Date.now() - existing.createdAt.getTime() < 30 * 60 * 1000) return { id: existing.id, reused: true };
  const alert: IntegrationAlert = { id: await nextSequence("integrationAlerts"), service: input.service, severity: input.severity, fingerprint: input.fingerprint, message: input.message.slice(0, 4000), recipientDiscordUserId: input.recipientDiscordUserId ?? null, deliveryStatus: "pending", createdAt: now(), deliveredAt: null };
  await c.insertOne(alert);
  return { id: alert.id, reused: false };
}

export async function markIntegrationAlertDelivered(id: number, deliveryStatus: "sent" | "failed"): Promise<void> {
  const db = await requireDb();
  await collections(db).integrationAlerts.updateOne({ id }, { $set: { deliveryStatus, deliveredAt: now() } });
}

export async function listIntegrationAlerts() {
  const db = await requireDb();
  return (await collections(db).integrationAlerts.find().sort({ createdAt: -1 }).limit(50).toArray()).map(stripMongoId);
}

export async function getDashboardSummary() {
  const db = await requireDb();
  const c = collections(db);
  const countsRows = await c.chapterJobs.aggregate<{ _id: ChapterJob["status"]; count: number }>([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray();
  const recentJobs = await listChapterJobs();
  const recentAlerts = await listIntegrationAlerts();
  const [sourceCount, activeSourceCount] = await Promise.all([
    c.contentSources.countDocuments(),
    c.contentSources.countDocuments({ status: "active" }),
  ]);
  return {
    counts: Object.fromEntries(countsRows.map(item => [item._id, item.count])),
    sourceCount,
    activeSourceCount,
    recentJobs: recentJobs.slice(0, 8),
    recentAlerts: recentAlerts.slice(0, 5),
  };
}
