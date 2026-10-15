import { EventEmitter } from 'events';
import fs from 'fs/promises';
import { createReadStream, createWriteStream, constants } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { listFiles } from './scanner.js';

export const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024;

export const categories = {
  Documents: ['.pdf', '.docx', '.doc', '.txt', '.md', '.xlsx', '.pptx'],
  Images: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'],
  Archives: ['.zip', '.rar', '.tar', '.gz', '.7z'],
  Code: ['.js', '.py', '.java', '.cpp', '.html', '.css', '.json'],
  Videos: ['.mp4', '.avi', '.mkv', '.mov', '.webm'],
  Other: [],
};

export function getCategory(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const match = Object.entries(categories).find(([, extensions]) => extensions.includes(extension));
  return match ? match[0] : 'Other';
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function getAvailablePath(directory, fileName) {
  const extension = path.extname(fileName);
  const baseName = path.basename(fileName, extension);

  let candidate = path.join(directory, fileName);
  for (let counter = 1; await exists(candidate); counter++) {
    candidate = path.join(directory, `${baseName}(${counter})${extension}`);
  }
  return candidate;
}

async function copyFile(source, target, size) {
  if (size < LARGE_FILE_THRESHOLD) {
    await fs.copyFile(source, target, constants.COPYFILE_EXCL);
    return 'copyFile';
  }

  try {
    await pipeline(createReadStream(source), createWriteStream(target, { flags: 'wx' }));
  } catch (error) {
    if (error.code !== 'EEXIST') await fs.rm(target, { force: true });
    throw error;
  }
  return 'stream';
}

export class Organizer extends EventEmitter {
  async organize(sourceDirectory, outputDirectory) {
    const source = path.resolve(sourceDirectory);
    const output = path.resolve(outputDirectory);

    if (source === output) {
      const error = new Error('Source and output directories must be different');
      error.code = 'ESAMEDIR';
      throw error;
    }

    this.emit('organize-start', { source, output });

    const files = await listFiles(source, {
      exclude: output,
      onError: (dirPath, error) => this.emit('copy-error', { source: dirPath, error }),
    });

    for (const category of Object.keys(categories)) {
      const folder = path.join(output, category);
      await fs.mkdir(folder, { recursive: true });
      this.emit('folder-created', { category, path: folder });
    }

    const total = files.length;
    this.emit('copy-begin', { total });

    const summary = Object.fromEntries(Object.keys(categories).map((name) => [name, 0]));
    let copiedFiles = 0;
    let copiedSize = 0;
    let failed = 0;

    for (const [index, filePath] of files.entries()) {
      const current = index + 1;
      const category = getCategory(filePath);
      this.emit('copy-start', { source: filePath, category, current, total });

      try {
        const { size } = await fs.stat(filePath);
        const target = await getAvailablePath(path.join(output, category), path.basename(filePath));
        const method = await copyFile(filePath, target, size);

        summary[category]++;
        copiedFiles++;
        copiedSize += size;
        this.emit('copy-complete', { source: filePath, target, category, size, method, current, total });
      } catch (error) {
        failed++;
        this.emit('copy-error', { source: filePath, category, error, current, total });
      }
    }

    const result = { source, output, summary, copiedFiles, copiedSize, failed };
    this.emit('organize-complete', result);
    return result;
  }
}
