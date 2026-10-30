// Bundles data/ into the browser build.
import { loadData, type DataBundle, type RawFiles } from '../sim/loader';

const modules = import.meta.glob('../../data/**/*.json', { eager: true, import: 'default' });

export function loadBrowserData(): DataBundle {
  const files: RawFiles = {};
  for (const [path, value] of Object.entries(modules)) files[path.replace('../../data/', '')] = value;
  return loadData(files);
}
