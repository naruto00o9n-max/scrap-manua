import { queueAuthorizedChapter } from "../server/services/jobs";
import { getChapterJob } from "../server/db";
import { processPendingChapterJobs } from "../server/services/jobWorker";

const chapterUrl = "https://comic.naver.com/webtoon/detail?titleId=799837&no=156&week=fri";
const result = await queueAuthorizedChapter({
  chapterUrl,
  requester: {
    discordId: process.env.OWNER_DISCORD_USER_ID ?? "656783724662226963",
    displayName: "Naver verification",
  },
});
console.log(JSON.stringify({ created: result.created, jobId: result.job.id, status: result.job.status }, null, 2));
void processPendingChapterJobs();
for (let attempt = 0; attempt < 24; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 2500));
  const job = await getChapterJob(result.job.id);
  if (!job) throw new Error("Queued job disappeared");
  console.log(JSON.stringify({ attempt: attempt + 1, status: job.status, totalPages: job.totalPages, uploadedPages: job.uploadedPages, title: job.mangaTitle, failure: job.failureMessage, driveUrl: job.googleDriveUrl }, null, 2));
  if (["completed", "failed", "cancelled"].includes(job.status)) process.exit(job.status === "completed" ? 0 : 1);
}
process.exit(2);
