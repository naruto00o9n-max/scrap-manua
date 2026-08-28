const endpoint = "https://suwayomi-server-production-0803.up.railway.app/api/graphql";
const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "mutation($input:FetchSourceMangaInput!){fetchSourceManga(input:$input){mangas{id title url realUrl sourceId}}}", variables: { input: { source: "1311262507446028482", type: "SEARCH", query: "무림서부", page: 1, filters: [] } } }) });
const body = await response.json();
console.log(JSON.stringify(body, null, 2));
