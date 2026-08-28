import { SuwayomiClient } from "../server/services/suwayomi";

const client = new SuwayomiClient("https://suwayomi-server-production-0803.up.railway.app", "");
const chapter = await client.findOrFetchChapterFromSource("830150807344972132", "https://rokaricomics.com/bunker-days-chapter-33/");
if (!chapter) throw new Error("Rokari chapter was not resolved");
const fetched = await client.fetchChapterPages(chapter.id);
const hosts = [...new Set(fetched.pages.map(page => new URL(page).hostname))];
console.log(JSON.stringify({ chapter: chapter.name, pages: fetched.pages.length, hosts, firstPages: fetched.pages.slice(0, 3) }, null, 2));
