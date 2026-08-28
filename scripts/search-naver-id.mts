const endpoint = "https://suwayomi-server-production-0803.up.railway.app/api/graphql";
for (const query of ["784417", "titleId=784417", "무림서부"]) {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "mutation($input:FetchSourceMangaInput!){fetchSourceManga(input:$input){mangas{id title url realUrl sourceId}}}", variables: { input: { source: "1311262507446028482", type: "SEARCH", query, page: 1, filters: [] } } }) });
  console.log(JSON.stringify({ query, body: await response.json() }));
}
