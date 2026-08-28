import { ENV } from "../server/_core/env";

if (!ENV.integrationMonitorToken) throw new Error("Monitoring token is not configured.");

const response = await fetch("http://localhost:3000/api/internal/run-monitor", {
  method: "POST",
  headers: { "x-monitor-token": ENV.integrationMonitorToken },
  signal: AbortSignal.timeout(25_000),
});
const body = await response.json() as { ok?: boolean; results?: Array<{ service: string; healthy: boolean; message: string }>; error?: string };
console.log(JSON.stringify({ status: response.status, ...body }));
process.exit(response.status === 200 && body.results?.length === 3 ? 0 : 2);
