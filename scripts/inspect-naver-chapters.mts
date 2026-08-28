const endpoint = "https://suwayomi-server-production-0803.up.railway.app/api/graphql";
async function request(query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const body = await response.json() as { data?: any; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(body.errors.map(error => error.message).join("; "));
  return body.data;
}
const manga = await request("query($url:String!){ mangas(condition:{url:$url},first:10){nodes{id title url realUrl sourceId}} }", { url: "/webtoon/list?titleId=784417" });
console.log(JSON.stringify(manga, null, 2));
const node = manga.mangas.nodes[0];
if (node) {
  const chapters = await request("mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchManga:true,fetchChapters:true}){chapters{id name url realUrl manga{id title sourceId}}} }", { id: node.id });
  const selected = chapters.fetchMangaAndChapters.chapters.filter((chapter: any) => /123|124|125|무림서부/.test(`${chapter.name} ${chapter.url} ${chapter.realUrl}`));
  console.log(JSON.stringify({ count: chapters.fetchMangaAndChapters.chapters.length, selected }, null, 2));
}
