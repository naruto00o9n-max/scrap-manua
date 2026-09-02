import { z } from "zod";
import {
  cancelChapterJob,
  ensureDefaultAdminUser,
  getDashboardSummary,
  getSetting,
  getUserByEmail,
  listChapterJobs,
  listDiscordRoles,
  listIntegrationHealth,
  listIntegrationAlerts,
  listJobAttempts,
  listSources,
  listUsers,
  removeDiscordRole,
  saveDiscordRole,
  saveIntegrationHealth,
  saveSource,
  setSetting,
  setUserBlocked,
} from "./db";
import { COOKIE_NAME, ONE_YEAR_MS } from "../shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { getIntegrationConfiguration, getUsableSuwayomiToken } from "./services/settings";
import { SuwayomiClient } from "./services/suwayomi";
import { ENV } from "./_core/env";
import { GoogleDriveClient } from "./services/googleDrive";
import { verifyPassword } from "./_core/auth";
import { sdk } from "./_core/sdk";

const sourceInput = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(2).max(120),
  hostname: z.string().trim().min(3).max(255),
  baseUrl: z.string().url().max(512),
  suwayomiSourceId: z.string().trim().max(128).optional().nullable(),
  extensionPackage: z.string().trim().max(256).optional().nullable(),
  extensionName: z.string().trim().max(160).optional().nullable(),
  status: z.enum(["active", "disabled"]),
  documentedIntegrationUrl: z.string().url().max(1024).optional().nullable(),
  allowDirectChapterLookup: z.boolean(),
  notes: z.string().trim().max(4000).optional().nullable(),
});

export const appRouter = router({
  system: router({}),
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    login: publicProcedure
      .input(z.object({ email: z.string().email().max(320), password: z.string().min(1).max(200) }))
      .mutation(async ({ input, ctx }) => {
        await ensureDefaultAdminUser();
        const user = await getUserByEmail(input.email);
        if (!user || user.isBlocked || !(await verifyPassword(input.password, user.passwordHash))) {
          throw new Error("البريد أو كلمة المرور غير صحيحة.");
        }
        const sessionToken = await sdk.createSessionToken(user.openId, { name: user.name ?? user.email ?? "Admin", role: user.role, expiresInMs: ONE_YEAR_MS });
        ctx.res.cookie(COOKIE_NAME, sessionToken, { ...getSessionCookieOptions(ctx.req), maxAge: ONE_YEAR_MS });
        return { user: { ...user, passwordHash: null } };
      }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  dashboard: router({
    summary: adminProcedure.query(() => getDashboardSummary()),
  }),
  sources: router({
    list: adminProcedure.query(() => listSources()),
    save: adminProcedure.input(sourceInput).mutation(({ input }) => saveSource(input)),
  }),
  settings: router({
    get: adminProcedure.query(async () => ({
      googleDriveSharingMode: await getSetting("google_drive_sharing_mode") ?? "link_editor",
      googleDriveSharingDomain: await getSetting("google_drive_sharing_domain") ?? "",
      configuration: getIntegrationConfiguration(),
    })),
    setDriveSharing: adminProcedure
      .input(z.object({
        mode: z.enum(["private", "link_reader", "link_editor", "domain_reader"]),
        domain: z.string().trim().max(255).optional(),
      }).superRefine((input, ctx) => {
        if (input.mode === "domain_reader" && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(input.domain ?? "")) {
          ctx.addIssue({ code: "custom", message: "أدخل نطاق Workspace صالحًا، مثل example.com." });
        }
      }))
      .mutation(async ({ input }) => {
        await setSetting("google_drive_sharing_mode", input.mode);
        await setSetting("google_drive_sharing_domain", input.mode === "domain_reader" ? input.domain ?? "" : "");
        return { mode: input.mode, domain: input.mode === "domain_reader" ? input.domain ?? "" : "" };
      }),
  }),
  users: router({
    list: adminProcedure.query(() => listUsers()),
    setBlocked: adminProcedure
      .input(z.object({ id: z.number().int().positive(), isBlocked: z.boolean() }))
      .mutation(({ input }) => setUserBlocked(input.id, input.isBlocked)),
  }),
  discordRoles: router({
    list: adminProcedure.query(() => listDiscordRoles()),
    save: adminProcedure
      .input(z.object({ discordRoleId: z.string().regex(/^\d{16,22}$/), label: z.string().trim().min(1).max(120) }))
      .mutation(({ input }) => saveDiscordRole(input.discordRoleId, input.label)),
    remove: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ input }) => removeDiscordRole(input.id)),
  }),
  jobs: router({
    list: adminProcedure
      .input(z.object({
        search: z.string().trim().max(200).optional(),
        status: z.enum(["pending", "downloading", "uploading", "completed", "failed", "cancelled"]).optional(),
        sourceId: z.number().int().positive().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        pageCount: z.number().int().positive().max(9999).optional(),
        withDrive: z.boolean().optional(),
      }))
      .query(({ input }) => listChapterJobs({ ...input, from: input.from ? new Date(input.from) : undefined, to: input.to ? new Date(input.to) : undefined })),
    attempts: adminProcedure.input(z.object({ jobId: z.string().uuid() })).query(({ input }) => listJobAttempts(input.jobId)),
    cancel: adminProcedure.input(z.object({ jobId: z.string().uuid() })).mutation(({ input }) => cancelChapterJob(input.jobId)),
  }),
  integrations: router({
    status: adminProcedure.query(async () => ({
      configuration: getIntegrationConfiguration(),
      health: await listIntegrationHealth(),
      alerts: await listIntegrationAlerts(),
    })),
    checkSuwayomi: adminProcedure.mutation(async () => {
      try {
        const client = new SuwayomiClient(ENV.suwayomiBaseUrl, getUsableSuwayomiToken());
        await client.healthcheck();
        const sources = await client.listInstalledSources();
        await saveIntegrationHealth("suwayomi", "healthy", `الخادم متاح ويحتوي ${sources.length} مصدرًا مثبتًا.`);
        return { healthy: true, sourceCount: sources.length, sources };
      } catch (error) {
        const message = error instanceof Error ? error.message : "فشل فحص اتصال Suwayomi.";
        await saveIntegrationHealth("suwayomi", "offline", message);
        return { healthy: false, sourceCount: 0, sources: [], message };
      }
    }),
    checkGoogleDrive: adminProcedure.mutation(async () => {
      try {
        const drive = new GoogleDriveClient();
        await drive.healthcheck();
        await saveIntegrationHealth("google-drive", "healthy", "تم التحقق من OAuth عبر استعلام قراءة محدود.");
        return { healthy: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "فشل فحص Google Drive.";
        await saveIntegrationHealth("google-drive", "offline", message);
        return { healthy: false, message };
      }
    }),
    listSuwayomiSources: adminProcedure.query(async () => {
      const client = new SuwayomiClient(ENV.suwayomiBaseUrl, getUsableSuwayomiToken());
      return client.listInstalledSources();
    }),
  }),
  chapterRequests: router({
    preview: protectedProcedure
      .input(z.object({ chapterUrl: z.string().url().max(2000) }))
      .query(() => ({ enabled: false, message: "تُقبل الطلبات الفعلية من Discord بعد تهيئة البوت والمصادر المصرح بها." })),
  }),
});

export type AppRouter = typeof appRouter;
