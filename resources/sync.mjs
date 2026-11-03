import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
import { readFile, writeFile, mkdir, mkdtemp, rm, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = dirname(fileURLToPath(import.meta.url));
const cache = join(root, '.cache');
const sources = JSON.parse(await readFile(join(root, 'sources.json')));
const hash = data => createHash('sha256').update(data).digest('hex');
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const api = path => JSON.parse(gh('api', path));

function validate(file, data) {
  if (!data.length) throw new Error(`Empty resource: ${file.path}`);
  if (file.kind === 'png' && !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error(`Invalid PNG: ${file.path}`);
  if (file.kind === 'notice' && /<(?:!doctype|html)/i.test(data.toString().slice(0, 100))) throw new Error(`Invalid notice: ${file.path}`);
  if (file.kind === 'rule') {
    const payload = parse(data.toString())?.payload;
    if (!Array.isArray(payload) || !payload.length || payload.some(rule => typeof rule !== 'string' || !rule.trim())) throw new Error(`Invalid rule payload: ${file.path}`);
    if (file.behavior === 'ipcidr') payload.forEach(validatePrefix);
  }
  if (file.kind === 'voice') {
    const payload = JSON.parse(data).prefixes?.flatMap(entry => [entry.ipv4Prefix, entry.ipv6Prefix]).filter(Boolean);
    if (!payload?.length || payload.length > 10000) throw new Error('Invalid voice prefix count');
    payload.forEach(validatePrefix);
  }
}

function validatePrefix(prefix) {
  const [address, bits, extra] = String(prefix).split('/');
  const version = isIP(address);
  if (!version || extra || !/^\d+$/.test(bits) || Number(bits) > (version === 4 ? 32 : 128)) throw new Error('Invalid IP prefix');
}

async function download(url, limit) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        if ((size += chunk.length) > limit) throw new Error(`Oversized resource: ${url}`);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

async function refresh() {
  const files = [];
  for (const source of sources.sources) {
    const commit = /^[a-f0-9]{40}$/.test(source.ref) ? source.ref : api(`repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`).sha;
    for (const file of source.files) files.push({ ...file, sourceCommit: commit, url: `https://raw.githubusercontent.com/${source.repository}/${commit}/${file.source}` });
  }
  files.push(...sources.remote);
  const release = api(`repos/${sources.geodata.repository}/releases/tags/${sources.geodata.tag}`);
  const geodata = sources.geodata.files.map(name => {
    const asset = release.assets.find(asset => asset.name === name);
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error(`Missing upstream checksum: ${name}`);
    return { name, url: asset.browser_download_url, sha256: asset.digest.slice(7), bytes: asset.size, upstreamAssetId: asset.id };
  });
  const staged = await mkdtemp(join(root, '.staging-'));
  const snapshot = { files: [], geodata: { source: release.html_url, publishedAt: release.published_at, files: geodata } };
  try {
    const tasks = [
      ...files.map(file => async () => {
        const data = await download(file.url, file.kind === 'voice' ? 262144 : 32 * 1024 * 1024);
        validate(file, data);
        await mkdir(join(staged, dirname(file.path)), { recursive: true });
        await writeFile(join(staged, file.path), data);
        return { path: file.path, kind: file.kind, ...(file.behavior ? { behavior: file.behavior } : {}), url: file.url, ...(file.sourceCommit ? { sourceCommit: file.sourceCommit } : {}), sha256: hash(data), bytes: data.length };
      }),
      ...geodata.map(file => async () => {
        const data = await download(file.url, 64 * 1024 * 1024);
        if (data.length !== file.bytes || hash(data) !== file.sha256) throw new Error(`Geo data checksum mismatch: ${file.name}`);
        await mkdir(join(staged, '.cache'), { recursive: true });
        await writeFile(join(staged, '.cache', file.name), data);
      }),
    ];
    const results = [];
    let next = 0;
    const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]();
      }
    }));
    for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
    snapshot.files = results.slice(0, files.length);
    // Only replace the last-good snapshot after every download has passed validation.
    for (const path of [...files.map(file => file.path), ...geodata.map(file => `.cache/${file.name}`)]) {
      await mkdir(join(root, dirname(path)), { recursive: true });
      await rename(join(staged, path), join(root, path));
    }
    await writeFile(join(root, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n');
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
  console.log(`Validated ${files.length} files and ${geodata.length} Geo data assets`);
}

async function check() {
  const snapshot = JSON.parse(await readFile(join(root, 'snapshot.json')));
  const expected = [...sources.sources.flatMap(source => source.files), ...sources.remote].map(file => file.path).sort();
  if (JSON.stringify(expected) !== JSON.stringify(snapshot.files.map(file => file.path).sort())) throw new Error('Source manifest and snapshot differ');
  for (const file of snapshot.files) {
    const data = await readFile(join(root, file.path));
    if (data.length !== file.bytes || hash(data) !== file.sha256) throw new Error(`Snapshot checksum mismatch: ${file.path}`);
    validate(file, data);
  }
  if (JSON.stringify(sources.geodata.files) !== JSON.stringify(snapshot.geodata.files.map(file => file.name))) throw new Error('Geo data manifest and snapshot differ');
  console.log(`Snapshot verified: ${snapshot.files.length} files; ${snapshot.geodata.files.length} Geo data checksums`);
  return snapshot;
}

async function publish(snapshot) {
  const files = snapshot.geodata.files;
  for (const file of files) {
    const data = await readFile(join(cache, file.name));
    if (hash(data) !== file.sha256 || data.length !== file.bytes) throw new Error(`Cached Geo data checksum mismatch: ${file.name}`);
  }
  const tag = `subscription-data-${hash(files.map(file => `${file.name}:${file.sha256}`).join('\n')).slice(0, 20)}`;
  const repo = sources.repository;
  const releases = api(`repos/${repo}/releases?per_page=100`);
  let release = releases.find(release => release.tag_name === tag);
  if (!release) {
    const notes = join(cache, 'notes.md');
    await writeFile(notes, `Subscription Geo data snapshot.\n\nUpstream: ${snapshot.geodata.source}\n\nOriginal files, upstream digests and notices are preserved. See the attached snapshot.json, SHA256SUMS and license files.\n\nResource maintenance: https://github.com/${repo}/tree/main/resources\n`);
    gh('release', 'create', tag, '--repo', repo, '--target', 'main', '--draft', '--title', tag, '--notes-file', notes);
    release = api(`repos/${repo}/releases/tags/${tag}`);
  }
  if (release.draft) {
    await writeFile(join(cache, 'SHA256SUMS'), files.map(file => `${file.sha256}  ${file.name}\n`).join(''));
    const attachments = [...files.map(file => join(cache, file.name)), join(cache, 'SHA256SUMS'), join(root, 'snapshot.json'), join(root, 'README.md'), ...snapshot.files.filter(file => file.kind === 'notice').map(file => join(root, file.path))];
    gh('release', 'upload', tag, ...attachments, '--repo', repo, '--clobber');
    release = api(`repos/${repo}/releases/tags/${tag}`);
  }
  for (const file of files) {
    const asset = release.assets.find(asset => asset.name === file.name);
    if (asset?.digest !== `sha256:${file.sha256}` || asset.size !== file.bytes) throw new Error(`Published asset checksum mismatch: ${file.name}`);
  }
  gh('release', 'edit', tag, '--repo', repo, '--draft=false', '--latest');
  console.log(`Geo data release verified: https://github.com/${repo}/releases/tag/${tag}`);
}

if (process.argv.includes('--check')) await check();
else if (process.argv.includes('--publish-geodata')) await publish(await check());
else await refresh();
