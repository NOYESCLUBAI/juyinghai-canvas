import assert from 'node:assert/strict';
import { cloudMediaApi } from '../src/lib/cloudMedia';
import type { CloudRequest } from '../src/projects/cloudLibrary';

const calls: Array<{ path: string; method?: string; isForm?: boolean }> = [];
const request: CloudRequest = async (path, init) => {
  calls.push({ path, method: init?.method, isForm: init?.body instanceof FormData });
  if (path === '/api/media' && init?.method === 'POST') {
    return new Response(JSON.stringify({ assetId: 'asset-1', fileName: '画.png', contentType: 'image/png', url: 'https://cdn.example/signed' }));
  }
  if (path === '/api/media/asset-1') {
    return new Response(JSON.stringify({ assetId: 'asset-1', fileName: '画.png', contentType: 'image/png', url: 'https://cdn.example/signed' }));
  }
  if (path === '/api/projects/project-1/assets') {
    return new Response(JSON.stringify({ assets: [{ projectId: 'project-1', assetId: 'asset-1', kind: 'image', fileName: '画.png', createdAt: '2026-10-19T00:00:00Z' }] }));
  }
  if (path === '/api/media/missing') return new Response(JSON.stringify({ detail: '素材不存在' }), { status: 404 });
  return new Response(JSON.stringify({ deleted: true }));
};
globalThis.fetch = async (url) => {
  assert.equal(String(url), 'https://cdn.example/signed');
  return new Response(new Blob(['png'], { type: 'image/png' }));
};

const media = cloudMediaApi(request);
const id = await media.save(new File(['png'], '画.png', { type: 'image/png' }), 'project-1');
assert.equal(id, 'asset-1');
assert.equal(calls[0].isForm, true);
assert.equal(calls[0].path, '/api/media');
const record = await media.read('asset-1');
assert.equal(record?.fileName, '画.png');
assert.equal(await record?.blob.text(), 'png');
const missing = await media.read('missing');
assert.equal(missing, undefined);
const assets = await media.listProject('project-1');
assert.equal(assets[0].assetId, 'asset-1');
assert.ok(calls.every(call => !String(call.path).includes('api_key')));
console.log('✓ cloud media uploads one file, reads a signed URL, and hides missing assets');
