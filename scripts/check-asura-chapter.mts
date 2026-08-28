import { ENV } from "../server/_core/env";
import { getUsableSuwayomiToken } from "../server/services/settings";
import { SuwayomiClient } from "../server/services/suwayomi";

const chapterUrl = "https://asurascans.com/comics/surviving-the-game-as-a-barbarian-b57aa235/chapter/157";
const client = new SuwayomiClient(ENV.suwayomiBaseUrl, getUsableSuwayomiToken());
const chapter = await client.findOrFetchChapterFromSource("6247824327199706550", chapterUrl);

if (!chapter) {
  console.error("The requested chapter is not available in Suwayomi yet.");
  process.exit(2);
}

console.log(JSON.stringify({ id: chapter.id, title: chapter.name, mangaTitle: chapter.manga.title, sourceId: chapter.manga.sourceId }));
process.exit(0);
