import { SuwayomiClient } from "../server/services/suwayomi";
import { mergeChapterPages } from "../server/services/imageMerging";

const client = new SuwayomiClient("https://suwayomi-server-production-0803.up.railway.app", "");
const chapter = await client.findOrFetchChapterFromSource("1311262507446028482", "https://comic.naver.com/webtoon/detail?titleId=799837&no=156&week=fri");
if (!chapter) throw new Error("Naver chapter was not resolved");
const fetched = await client.fetchChapterPages(chapter.id);
const merged = await mergeChapterPages(fetched.pages);
console.log(JSON.stringify({ chapter: chapter.name, sourcePages: fetched.pages.length, mergedImages: merged.length, dimensions: merged.map(image => ({ width: image.width, height: image.height, mimeType: image.mimeType, bytes: image.data.length })) }, null, 2));
if (!merged.length || merged.some(image => image.width !== Math.max(...merged.map(item => item.width)))) throw new Error("Merged images do not share the maximum width");
