import { rolldown } from 'rolldown';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const folder = await mkdtemp(join(tmpdir(), 'mjh-agent-'));
try {
  const bundle = await rolldown({ input: process.argv[2] || 'tests/canvasAgent.test.ts', platform: 'node', external: [/^node:/] });
  await bundle.write({ file: join(folder,'tests.mjs'), format: 'esm', codeSplitting: false });
  await bundle.close();
  await import(pathToFileURL(join(folder,'tests.mjs')).href);
} finally { await rm(folder, { recursive:true, force:true }); }
