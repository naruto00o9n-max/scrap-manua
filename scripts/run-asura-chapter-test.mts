import { ENV } from "../server/_core/env";
import { getChapterJob } from "../server/db";
import { processPendingChapterJobs } from "../server/services/jobWorker";
import { queueAuthorizedChapter } from "../server/services/jobs";

const chapterUrl = "https://asurascans.com/comics/surviving-the-game-as-a-barbarian-b57aa235/chapter/157";

if (!ENV.ownerDiscordUserId) {
  throw new Error("OWNER_DISCORD_USER_ID is required to run the approved chapter test.");
}

const queued = await queueAuthorizedChapter({
  chapterUrl,
  requester: { discordId: ENV.ownerDiscordUserId, displayName: "اختبار المالك" },
});

console.log(JSON.stringify({ jobId: queued.job.id, created: queued.created, initialStatus: queued.job.status }));
await processPendingChapterJobs();
const finalJob = await getChapterJob(queued.job.id);
console.log(JSON.stringify({ jobId: finalJob?.id, status: finalJob?.status, pages: finalJob?.totalPages, uploadedPages: finalJob?.uploadedPages, driveUrl: finalJob?.googleDriveUrl, error: finalJob?.failureMessage }));

if (finalJob?.status !== "completed") process.exit(2);
