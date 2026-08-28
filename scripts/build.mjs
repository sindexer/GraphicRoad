import { cp, mkdir, readFile, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Allowlist the published files. Never upload the checkout, .git, tests,
// local configuration, archives, or environment files as a Pages artifact.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '_site');
const config = {
  apiKey: process.env.GOOGLE_MAPS_BROWSER_KEY || '',
  basicMapId: process.env.GOOGLE_MAP_ID_BASIC || '',
  blueMapId: process.env.GOOGLE_MAP_ID_BLUE || ''
};

if (!/^AIza[\w-]{35}$/.test(config.apiKey) ||
    !/^[a-f\d]{16,32}$/i.test(config.basicMapId) ||
    !/^[a-f\d]{16,32}$/i.test(config.blueMapId) ||
    config.basicMapId === config.blueMapId) {
  console.error('Missing or invalid Google Maps deployment settings. Values are not logged.');
  process.exit(1);
}

// Rebuild only our fixed generated directory. Refuse symlink/junction targets
// so a local build can never remove files outside this checkout.
const existingOutput = await lstat(output).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (existingOutput) {
  const resolvedRoot = await realpath(root);
  if (existingOutput.isSymbolicLink() || !existingOutput.isDirectory() ||
      await realpath(output) !== path.join(resolvedRoot, '_site')) {
    throw new Error('Refusing to replace an unexpected build output path.');
  }
  await rm(output, { recursive: true });
}
await mkdir(output);
const assets = ['google-maps.js', 'earth-timeline-core.js', 'earth-timeline.js', 'earth-timeline.css'];
for (const name of ['index.html', ...assets, 'data']) {
  await cp(path.join(root, name), path.join(output, name), { recursive: true });
}
// Keep the editor, its math, styles, and provider on the same deployment.
const htmlPath = path.join(output, 'index.html');
let html = await readFile(htmlPath, 'utf8');
for (const name of assets) {
  const hash = createHash('sha256').update(await readFile(path.join(output, name))).digest('hex').slice(0, 12);
  html = html.replace(`"${name}"`, `"${name}?v=${hash}"`);
}
await writeFile(htmlPath, html);
// This browser key is deliberately present only in the built site. Google Cloud
// HTTP-referrer and API restrictions are the actual runtime security boundary.
await writeFile(path.join(output, 'google-maps-config.json'), JSON.stringify(config));
await writeFile(path.join(output, '.nojekyll'), '');

// Catch accidental source embedding without printing a key or its value.
for (const name of ['index.html', ...assets]) {
  if ((await readFile(path.join(output, name), 'utf8')).includes(config.apiKey)) {
    console.error('Browser key found in source instead of generated configuration.');
    process.exit(1);
  }
}
console.log('Pages site built. Browser configuration injected; no credential values logged.');
