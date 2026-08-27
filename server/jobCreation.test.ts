import { describe, expect, it } from "vitest";
import { resolveChapterJobCreation, type QueueChapterJobInput } from "./db";
import type { ChapterJob } from "../drizzle/schema";

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
    };

    const first = await resolveChapterJobCreation(store, input);
    const duplicate = await resolveChapterJobCreation(store, { ...input, id: "job-2", requestedByName: "عضو آخر" });

    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({ created: false, job: { id: "job-1" } });
    expect(insertCalls).toBe(1);
  });
});
