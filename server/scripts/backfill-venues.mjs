#!/usr/bin/env node
/**
 * One-off: link one host's old sessions to the shared venue list.
 *
 * Every session in each mapped group (owned by --owner) is set to the mapped
 * venue, overwriting the venue text it had. Other groups are left alone. Safe to
 * run twice. Run with --dry-run first and take `npm run db:backup` before a
 * real run.
 *
 * Usage (from server/, after `npm run build`):
 *   node scripts/backfill-venues.mjs --owner <email> \
 *     --map "<group name>=<venue name>" [--map ...] [--dry-run]
 *
 * Reads DATABASE_URL like the server does.
 */
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const USAGE =
  'Usage: node scripts/backfill-venues.mjs --owner <email> --map "<group name>=<venue name>" [--map ...] [--dry-run]';

export function parseArgs(argv) {
  const args = { owner: null, groupVenues: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') {
      args.dryRun = true;
    } else if (flag === '--owner') {
      args.owner = argv[i + 1];
      i += 1;
    } else if (flag === '--map') {
      const value = argv[i + 1];
      i += 1;
      const at = value === undefined ? -1 : value.indexOf('=');
      const groupName = at < 0 ? '' : value.slice(0, at).trim();
      const venueName = at < 0 ? '' : value.slice(at + 1).trim();
      if (groupName === '' || venueName === '') {
        throw new Error(`--map needs "<group name>=<venue name>", got ${JSON.stringify(value)}`);
      }
      args.groupVenues.push({ groupName, venueName });
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!args.owner) throw new Error(`--owner <email> is required\n${USAGE}`);
  return args;
}

async function main() {
  const { default: dotenv } = await import('dotenv');
  dotenv.config();
  const args = parseArgs(process.argv.slice(2));
  const dist = path.resolve(import.meta.dirname, '../dist/server/src');
  const { PrismaService } = await import(pathToFileURL(path.join(dist, 'prisma/prisma.service.js')).href);
  const { backfillVenues } = await import(pathToFileURL(path.join(dist, 'venues/backfill.js')).href);

  const prisma = new PrismaService();
  await prisma.onModuleInit();
  try {
    const report = await backfillVenues(prisma, {
      ownerEmail: args.owner,
      groupVenues: args.groupVenues,
      dryRun: args.dryRun,
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.onModuleDestroy();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
