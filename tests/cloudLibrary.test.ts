import assert from 'node:assert/strict';
import { loadCloudLibrary, saveCloudLibrary, type CloudRequest } from '../src/projects/cloudLibrary';
import { newProject } from '../src/projects/projectStore';

const calls: Array<{ path: string; init?: RequestInit }> = [];
const library = { version: 1 as const, projects: [newProject('云端故事')], lastOpenedProjectId: undefined };
const request: CloudRequest = async (path, init) => {
  calls.push({ path, init });
  if (init?.method === 'PUT') {
    const body = JSON.parse(String(init.body));
    assert.equal(body.version, 1);
    assert.equal(body.projects.length, 1);
    assert.ok(!String(init.body).includes('api_key'));
    assert.ok(!String(init.body).includes('data:image'));
    return new Response(JSON.stringify(body));
  }
  return new Response(JSON.stringify(library));
};

const loaded = await loadCloudLibrary(request);
assert.equal(loaded.projects[0].project.projectTitle, '云端故事');
loaded.projects[0].project.projectTitle = '改名';
const saved = await saveCloudLibrary(loaded, request);
assert.equal(saved.projects[0].project.projectTitle, '改名');
assert.equal(calls[0].path, '/api/library');
assert.equal(calls[1].init?.method, 'PUT');
const denied = await loadCloudLibrary(async () => new Response(JSON.stringify({ detail: '请先登录' }), { status: 401 })).then(() => {
  throw new Error('should fail');
}, error => error);
assert.match(denied.message, /请先登录/);
console.log('✓ cloud library loads, saves project JSON without secrets, and surfaces auth errors');
