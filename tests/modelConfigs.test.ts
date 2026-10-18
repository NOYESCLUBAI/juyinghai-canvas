import assert from 'node:assert/strict';
import { loadModelCatalog, modelRequest, saveModelSelection, modelLabel, type ModelCatalog } from '../src/lib/modelConfigs';
const storage = new Map<string,string>();
Object.assign(globalThis, { localStorage: { getItem: (k:string) => storage.get(k) ?? null, setItem: (k:string,v:string) => storage.set(k,v) } });
const catalog: ModelCatalog = {
  configs: [
    { id:'builtin:text:existing', model:'existing', name:'existing', kind:'text', protocol:'chat', base_url:'https://api.example/v1', builtin:true, configured:true, pricing:'' },
    { id:'custom:one', model:'same-model', name:'我的服务一', kind:'text', protocol:'chat', base_url:'https://one.example/v1', builtin:false, configured:true, pricing:'' },
    { id:'custom:two', model:'same-model', name:'我的服务二', kind:'text', protocol:'chat', base_url:'https://two.example/v1', builtin:false, configured:true, pricing:'' },
  ], agnes: {base_url:'https://api.example/v1', configured:true}, defaults:{text:'existing', image:'', video:''}
};
globalThis.fetch = async () => new Response(JSON.stringify(catalog));
const legacy = {text:'existing',image:'',video:''};
await loadModelCatalog(legacy);
assert.equal(modelRequest('text').model_config_id, 'builtin:text:existing');
saveModelSelection('text','custom:two');
assert.equal(modelRequest('text').model_config_id, 'custom:two');
assert.equal(modelRequest('text').model, 'same-model');
assert.equal(modelLabel('custom:two'), '我的服务二 · same-model');
await loadModelCatalog(legacy);
assert.equal(modelRequest('text').model_config_id, 'custom:two');
catalog.configs = catalog.configs.filter(c=>c.id!=='custom:two');
await loadModelCatalog(legacy);
assert.throws(()=>modelRequest('text'), /选择模型/);
assert.throws(()=>modelRequest('text','custom:two'), /已删除/);
assert.ok(!JSON.stringify([...storage.values()]).includes('api_key'));
console.log('✓ legacy selection migration, duplicate model IDs, persistence, deletion without fallback, secret-free selection storage');

// Every generation entry point must carry the selected configuration, including optimizers.
import { generateTextForCard } from '../src/lib/textWriter';
import { optimizeImagePrompt, generateImages, DEFAULT_IMAGE_SETTINGS } from '../src/lib/imageWriter';
import { optimizeVideoPrompt, generateVideo, DEFAULT_VIDEO_SETTINGS } from '../src/lib/videoWriter';
assert.equal(DEFAULT_IMAGE_SETTINGS.model, 'agnes-image-2.5-flash');
assert.equal(DEFAULT_VIDEO_SETTINGS.model, 'agnes-video-2.5-flash');
catalog.configs.push(
  {id:'custom:image',name:'图片连接',model:'same-image',kind:'image',protocol:'openai-image',base_url:'https://image.example/v1',builtin:false,configured:true,pricing:''},
  {id:'custom:video',name:'视频连接',model:'agnes-video-v2.0',kind:'video',protocol:'agnes-video',base_url:'https://video.example/v1',builtin:false,configured:true,pricing:''},
);
await loadModelCatalog(legacy);
saveModelSelection('text','custom:one');
saveModelSelection('image','custom:image');
saveModelSelection('video','custom:video');
const requests: Array<{url:string; body:Record<string,unknown>}> = [];
globalThis.fetch = async (url, options) => {
  requests.push({url:String(url),body:JSON.parse(String(options?.body))});
  if(String(url).includes('/videos/')) return new Response(new Blob(['video'], {type:'video/mp4'}), {headers:{'Content-Type':'video/mp4'}});
  if(String(url).includes('/images/')) return new Response(JSON.stringify({images:[{data_url:'data:image/png;base64,aW1hZ2U='}],model:'same-image'}));
  return new Response(JSON.stringify({text:'测试文字',model:'same-model'}));
};
await generateTextForCard('写一句话','','custom:one');
await optimizeImagePrompt('天空');
await optimizeVideoPrompt('天空');
await generateImages('天空',{...DEFAULT_IMAGE_SETTINGS,model:'custom:image'},[]);
await generateVideo('天空',{...DEFAULT_VIDEO_SETTINGS,model:'custom:video'});
assert.deepEqual(requests.map(r=>r.body.model_config_id),['custom:one','custom:one','custom:one','custom:image','custom:video']);
assert.ok(requests.every(r=>!('api_key' in r.body)));
console.log('✓ text generation, both prompt optimizers, image generation and video generation route by configuration ID');
