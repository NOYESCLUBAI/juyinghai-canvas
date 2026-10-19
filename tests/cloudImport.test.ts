import assert from 'node:assert/strict';
import { copyProjectsForCloud } from '../src/auth/uploadLocalLibrary';
import { newProject, type ProjectEntry } from '../src/projects/projectStore';
import { saveCloudAgentSession, loadCloudAgentSession } from '../src/agent/sessionCloud';

const source = newProject('本机故事');
source.project.canvases[0].nodes = [
  { id: 'text-1', type: 'canvas-card', position: { x: 1, y: 2 }, data: { kind: 'text', text: '原文' } },
  { id: 'image-1', type: 'canvas-card', position: { x: 3, y: 4 }, data: { kind: 'image', assetId: 'old-asset', assetUrl: 'blob:local' } },
];
source.project.canvases[0].edges = [{ id: 'edge-1', source: 'text-1', target: 'image-1' }];
source.coverAssetId = 'old-asset';
const original = structuredClone(source);
const { projects, assetMap } = copyProjectsForCloud({ version: 1, projects: [source] }, () => 'project-new', () => 'asset-new');
const copy = projects[0];
assert.equal(copy.id, 'project-new');
assert.notEqual(copy.id, source.id);
assert.equal(copy.project.projectTitle, '本机故事');
assert.equal(copy.project.canvases[0].nodes[1].data.assetId, 'asset-new');
assert.equal(copy.coverAssetId, 'asset-new');
assert.equal(copy.project.canvases[0].nodes[1].data.assetUrl, undefined);
assert.equal(copy.project.canvases[0].edges?.[0].source, 'text-1');
assert.equal(assetMap.get('old-asset'), 'asset-new');
assert.equal(source.coverAssetId, 'old-asset');
assert.deepEqual(source.project.canvases[0].nodes[1].data, original.project.canvases[0].nodes[1].data);
const trashed: ProjectEntry = { ...newProject('回收'), trashedAt: '2026-10-19T00:00:00Z' };
const skipped = copyProjectsForCloud({ version: 1, projects: [trashed] }, () => 'x', () => 'y');
assert.equal(skipped.projects.length, 0);
console.log('✓ cloud import copies projects with new ids and leaves the local library unchanged');

let savedBody = '';
const request = async (path: string, init?: RequestInit) => {
  if (init?.method === 'PUT') {
    savedBody = String(init.body);
    return new Response(init.body, { status: 200 });
  }
  return new Response(JSON.stringify({ projectId: 'p', canvasId: 'c', messages: [{ role: 'user', content: '你好' }], updatedAt: '2026-10-19T00:00:00Z' }));
};
const loaded = await loadCloudAgentSession('p', 'c', request);
assert.equal(loaded.messages.length, 1);
await saveCloudAgentSession({ projectId: 'p', canvasId: 'c', messages: loaded.messages }, request);
assert.ok(!savedBody.includes('user_id'));
assert.match(savedBody, /你好/);
console.log('✓ agent session cloud adapter round-trips messages without a client-supplied user id');
