import { getCacheConfig, invalidateEventsCache } from "./scraper.mjs";

async function main() {
  const config = getCacheConfig();
  await invalidateEventsCache(config);
  console.log(`Events cache invalidated at ${config.siteUrl}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
