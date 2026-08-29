import { getDb } from "../server/db";

const db = await getDb();
if (!db) {
  throw new Error("MONGODB_URI is required to initialize MongoDB indexes.");
}
console.log("MongoDB connection succeeded and indexes are ready.");
process.exit(0);
