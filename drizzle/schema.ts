import {
  boolean,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["admin", "user"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const sourceStatus = mysqlEnum("sourceStatus", ["active", "disabled"]);
export const jobStatus = mysqlEnum("jobStatus", [
  "pending",
  "downloading",
  "uploading",
  "completed",
  "failed",
  "cancelled",
]);
export const healthStatus = mysqlEnum("healthStatus", ["healthy", "degraded", "offline", "unknown"]);

export const contentSources = mysqlTable(
  "contentSources",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    hostname: varchar("hostname", { length: 255 }).notNull(),
    baseUrl: varchar("baseUrl", { length: 512 }).notNull(),
    suwayomiSourceId: varchar("suwayomiSourceId", { length: 128 }),
    extensionPackage: varchar("extensionPackage", { length: 256 }),
    extensionName: varchar("extensionName", { length: 160 }),
    status: sourceStatus.default("disabled").notNull(),
    documentedIntegrationUrl: varchar("documentedIntegrationUrl", { length: 1024 }),
    allowDirectChapterLookup: boolean("allowDirectChapterLookup").default(false).notNull(),
    rejectLoginRequired: boolean("rejectLoginRequired").default(true).notNull(),
    rejectCaptchaRequired: boolean("rejectCaptchaRequired").default(true).notNull(),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [uniqueIndex("contentSources_hostname_unique").on(table.hostname)],
);

export const appSettings = mysqlTable("appSettings", {
  key: varchar("key", { length: 128 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const discordRoles = mysqlTable(
  "discordRoles",
  {
    id: int("id").autoincrement().primaryKey(),
    discordRoleId: varchar("discordRoleId", { length: 32 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("discordRoles_role_unique").on(table.discordRoleId)],
);

export const chapterJobs = mysqlTable(
  "chapterJobs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    sourceId: int("sourceId").notNull(),
    urlHash: varchar("urlHash", { length: 64 }).notNull(),
    canonicalUrl: varchar("canonicalUrl", { length: 1024 }).notNull(),
    requestedByDiscordId: varchar("requestedByDiscordId", { length: 32 }).notNull(),
    requestedByName: varchar("requestedByName", { length: 160 }).notNull(),
    requestedInChannelId: varchar("requestedInChannelId", { length: 32 }),
    discordProgressMessageId: varchar("discordProgressMessageId", { length: 32 }),
    sourceChapterId: varchar("sourceChapterId", { length: 160 }),
    mangaTitle: varchar("mangaTitle", { length: 512 }),
    chapterTitle: varchar("chapterTitle", { length: 512 }),
    status: jobStatus.default("pending").notNull(),
    totalPages: int("totalPages").default(0).notNull(),
    uploadedPages: int("uploadedPages").default(0).notNull(),
    googleDriveFolderId: varchar("googleDriveFolderId", { length: 160 }),
    googleDriveUrl: varchar("googleDriveUrl", { length: 1024 }),
    failureCode: varchar("failureCode", { length: 120 }),
    failureMessage: text("failureMessage"),
    cancelRequested: boolean("cancelRequested").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("chapterJobs_urlHash_unique").on(table.urlHash),
    index("chapterJobs_status_createdAt_idx").on(table.status, table.createdAt),
    index("chapterJobs_requestedBy_idx").on(table.requestedByDiscordId),
    index("chapterJobs_source_idx").on(table.sourceId),
  ],
);

export const jobAttempts = mysqlTable(
  "jobAttempts",
  {
    id: int("id").autoincrement().primaryKey(),
    jobId: varchar("jobId", { length: 36 }).notNull(),
    phase: varchar("phase", { length: 64 }).notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("jobAttempts_job_createdAt_idx").on(table.jobId, table.createdAt)],
);

export const integrationHealth = mysqlTable(
  "integrationHealth",
  {
    id: int("id").autoincrement().primaryKey(),
    service: varchar("service", { length: 64 }).notNull(),
    status: healthStatus.default("unknown").notNull(),
    message: text("message"),
    consecutiveFailures: int("consecutiveFailures").default(0).notNull(),
    lastCheckedAt: timestamp("lastCheckedAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [uniqueIndex("integrationHealth_service_unique").on(table.service)],
);

export const alertSeverity = mysqlEnum("alertSeverity", ["warning", "critical"]);
export const alertDeliveryStatus = mysqlEnum("alertDeliveryStatus", ["pending", "sent", "failed"]);

export const integrationAlerts = mysqlTable(
  "integrationAlerts",
  {
    id: int("id").autoincrement().primaryKey(),
    service: varchar("service", { length: 64 }).notNull(),
    severity: alertSeverity.default("warning").notNull(),
    fingerprint: varchar("fingerprint", { length: 128 }).notNull(),
    message: text("message").notNull(),
    recipientDiscordUserId: varchar("recipientDiscordUserId", { length: 32 }),
    deliveryStatus: alertDeliveryStatus.default("pending").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    deliveredAt: timestamp("deliveredAt"),
  },
  table => [index("integrationAlerts_service_createdAt_idx").on(table.service, table.createdAt)],
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type ContentSource = typeof contentSources.$inferSelect;
export type ChapterJob = typeof chapterJobs.$inferSelect;
