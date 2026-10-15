import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';

export const DAY_MS = 1000 * 60 * 60 * 24;

const TOP_LARGEST = 3;

export async function listFiles(directory, { exclude, onError } = {}) {
  const files = [];

  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (current === directory) throw error;
      onError?.(current, error);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (fullPath !== exclude) await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  await walk(directory);
  return files;
}

export function getAgeInDays(mtime, now = Date.now()) {
  return (now - mtime.getTime()) / DAY_MS;
}

function createStatistics(directory) {
  return {
    directory,
    totalFiles: 0,
    totalSize: 0,
    byType: new Map(),
    age: { last7Days: 0, last30Days: 0, olderThan90Days: 0 },
    largest: [],
    oldest: null,
  };
}

function addToStatistics(stats, file, now) {
  stats.totalFiles++;
  stats.totalSize += file.size;

  const type = stats.byType.get(file.extension) ?? { count: 0, totalSize: 0 };
  type.count++;
  type.totalSize += file.size;
  stats.byType.set(file.extension, type);

  const days = getAgeInDays(file.mtime, now);
  if (days <= 7) stats.age.last7Days++;
  if (days <= 30) stats.age.last30Days++;
  if (days > 90) stats.age.olderThan90Days++;

  stats.largest.push(file);
  stats.largest.sort((a, b) => b.size - a.size);
  stats.largest.length = Math.min(stats.largest.length, TOP_LARGEST);

  if (!stats.oldest || file.mtime < stats.oldest.mtime) {
    stats.oldest = file;
  }
}

export class Scanner extends EventEmitter {
  async scan(directory) {
    const root = path.resolve(directory);
    this.emit('scan-start', { directory: root });

    const files = await listFiles(root, {
      onError: (dirPath, error) => this.emit('file-error', { path: dirPath, error }),
    });
    const total = files.length;
    this.emit('files-listed', { total });

    const now = Date.now();
    const stats = createStatistics(root);

    for (const [index, filePath] of files.entries()) {
      const current = index + 1;
      try {
        const { size, mtime } = await fs.stat(filePath);
        const fileData = {
          path: filePath,
          name: path.basename(filePath),
          extension: path.extname(filePath).toLowerCase() || '(no ext)',
          size,
          mtime,
        };
        addToStatistics(stats, fileData, now);
        this.emit('file-found', { ...fileData, current, total });
      } catch (error) {
        this.emit('file-error', { path: filePath, error, current, total });
      }
    }

    this.emit('scan-complete', stats);
    return stats;
  }
}
