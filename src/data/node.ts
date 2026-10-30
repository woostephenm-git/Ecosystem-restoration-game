// Reads data/ from disk for tests and headless scripts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData, type DataBundle, type RawFiles } from '../sim/loader';

export const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));

export function readRawFiles(dir = DATA_DIR): RawFiles {
  const files: RawFiles = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.json')) files[relative(dir, full).split(sep).join('/')] = JSON.parse(readFileSync(full, 'utf-8'));
    }
  };
  walk(dir);
  return files;
}

export function loadNodeData(): DataBundle {
  return loadData(readRawFiles());
}
