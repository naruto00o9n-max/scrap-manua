import { SuwayomiClient } from "../server/services/suwayomi";
const client = new SuwayomiClient("https://suwayomi-server-production-0803.up.railway.app", "");
const started = Date.now();
const chapter = await client.findOrFetchChapterFromSource("1311262507446028482", "https://comic.naver.com/webtoon/detail?titleId=784417&no=125&week=wed");
if (!chapter) throw new Error("Naver chapter was not resolved");
const fetched = await client.fetchChapterPages(chapter.id);
console.log(JSON.stringify({ chapter: chapter.name, chapterId: chapter.id, pages: fetched.pages.length, elapsedMs: Date.now() - started }, null, 2));
