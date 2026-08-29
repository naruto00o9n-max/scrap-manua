import { describe, expect, it } from "vitest";
import { resolveChapterJobCreation, type QueueChapterJobInput } from "./db";
import type { ChapterJob } from "../shared/dbTypes";

const input: QueueChapterJobInput = {
  id: "job-1",
  sourceId: 1,
  urlHash: "e".repeat(64),
  canonicalUrl: "https://chapters.example.com/series/7/chapter/1",
  requestedByDiscordId: "111",
  requestedByName: "مترجم",
};

function jobFrom(request: QueueChapterJobInput): ChapterJob {
  return {
    ...request,
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
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    requestedInChannelId: request.requestedInChannelId ?? null,
  };
}

describe("create or reuse chapter job", () => {
  it("creates once then returns the original task when the same URL is requested again", async () => {
    const rows = new Map<string, ChapterJob>();
    let insertCalls = 0;
    const store = {
      findByUrlHash: async (urlHash: string) => [...rows.values()].find(row => row.urlHash === urlHash),
      insert: async (request: QueueChapterJobInput) => { insertCalls += 1; rows.set(request.id, jobFrom(request)); },
      findById: async (id: string) => rows.get(id),
      requeueFailed: async (id: string) => {
        const job = rows.get(id)!;
        const updated = { ...job, status: "pending" as const, failureCode: null, failureMessage: null, updatedAt: new Date() };
        rows.set(id, updated);
        return updated;
      },
    };

    const first = await resolveChapterJobCreation(store, input);
    const duplicate = await resolveChapterJobCreation(store, { ...input, id: "job-2", requestedByName: "عضو آخر" });

    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({ created: false, job: { id: "job-1" } });
    expect(insertCalls).toBe(1);
  });

  it("reuses and requeues a failed task instead of creating a duplicate row", async () => {
    const failed = { ...jobFrom(input), status: "failed" as const, failureCode: "SOURCE_ERROR", failureMessage: "قديم" };
    const rows = new Map([[failed.id, failed]]);
    let retryCalls = 0;
    const store = {
      findByUrlHash: async (urlHash: string) => [...rows.values()].find(row => row.urlHash === urlHash),
      insert: async () => { throw new Error("لا ينبغي إنشاء سجل جديد"); },
      findById: async (id: string) => rows.get(id),
      requeueFailed: async (id: string) => {
        retryCalls += 1;
        const job = { ...rows.get(id)!, status: "pending" as const, failureCode: null, failureMessage: null };
        rows.set(id, job);
        return job;
      },
    };

    const result = await resolveChapterJobCreation(store, { ...input, id: "would-be-duplicate" });
    expect(result).toMatchObject({ created: true, job: { id: "job-1", status: "pending" } });
    expect(retryCalls).toBe(1);
  });
});
