import { SuwayomiClient } from "../server/services/suwayomi";

const client = new SuwayomiClient("https://suwayomi-server-production-0803.up.railway.app", "");
const cases = [
  { name: "Naver 784417 no125", sourceId: "1311262507446028482", url: "https://comic.naver.com/webtoon/detail?titleId=784417&no=125&week=wed" },
  { name: "Rokari chapter 33", sourceId: "830150807344972132", url: "https://rokaricomics.com/bunker-days-chapter-33/" },
];
for (const item of cases) {
  try {
    const chapter = await client.findOrFetchChapterFromSource(item.sourceId ?? "", item.url);
    if (!chapter) {
      console.log(JSON.stringify({ name: item.name, resolved: false }));
      continue;
    }
    console.log(JSON.stringify({ name: item.name, resolved: true, chapterId: chapter.id, nameFromSuwayomi: chapter.name, manga: chapter.manga.title, sourceId: chapter.manga.sourceId }));
  } catch (error) {
    console.log(JSON.stringify({ name: item.name, error: error instanceof Error ? error.message : String(error) }));
  }
}
