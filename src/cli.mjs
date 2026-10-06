import { getConfig, integerOption, runScraper } from "./scraper.mjs";

async function main() {
  let dryRun = false;
  let limit;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--limit") {
      if (args[index + 1] === undefined) throw new Error("--limit requires a value");
      limit = integerOption(args[++index], "--limit", 0);
    } else if (arg.startsWith("--limit=")) {
      limit = integerOption(arg.slice("--limit=".length), "--limit", 0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  const config = getConfig(process.env, { dryRun });
  if (limit !== undefined) config.limit = limit;
  const summary = await runScraper(config, { dryRun });
  if (summary.errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
