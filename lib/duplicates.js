import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { listFiles } from './scanner.js';

export function calculateHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export class DuplicateFinder extends EventEmitter {
  async find(directory) {
    const root = path.resolve(directory);
    this.emit('search-start', { directory: root });

    const files = await listFiles(root, {
      onError: (dirPath, error) => this.emit('file-error', { path: dirPath, error }),
    });

    // Only files that share a size can have identical content, so the rest are never hashed.
    const sizes = new Map();
    const bySize = new Map();
    for (const filePath of files) {
      try {
        const { size } = await fsp.stat(filePath);
        if (size === 0) continue;
        sizes.set(filePath, size);
        const group = bySize.get(size) ?? [];
        group.push(filePath);
        bySize.set(size, group);
      } catch (error) {
        this.emit('file-error', { path: filePath, error });
      }
    }

    const candidates = [...bySize.values()].filter((group) => group.length > 1).flat();
    const total = candidates.length;
    this.emit('hashing-start', { totalFiles: files.length, total });

    const byHash = new Map();
    for (const [index, filePath] of candidates.entries()) {
      const current = index + 1;
      try {
        const hash = await calculateHash(filePath);
        const group = byHash.get(hash) ?? [];
        group.push(filePath);
        byHash.set(hash, group);
        this.emit('file-processed', { path: filePath, hash, current, total });
      } catch (error) {
        this.emit('file-error', { path: filePath, error, current, total });
      }
    }

    const groups = [...byHash]
      .filter(([, filePaths]) => filePaths.length > 1)
      .map(([hash, filePaths]) => {
        const size = sizes.get(filePaths[0]);
        return {
          hash,
          size,
          files: filePaths.sort(),
          wastedSpace: size * (filePaths.length - 1),
        };
      })
      .sort((a, b) => b.wastedSpace - a.wastedSpace);

    const result = {
      directory: root,
      groups,
      totalWasted: groups.reduce((sum, group) => sum + group.wastedSpace, 0),
    };

    this.emit('duplicates-found', result);
    return result;
  }
}
