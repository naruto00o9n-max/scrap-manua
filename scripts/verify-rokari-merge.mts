import { SuwayomiClient } from "../server/services/suwayomi";
import { mergeChapterPages } from "../server/services/imageMerging";

const client = new SuwayomiClient("https://suwayomi-server-production-0803.up.railway.app", "");
const chapter = await client.findOrFetchChapterFromSource("830150807344972132", "https://rokaricomics.com/bunker-days-chapter-33/");
if (!chapter) throw new Error("Rokari chapter was not resolved");
const fetched = await client.fetchChapterPages(chapter.id);
const start = Date.now();
const merged = await mergeChapterPages(fetched.pages);
console.log(JSON.stringify({ chapter: chapter.name, sourcePages: fetched.pages.length, mergedImages: merged.length, elapsedMs: Date.now() - start, dimensions: merged.map(item => ({ width: item.width, height: item.height, bytes: item.data.length })) }, null, 2));
