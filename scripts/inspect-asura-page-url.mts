import { ENV } from "../server/_core/env";
import { getUsableSuwayomiToken } from "../server/services/settings";
import { SuwayomiClient } from "../server/services/suwayomi";

const client = new SuwayomiClient(ENV.suwayomiBaseUrl, getUsableSuwayomiToken());
const result = await client.fetchChapterPages(484);
console.log(JSON.stringify({ pageCount: result.pages.length, firstPage: result.pages[0], secondPage: result.pages[1] }));
process.exit(0);
