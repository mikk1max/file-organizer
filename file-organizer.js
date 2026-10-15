#!/usr/bin/env node
import path from 'path';
import { Scanner } from './lib/scanner.js';
import { DuplicateFinder } from './lib/duplicates.js';
import { Organizer, categories } from './lib/organizer.js';
import { Cleanup } from './lib/cleanup.js';

const SEPARATOR = '━'.repeat(34);
const MAX_TYPES = 10;
const CLEANUP_PREVIEW_LIMIT = 10;

const USAGE = `Usage:
  node file-organizer.js scan <directory>
  node file-organizer.js duplicates <directory>
  node file-organizer.js organize <source> --output <target>
  node file-organizer.js cleanup <directory> --older-than <days> [--confirm]

Options:
  --output <dir>       Target directory for organize
  --older-than <days>  Age threshold in days for cleanup
  --confirm            Actually delete files (cleanup runs as dry run without it)
  -h, --help           Show this help`;

const ERROR_MESSAGES = {
  ENOENT: 'File or directory not found',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EEXIST: 'File already exists',
  ENOSPC: 'No space left on device',
  EROFS: 'Read-only file system',
  EBUSY: 'Resource is busy or locked',
  EMFILE: 'Too many open files',
};

class UsageError extends Error {}

function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } else {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}

function formatDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pluralize(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function drawProgressBar(current, total, width = 20) {
  const percentage = total > 0 ? current / total : 1;
  const filled = Math.round(percentage * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `${bar} ${current}/${total}`;
}

function createProgress(label, suffix = '') {
  return (current, total) => {
    if (!process.stdout.isTTY && current < total) return;
    process.stdout.write(`\r${label} ${drawProgressBar(current, total)}${suffix}`);
    if (current >= total) process.stdout.write('\n');
  };
}

function describeError(error) {
  return ERROR_MESSAGES[error.code] ?? error.message;
}

function printWarnings(warnings) {
  if (warnings.length === 0) return;
  console.log(`\n⚠️  Skipped ${pluralize(warnings.length, 'item')}:`);
  for (const { path: itemPath, error } of warnings) {
    console.log(`  ${itemPath} — ${describeError(error)}`);
  }
}

function handleFatalError(error, target) {
  if (error instanceof UsageError) {
    console.error(`❌ ${error.message}\n\n${USAGE}`);
  } else if (error.code === 'ENOENT') {
    console.error(`❌ Error: Directory not found: ${target}`);
  } else if (error.code === 'EACCES' || error.code === 'EPERM') {
    console.error(`❌ Error: Permission denied: ${target}`);
  } else if (error.code === 'ENOTDIR') {
    console.error(`❌ Error: Not a directory: ${target}`);
  } else if (error.code === 'ENOSPC') {
    console.error(`❌ Error: No space left on device while writing to: ${target}`);
  } else if (error.code === 'EROFS') {
    console.error(`❌ Error: Read-only file system: ${target}`);
  } else if (error.code === 'ESAMEDIR') {
    console.error(`❌ Error: ${error.message}`);
  } else {
    console.error(`❌ Unexpected error: ${error.message}`);
  }
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const options = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];

    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--confirm') {
      options.confirm = true;
    } else if (arg.startsWith('--')) {
      const [name, inlineValue] = arg.slice(2).split(/=(.*)/s);
      if (name !== 'output' && name !== 'older-than') {
        throw new UsageError(`Unknown option: --${name}`);
      }
      const value = inlineValue ?? rest[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`Option --${name} requires a value`);
      }
      options[name] = value;
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, options };
}

function requireDirectory(positional, command) {
  if (positional.length === 0) {
    throw new UsageError(`Missing directory for "${command}"`);
  }
  if (positional.length > 1) {
    throw new UsageError(`Unexpected argument: ${positional[1]}`);
  }
  return positional[0];
}

function displayPath(filePath, root) {
  return path.relative(path.dirname(root), filePath);
}

async function runScan(directory) {
  const scanner = new Scanner();
  const warnings = [];
  const progress = createProgress('Processing...', ' files');

  scanner.on('scan-start', ({ directory: root }) => console.log(`📂 Scanning: ${root}`));
  scanner.on('file-found', ({ current, total }) => progress(current, total));
  scanner.on('file-error', (data) => {
    warnings.push(data);
    if (data.current) progress(data.current, data.total);
  });

  scanner.on('scan-complete', (stats) => {
    if (stats.totalFiles === 0) {
      console.log('\nNo files found.');
      return;
    }

    console.log('\n📊 Scan Results:');
    console.log(SEPARATOR);
    console.log(`Total files: ${stats.totalFiles}`);
    console.log(`Total size: ${formatSize(stats.totalSize)}`);

    const types = [...stats.byType].sort((a, b) => b[1].totalSize - a[1].totalSize || b[1].count - a[1].count);
    const shown = types.slice(0, MAX_TYPES);
    const rest = types.slice(MAX_TYPES);
    if (rest.length > 0) {
      shown.push([
        '(other)',
        rest.reduce(
          (sum, [, type]) => ({ count: sum.count + type.count, totalSize: sum.totalSize + type.totalSize }),
          { count: 0, totalSize: 0 },
        ),
      ]);
    }

    const extWidth = Math.max(...shown.map(([ext]) => ext.length));
    const countWidth = Math.max(...shown.map(([, type]) => String(type.count).length));
    const sizeWidth = Math.max(...shown.map(([, type]) => formatSize(type.totalSize).length));

    console.log('\nBy File Type:');
    for (const [ext, type] of shown) {
      const count = `${String(type.count).padStart(countWidth)} ${type.count === 1 ? 'file ' : 'files'}`;
      console.log(`  ${ext.padEnd(extWidth)}  ${count}  ${formatSize(type.totalSize).padStart(sizeWidth)}`);
    }

    console.log('\nFile Age:');
    console.log(`  Last 7 days:    ${pluralize(stats.age.last7Days, 'file')}`);
    console.log(`  Last 30 days:   ${pluralize(stats.age.last30Days, 'file')}`);
    console.log(`  Older than 90:  ${pluralize(stats.age.olderThan90Days, 'file')}`);

    const nameWidth = Math.max(...stats.largest.map((file) => file.name.length));
    console.log('\nLargest files:');
    stats.largest.forEach((file, index) => {
      console.log(`  ${index + 1}. ${file.name.padEnd(nameWidth)}  ${formatSize(file.size).padStart(9)}`);
    });

    const oldestDays = Math.floor((Date.now() - stats.oldest.mtime.getTime()) / (1000 * 60 * 60 * 24));
    console.log(`\nOldest file: ${stats.oldest.name} (modified ${pluralize(oldestDays, 'day')} ago)`);
  });

  await scanner.scan(directory);
  printWarnings(warnings);
}

async function runDuplicates(directory) {
  const finder = new DuplicateFinder();
  const warnings = [];
  const progress = createProgress('Calculating hashes...', ' files');
  let root;

  finder.on('search-start', ({ directory: dir }) => {
    root = dir;
    console.log(`🔍 Searching for duplicates in: ${dir}`);
  });
  finder.on('hashing-start', ({ totalFiles, total }) => {
    console.log(`Scanned ${pluralize(totalFiles, 'file')}, ${total} with matching sizes need hashing`);
  });
  finder.on('file-processed', ({ current, total }) => progress(current, total));
  finder.on('file-error', (data) => {
    warnings.push(data);
    if (data.current) progress(data.current, data.total);
  });

  finder.on('duplicates-found', ({ groups, totalWasted }) => {
    if (groups.length === 0) {
      console.log('\n✅ No duplicates found.');
      return;
    }

    const groupWord = groups.length === 1 ? 'group' : 'groups';
    console.log(`\nFound ${groups.length} duplicate ${groupWord} (${formatSize(totalWasted)} wasted):\n`);

    groups.forEach((group, index) => {
      console.log(SEPARATOR);
      console.log(`Group ${index + 1} (${group.files.length} copies, ${formatSize(group.size)} each):`);
      console.log(`  SHA-256: ${group.hash.slice(0, 12)}...\n`);
      for (const file of group.files) {
        console.log(`  📄 ${displayPath(file, root)}`);
      }
      console.log(`\n  Wasted space: ${formatSize(group.wastedSpace)}\n`);
    });

    console.log(SEPARATOR);
    console.log(`💾 Total wasted space: ${formatSize(totalWasted)}`);
  });

  await finder.find(directory);
  printWarnings(warnings);
}

async function runOrganize(source, output) {
  const organizer = new Organizer();
  const warnings = [];
  const progress = createProgress('Copying files...');

  organizer.on('organize-start', ({ source: src, output: out }) => {
    console.log(`📦 Organizing: ${src}`);
    console.log(`Target: ${out}\n`);
    console.log('Creating folders...');
  });
  organizer.on('folder-created', ({ category }) => console.log(`  ✓ ${category}/`));
  organizer.on('copy-begin', ({ total }) => {
    console.log('');
    if (total === 0) console.log('No files to copy.');
  });
  organizer.on('copy-complete', ({ current, total }) => progress(current, total));
  organizer.on('copy-error', ({ source: src, error, current, total }) => {
    warnings.push({ path: src, error });
    if (current) progress(current, total);
  });

  organizer.on('organize-complete', ({ output: out, summary, copiedFiles, copiedSize, failed }) => {
    console.log(failed > 0 ? '\n⚠️  Organization finished with errors.' : '\n✅ Organization complete!');
    console.log('\nSummary:');

    const nameWidth = Math.max(...Object.keys(categories).map((name) => name.length)) + 1;
    const countWidth = Math.max(...Object.values(summary).map((count) => String(count).length));
    const outName = path.basename(out);
    for (const [category, count] of Object.entries(summary)) {
      const label = `${category}:`.padEnd(nameWidth);
      const files = `${String(count).padStart(countWidth)} ${count === 1 ? 'file ' : 'files'}`;
      console.log(`  ${label} ${files} → ${outName}/${category}/`);
    }

    console.log(`\nTotal copied: ${pluralize(copiedFiles, 'file')} (${formatSize(copiedSize)})`);
    if (failed > 0) console.log(`Failed: ${pluralize(failed, 'file')}`);
  });

  await organizer.organize(source, output);
  printWarnings(warnings);
}

async function runCleanup(directory, olderThan, confirm) {
  const cleanup = new Cleanup();
  const warnings = [];
  const progress = createProgress('Deleting...');
  let root;

  cleanup.on('search-start', ({ directory: dir, olderThanDays }) => {
    root = dir;
    console.log(`🧹 Cleanup: ${dir}`);
    console.log(`Looking for files older than ${pluralize(olderThanDays, 'day')}...\n`);
  });
  cleanup.on('file-error', (data) => {
    warnings.push(data);
    if (data.current) progress(data.current, data.total);
  });

  cleanup.on('search-complete', ({ files, totalSize }) => {
    if (files.length === 0) {
      console.log('✅ No files found to delete.');
      return;
    }

    console.log(`Found ${pluralize(files.length, 'file')} to delete:\n`);
    console.log(SEPARATOR);
    for (const file of files.slice(0, CLEANUP_PREVIEW_LIMIT)) {
      const days = Math.floor(file.daysOld);
      console.log(displayPath(file.path, root));
      console.log(`  Size: ${formatSize(file.size)}`);
      console.log(`  Modified: ${pluralize(days, 'day')} ago (${formatDate(file.mtime)})\n`);
    }
    if (files.length > CLEANUP_PREVIEW_LIMIT) {
      console.log(`... (${files.length - CLEANUP_PREVIEW_LIMIT} more files)`);
    }
    console.log(SEPARATOR);
    console.log(`\nTotal: ${pluralize(files.length, 'file')} (${formatSize(totalSize)})`);
  });

  cleanup.on('delete-start', ({ total, totalSize }) => {
    console.log(`\n⚠️  DELETING ${pluralize(total, 'file')} (${formatSize(totalSize)}). This action cannot be undone!\n`);
  });
  cleanup.on('file-deleted', ({ current, total }) => progress(current, total));

  cleanup.on('cleanup-complete', ({ files, dryRun, deleted, freed, failed }) => {
    if (files.length === 0) return;

    if (dryRun) {
      console.log('\n⚠️  DRY RUN MODE: No files were deleted.');
      console.log('To actually delete these files, run with --confirm flag.');
      return;
    }

    console.log(failed > 0 ? '\n⚠️  Cleanup finished with errors.' : '\n✅ Cleanup complete!');
    console.log(`Deleted: ${pluralize(deleted, 'file')} (${formatSize(freed)} freed)`);
    if (failed > 0) console.log(`Failed: ${pluralize(failed, 'file')}`);
  });

  await cleanup.run(directory, { olderThan, confirm });
  printWarnings(warnings);
}

async function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2));

  if (!command || command === '-h' || command === '--help' || options.help) {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case 'scan':
      await runScan(requireDirectory(positional, command));
      break;

    case 'duplicates':
      await runDuplicates(requireDirectory(positional, command));
      break;

    case 'organize': {
      const source = requireDirectory(positional, command);
      if (!options.output) throw new UsageError('Missing required option --output <directory>');
      await runOrganize(source, options.output);
      break;
    }

    case 'cleanup': {
      const directory = requireDirectory(positional, command);
      if (options['older-than'] === undefined) throw new UsageError('Missing required option --older-than <days>');
      const days = Number(options['older-than']);
      if (!Number.isFinite(days) || days < 0) {
        throw new UsageError(`--older-than must be a non-negative number, got "${options['older-than']}"`);
      }
      await runCleanup(directory, days, Boolean(options.confirm));
      break;
    }

    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

try {
  await main();
} catch (error) {
  const target = error.path ?? process.argv[3] ?? '';
  handleFatalError(error, target);
}
