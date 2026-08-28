import { queueAuthorizedChapter } from "../server/services/jobs";
import { getChapterJob } from "../server/db";
import { processPendingChapterJobs } from "../server/services/jobWorker";

const url = "https://rokaricomics.com/bunker-days-chapter-33/";
const { job, created } = await queueAuthorizedChapter({
  chapterUrl: url,
  requester: { discordId: "queue-verification", displayName: "queue-verification", channelId: undefined },
});
console.log(JSON.stringify({ queuedJobId: job.id, created, initialStatus: job.status }, null, 2));
void processPendingChapterJobs();
const deadline = Date.now() + 180_000;
let latest = job;
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 2_000));
  latest = (await getChapterJob(job.id)) ?? latest;
  console.log(JSON.stringify({ status: latest.status, totalPages: latest.totalPages, uploadedPages: latest.uploadedPages, failureMessage: latest.failureMessage, driveUrl: latest.googleDriveUrl }, null, 2));
  if (["completed", "failed", "cancelled"].includes(latest.status)) break;
}
if (latest.status !== "completed") throw new Error(`Rokari queue verification ended as ${latest.status}: ${latest.failureMessage ?? "deadline exceeded"}`);
