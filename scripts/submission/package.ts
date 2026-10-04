/** Strict public allowlist: the MP4 is delivered separately, never in this ZIP. */
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { args, folders, json, sha256 } from './common.js';
const options = args(process.argv.slice(2), ['--out']);
const { base, publicDir, privateDir } = await folders(options['--out'] ?? 'artifacts/submission');
const files = ['problem-solution.txt', 'architecture.txt', 'architecture.svg', 'architecture.png', 'images/01-input.png', 'images/02-ai-candidate.png', 'images/03-print.png', 'images/04-assembly.png', 'captions.srt', 'youtube-description.txt', 'manifest.json'];
const hashes: Record<string, string> = {};
for (const file of files) hashes[file] = sha256(await readFile(resolve(publicDir, file)));
const dir = resolve(base, 'deliverables'); await mkdir(dir, { recursive: true });
const destination = resolve(dir, 'ugoku-kami-public-assets.zip');
// Build a fresh archive and atomically replace it. A previous archive must not
// retain an accidentally included secret or obsolete member.
const temporary = await mkdtemp(resolve(dir, '.package-'));
try {
  const archive = resolve(temporary, 'assets.zip');
  execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED); [z.write(p,p) for p in sys.argv[2:]]; z.close()', archive, ...files], { cwd: publicDir });
  await rename(archive, destination);
} finally { await rm(temporary, { recursive: true, force: true }); }
await json(resolve(privateDir, 'public-package.json'), { status: 'LOCAL_DRAFT', zipSha256: sha256(await readFile(destination)), files: hashes, excluded: ['demo.mp4 (separate delivery)', 'models', 'fonts', 'private recordings and evidence', 'credentials'], uploaded: false, submitted: false });
console.log(JSON.stringify({ destination, files: files.length, videoIncluded: false, status: 'LOCAL_DRAFT' }));
