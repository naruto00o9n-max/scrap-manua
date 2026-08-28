import { SuwayomiClient, mangaUrlFromChapterUrl } from "../server/services/suwayomi";

const baseUrl = "https://suwayomi-server-production-0803.up.railway.app";
const chapterUrl = "https://comic.naver.com/webtoon/detail?titleId=799837&no=156&week=fri";
const sourceId = "1311262507446028482";
const client = new SuwayomiClient(baseUrl, "") as any;
const mangaUrl = mangaUrlFromChapterUrl(chapterUrl);
const manga = await client.findMangaByUrl(mangaUrl);
const chapters = manga ? await client.fetchMangaAndChapters(manga.id) : [];
console.log(JSON.stringify({ mangaUrl, manga, matching: chapters.filter((c: any) => String(c.realUrl ?? c.url).includes("titleId=799837&no=156")), total: chapters.length }, null, 2));
