import { SuwayomiClient } from "../server/services/suwayomi";

const baseUrl = process.env.SUWAYOMI_BASE_URL ?? "https://suwayomi-server-production-0803.up.railway.app";
const chapterUrl = "https://comic.naver.com/webtoon/detail?titleId=799837&no=156&week=fri";
const sourceId = "1311262507446028482";

const client = new SuwayomiClient(baseUrl, process.env.SUWAYOMI_API_TOKEN ?? "");
const sources = await client.listInstalledSources();
const source = sources.find(item => item.id === sourceId);
if (!source) throw new Error("Naver source is not installed in Suwayomi");
const chapter = await client.findOrFetchChapterFromSource(sourceId, chapterUrl);
console.log(JSON.stringify({ source: { id: source.id, displayName: source.displayName, extension: source.extension }, chapter }, null, 2));
if (!chapter) throw new Error("Naver chapter was not resolved");
