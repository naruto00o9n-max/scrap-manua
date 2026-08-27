const endpoint = process.env.MANGA_DRIVE_MONITOR_URL;
const token = process.env.INTEGRATION_MONITOR_TOKEN;

if (!endpoint || !token) {
  console.error("MANGA_DRIVE_MONITOR_URL and INTEGRATION_MONITOR_TOKEN are required.");
  process.exit(1);
}

const response = await fetch(endpoint, {
  method: "POST",
  headers: { "x-monitor-token": token },
  signal: AbortSignal.timeout(60_000),
});
const payload = await response.text();
if (!response.ok) {
  console.error(`Monitor failed with ${response.status}: ${payload}`);
  process.exit(1);
}
console.log("Integration monitor completed.");
