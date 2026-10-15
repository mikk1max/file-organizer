import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { listFiles, getAgeInDays } from './scanner.js';

export class Cleanup extends EventEmitter {
  async findOldFiles(directory, olderThanDays) {
    const root = path.resolve(directory);
    this.emit('search-start', { directory: root, olderThanDays });

    const files = await listFiles(root, {
      onError: (dirPath, error) => this.emit('file-error', { path: dirPath, error }),
    });

    const now = Date.now();
    const oldFiles = [];

    for (const filePath of files) {
      try {
        const stats = await fs.stat(filePath);
        const daysOld = getAgeInDays(stats.mtime, now);

        if (daysOld > olderThanDays) {
          const file = { path: filePath, size: stats.size, mtime: stats.mtime, daysOld };
          oldFiles.push(file);
          this.emit('file-found', file);
        }
      } catch (error) {
        this.emit('file-error', { path: filePath, error });
      }
    }

    oldFiles.sort((a, b) => b.daysOld - a.daysOld);
    const result = {
      directory: root,
      files: oldFiles,
      totalSize: oldFiles.reduce((sum, file) => sum + file.size, 0),
    };

    this.emit('search-complete', result);
    return result;
  }

  async deleteFiles(files) {
    const total = files.length;
    this.emit('delete-start', { total, totalSize: files.reduce((sum, file) => sum + file.size, 0) });

    let deleted = 0;
    let freed = 0;
    let failed = 0;

    for (const [index, file] of files.entries()) {
      const current = index + 1;
      try {
        await fs.unlink(file.path);
        deleted++;
        freed += file.size;
        this.emit('file-deleted', { ...file, current, total });
      } catch (error) {
        failed++;
        this.emit('file-error', { path: file.path, error, current, total });
      }
    }

    return { deleted, freed, failed };
  }

  async run(directory, { olderThan, confirm = false }) {
    const found = await this.findOldFiles(directory, olderThan);

    if (!confirm || found.files.length === 0) {
      const result = { ...found, dryRun: !confirm, deleted: 0, freed: 0, failed: 0 };
      this.emit('cleanup-complete', result);
      return result;
    }

    const outcome = await this.deleteFiles(found.files);
    const result = { ...found, dryRun: false, ...outcome };
    this.emit('cleanup-complete', result);
    return result;
  }
}
