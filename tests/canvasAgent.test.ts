import assert from 'node:assert/strict';
import { localPlan, sanitizeRemotePlan, planCanvasInstruction } from '../src/agent/canvasAgent';
import { applyCanvasPlan, canvasFingerprint } from '../src/agent/applyCanvasPlan';
import { executeCanvasTool, type CanvasToolHost } from '../src/agent/applyTool';
import { cardBaseHash } from '../src/agent/hash';
import { startCanvasAgent, parseJsonToolTurn, type AgentPanelEvent } from '../src/agent/runtime';
import { loadAgentSession, saveAgentSession, AGENT_SESSION_KEY, type AgentUiMessage } from '../src/agent/sessionStore';
import type { CanvasNode, CanvasEdge } from '../src/types';
import type { ModelMessage } from 'ai';
let passed = 0;
const test = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log(`✓ ${name}`); };
const original = '第一句。第二句。第三句。第四句。第五句。';
const nodes: CanvasNode[] = [{id:'source',type:'canvas-card',position:{x:0,y:0},style:{width:290,height:190},selected:true,data:{kind:'text',text:original}}];
let nextId = 0;
const id = () => `new-${++nextId}`;
await test('local split preserves every sentence and links every new card to source', () => {
  const plan=localPlan('拆分成3个分镜',nodes);
  assert.equal(plan.requiresConfirmation,true);
  const result=applyCanvasPlan(plan,nodes,[],{x:400,y:300},id);
  assert.equal(result.nodes.length,4);
  assert.equal(result.nodes[0].data.text,original);
  assert.equal(result.nodes.slice(1).map(n=>n.data.text?.replace(/^### 分镜 \d+\n\n/, '')).join(''),original);
  assert.equal(result.edges.length,3);
  assert.ok(result.edges.every(e=>e.source==='source'));
  assert.equal(nodes.length,1);
});
await test('delete removes related edges without mutating original snapshot', () => {
  const edges: CanvasEdge[]=[{id:'e',source:'source',target:'image'}];
  const other: CanvasNode={id:'image',type:'canvas-card',position:{x:200,y:0},data:{kind:'image'}};
  const result=applyCanvasPlan(localPlan('删除选中卡片',nodes),[...nodes,other],edges,{x:0,y:0},id);
  assert.deepEqual(result.nodes.map(n=>n.id),['image']);
  assert.equal(result.edges.length,0);
  assert.equal(edges.length,1);
});
await test('remote total creation cap applies across actions', () => {
  assert.throws(()=>sanitizeRemotePlan({actions:[{tool:'create_cards',cardType:'text',count:5},{tool:'create_cards',cardType:'image',count:5}]},nodes));
});
await test('unknown IDs and tools reject the entire plan instead of partly applying', () => {
  assert.throws(()=>sanitizeRemotePlan({actions:[{tool:'delete_cards',cardIds:['missing']}]},nodes));
  assert.throws(()=>sanitizeRemotePlan({actions:[{tool:'create_cards',cardType:'text',count:1},{tool:'publish',cardIds:['source']}]},nodes));
});
await test('read-only remote answers are accepted and never require execution', () => {
  const plan=sanitizeRemotePlan({summary:'当前有一张剧本',actions:[]},nodes);
  assert.equal(plan.actions.length,0);
  assert.equal(plan.requiresConfirmation,false);
});
await test('remote confirmation cannot be disabled by model', () => {
  assert.equal(sanitizeRemotePlan({requiresConfirmation:false,actions:[{tool:'delete_cards',cardIds:['source']}]},nodes).requiresConfirmation,true);
});
await test('fingerprint detects content and position edits but ignores selection', () => {
  assert.equal(canvasFingerprint(nodes,[]),canvasFingerprint(nodes.map(n=>({...n,selected:false})),[]));
  assert.notEqual(canvasFingerprint(nodes,[]),canvasFingerprint(nodes.map(n=>({...n,data:{...n.data,text:'changed'}})),[]));
  assert.notEqual(canvasFingerprint(nodes,[]),canvasFingerprint(nodes.map(n=>({...n,position:{x:100,y:0}})),[]));
});
await test('split without a source does not manufacture story cards', () => assert.equal(localPlan('拆分成3个分镜',nodes.map(n=>({...n,selected:false}))).actions.length,0));
await test('API failure is surfaced and cannot become a fallback mutation', async () => {
  const fetchBefore=globalThis.fetch;
  globalThis.fetch=async ()=>new Response(JSON.stringify({detail:'test model unavailable'}),{status:503,headers:{'Content-Type':'application/json'}});
  try { await assert.rejects(()=>planCanvasInstruction('删除选中卡片',nodes),/test model unavailable/); }
  finally { globalThis.fetch=fetchBefore; }
});
await test('local mode never calls API', async () => {
  const fetchBefore=globalThis.fetch;
  globalThis.fetch=async ()=>{throw new Error('Unexpected API call');};
  try {const result=await planCanvasInstruction('创建1张文字卡片',nodes,{mode:'demo'});assert.equal(result.mode,'demo');assert.equal(result.plan.actions.length,1);}
  finally {globalThis.fetch=fetchBefore;}
});

const card = (id: string, text: string, selected = false): CanvasNode => ({id, type:'canvas-card', position:{x:0,y:Number(id.replace(/\D/g,''))||0}, style:{width:290,height:190}, selected, data:{kind:'text', text}});
function memoryCanvas(initial: CanvasNode[], initialEdges: CanvasEdge[] = []) {
  let canvasNodes = initial.map(node => ({...node, data:{...node.data}, position:{...node.position}, style:node.style?{...node.style}:undefined}));
  let canvasEdges = initialEdges.map(edge => ({...edge, data:edge.data?{...edge.data}:undefined}));
  let sequence = 0;
  const host: CanvasToolHost = {
    read: () => ({nodes: canvasNodes, edges: canvasEdges, anchor:{x:80,y:80}}),
    write: (next) => { canvasNodes = next.nodes; canvasEdges = next.edges; },
    select: (ids) => { const chosen = new Set(ids); canvasNodes = canvasNodes.map(node => ({...node, selected:chosen.has(node.id)})); },
    focus: () => undefined,
    createId: () => `made-${++sequence}`,
  };
  return {host, get nodes(){return canvasNodes;}, get edges(){return canvasEdges;}};
}
const completion = (message: Record<string, unknown>) => new Response(JSON.stringify({id:'chatcmpl-test', object:'chat.completion', choices:[{index:0, finish_reason:message.tool_calls?'tool_calls':'stop', message}]}), {status:200, headers:{'Content-Type':'application/json'}});
const toolCall = (id: string, name: string, args: unknown) => ({role:'assistant', content:null, tool_calls:[{id, type:'function', function:{name, arguments:JSON.stringify(args)}}]});
const until = async (check: () => boolean) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 4000) throw new Error('timed out waiting for agent');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

await test('stale baseHash does not overwrite a card the user edited', async () => {
  const board = memoryCanvas([card('c3','原文第三张',true)]);
  const hash = cardBaseHash(board.nodes[0]);
  let calls = 0;
  const handle = startCanvasAgent({
    instruction:'把第三张改成新的分镜',
    host: board.host,
    fetch: async () => {
      calls += 1;
      if (calls === 1) return completion(toolCall('read-1','read_cards',{cardIds:['c3']}));
      if (calls === 2) {
        board.nodes[0].data.text = '用户刚改的文字';
        return completion(toolCall('write-1','update_text',{updates:[{cardId:'c3', baseHash:hash, text:'模型想覆盖的文字'}]}));
      }
      return completion({role:'assistant', content:'没法写入'});
    },
  });
  const result = await handle.done;
  assert.equal(board.nodes[0].data.text, '用户刚改的文字');
  assert.equal(result.reason, 'finish');
  assert.match(result.summary, /没法写入|已完成/);
});

await test('unknown tools leave the canvas unchanged and stop after two', async () => {
  const board = memoryCanvas([card('c3','原文')]);
  const before = canvasFingerprint(board.nodes, board.edges);
  let calls = 0;
  const handle = startCanvasAgent({
    instruction:'发布出去',
    host: board.host,
    fetch: async () => {
      calls += 1;
      return completion(toolCall(`bad-${calls}`, calls === 1 ? 'publish' : 'explode', {}));
    },
  });
  const result = await handle.done;
  assert.equal(calls, 2);
  assert.equal(canvasFingerprint(board.nodes, board.edges), before);
  assert.equal(result.reason, 'unknown-tool');
});

await test('delete approval cannot be skipped by requiresConfirmation false', async () => {
  const board = memoryCanvas([card('c3','要删除',true)]);
  const events: AgentPanelEvent[] = [];
  let calls = 0;
  const handle = startCanvasAgent({
    instruction:'删除选中的卡片',
    host: board.host,
    onEvent: (event) => events.push(event),
    fetch: async () => {
      calls += 1;
      if (calls === 1) return completion(toolCall('del-1','delete_cards',{cards:[{cardId:'c3', baseHash:cardBaseHash(board.nodes[0])}], requiresConfirmation:false}));
      return completion({role:'assistant', content:'改为保留'});
    },
  });
  await until(() => events.some(event => event.type === 'approval'));
  assert.equal(board.nodes.length, 1);
  handle.reject(events.find(event => event.type === 'approval')!.approvalId);
  const result = await handle.done;
  assert.equal(board.nodes.length, 1);
  assert.equal(result.wrote, false);
  assert.match(JSON.stringify(result.modelMessages), /user_rejected/);
});

await test('creating nine cards asks for approval and cancel writes nothing', async () => {
  const board = memoryCanvas([]);
  const events: AgentPanelEvent[] = [];
  const handle = startCanvasAgent({
    instruction:'新建九张图片容器',
    host: board.host,
    onEvent: (event) => events.push(event),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.messages.some((message: {role?: string}) => message.role === 'tool')) return completion({role:'assistant', content:'已取消'});
      return completion(toolCall('create-9','create_cards',{cardType:'image', count:9}));
    },
  });
  await until(() => events.some(event => event.type === 'approval'));
  assert.equal(board.nodes.length, 0);
  handle.reject('missing');
  const approval = events.find(event => event.type === 'approval');
  assert.equal(approval?.tool, 'create_cards');
  handle.reject(approval!.approvalId);
  await handle.done;
  assert.equal(board.nodes.length, 0);
});

await test('json fallback executes one tool per turn and rejects two tools at once', async () => {
  const board = memoryCanvas([card('source','第一句。第二句。第三句。',true)]);
  const events: AgentPanelEvent[] = [];
  let turns = 0;
  const handle = startCanvasAgent({
    instruction:'读第 3 张剧本，把它拆成 3 张分镜并排成一行',
    protocol:'json',
    host: board.host,
    onEvent: (event) => events.push(event),
    fetch: async (_url, init) => {
      turns += 1;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tools, undefined);
      const last = JSON.stringify(body.messages.at(-1));
      if (turns === 1) return completion({role:'assistant', content:JSON.stringify({tool:'read_cards', arguments:{cardIds:['source']}})});
      if (last.includes('baseHash') && !last.includes('made-')) return completion({role:'assistant', content:JSON.stringify({tool:'create_cards', arguments:{cardType:'text', texts:['开场','转折','结尾'], referenceIds:['source']}})});
      if (last.includes('createdIds') && last.includes('made-')) {
        const ids = [...new Set(last.match(/made-\d+/g))];
        return completion({role:'assistant', content:JSON.stringify({tool:'arrange_cards', arguments:{cardIds:ids, direction:'horizontal'}})});
      }
      return completion({role:'assistant', content:JSON.stringify({final:'三张分镜已经排成一行'})});
    },
  });
  const result = await handle.done;
  assert.deepEqual(events.filter(event => event.type === 'tool-start').map(event => event.tool), ['read_cards','create_cards','arrange_cards']);
  assert.equal(board.nodes.length, 4);
  assert.equal(board.nodes[0].data.text, '第一句。第二句。第三句。');
  assert.equal(board.edges.filter(edge => edge.source === 'source').length, 3);
  assert.equal(result.reason, 'finish');
  const rejected = memoryCanvas([card('source','原文')]);
  const bad = await startCanvasAgent({
    instruction:'同时做两件事',
    protocol:'json',
    host: rejected.host,
    fetch: async () => completion({role:'assistant', content:'{"tool":"create_cards","arguments":{"cardType":"text","texts":["甲"]}}{"tool":"delete_cards","arguments":{}}'}),
  }).done;
  assert.equal(rejected.nodes.length, 1);
  assert.equal(bad.reason, 'error');
  assert.equal(parseJsonToolTurn('{"final":"好"}').kind, 'final');
});

await test('a 503 keeps cards already written and does not split locally', async () => {
  const board = memoryCanvas([card('source','第一句。第二句。第三句。',true)]);
  let calls = 0;
  const result = await startCanvasAgent({
    instruction:'将选中的剧本拆分成3个分镜',
    host: board.host,
    fetch: async () => {
      calls += 1;
      if (calls === 1) return completion(toolCall('create-1','create_cards',{cardType:'text', texts:['分镜甲','分镜乙','分镜丙'], referenceIds:['source']}));
      return new Response(JSON.stringify({error:{message:'upstream secret'}}), {status:503, headers:{'Content-Type':'application/json'}});
    },
  }).done;
  assert.equal(board.nodes.length, 4);
  assert.equal(result.reason, 'error');
  assert.match(result.summary, /没有改用本地规则/);
  assert.equal(board.nodes.filter(node => node.data.text?.includes('### 分镜')).length, 0);
});

await test('stop aborts the in-flight request and prevents later writes', async () => {
  const board = memoryCanvas([card('source','原文')]);
  const controller = new AbortController();
  let releaseSecond: () => void = () => undefined;
  const secondStarted = new Promise<void>(resolve => { releaseSecond = resolve; });
  let calls = 0;
  const handle = startCanvasAgent({
    instruction:'继续加卡片',
    host: board.host,
    signal: controller.signal,
    fetch: async (_url, init) => {
      calls += 1;
      if (calls === 1) return completion(toolCall('create-1','create_cards',{cardType:'text', texts:['先写这一张']}));
      releaseSecond();
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (init?.signal?.aborted) abort();
        init?.signal?.addEventListener('abort', abort, {once:true});
      });
    },
  });
  await secondStarted;
  assert.equal(board.nodes.length, 2);
  controller.abort();
  const result = await handle.done;
  assert.equal(result.reason, 'abort');
  assert.equal(board.nodes.length, 2);
  assert.equal(calls, 2);
});

await test('search updates a card beyond the first forty', async () => {
  const initial = Array.from({length:45}, (_, index) => card(`c${index + 1}`, index === 44 ? '藏在第四十五张里的句子' : `普通卡片 ${index + 1}`));
  const board = memoryCanvas(initial);
  let calls = 0;
  const result = await startCanvasAgent({
    instruction:'找到藏在第四十五张里的句子并改成已找到',
    host: board.host,
    fetch: async (_url, init) => {
      calls += 1;
      const url = String(_url);
      assert.match(url, /^http:\/\/127\.0\.0\.1:3012\/api\/agent\/chat\/completions$/);
      assert.equal(url.includes('vercel'), false);
      assert.equal(url.includes('agnes'), false);
      const body = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), null);
      if (calls === 1) return completion(toolCall('search-1','search_cards',{query:'第四十五'}));
      if (calls === 2) return completion(toolCall('read-45','read_cards',{cardIds:['c45']}));
      if (calls === 3) {
        const raw = String(init?.body);
        const hash = raw.match(/baseHash\\":\\"([0-9a-f]+)/)?.[1] || raw.match(/"baseHash":"([0-9a-f]+)"/)?.[1];
        return completion(toolCall('write-45','update_text',{updates:[{cardId:'c45', baseHash:hash, text:'已找到'}]}));
      }
      return completion(toolCall('done','finish',{summary:'第 45 张已经改好'}));
    },
  }).done;
  assert.equal(board.nodes.length, 45);
  assert.equal(board.nodes.find(node => node.id === 'c45')?.data.text, '已找到');
  assert.equal(board.nodes.find(node => node.id === 'c1')?.data.text, '普通卡片 1');
  assert.equal(result.reason, 'finish');
  assert.match(result.summary, /第 45 张/);
});

await test('propose_generation never calls image or video APIs', async () => {
  const board = memoryCanvas([card('shot','少年站在雨里')]);
  const urls: string[] = [];
  const events: AgentPanelEvent[] = [];
  const handle = startCanvasAgent({
    instruction:'给这张卡提案一张图，但不要真的生成',
    host: board.host,
    onEvent: (event) => events.push(event),
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).includes('/api/images/generate') || String(url).includes('/api/videos/generate')) throw new Error('generation endpoint was called');
      if (!events.some(event => event.type === 'approval')) {
        return completion(toolCall('proposal','propose_generation',{kind:'image', targetId:'shot', baseHash:cardBaseHash(board.nodes[0]), prompt:'雨中的少年，中景', aspectRatio:'16:9', resolution:'1K'}));
      }
      return completion({role:'assistant', content:'提案已记下，尚未生成'});
    },
  });
  await until(() => events.some(event => event.type === 'approval'));
  assert.equal(board.nodes[0].data.pendingGeneration, undefined);
  handle.approve(events.find(event => event.type === 'approval')!.approvalId);
  const result = await handle.done;
  assert.equal(board.nodes[0].data.pendingGeneration?.prompt, '雨中的少年，中景');
  assert.equal(board.nodes[0].data.pendingGeneration?.kind, 'image');
  assert.equal(urls.some(url => url.includes('/images/generate') || url.includes('/videos/generate')), false);
  assert.match(result.summary, /尚未生成/);
});

await test('direct tool conflict, duplicate edges, and run snapshot restore', () => {
  const board = memoryCanvas([card('source','原文')], [{id:'e', source:'source', target:'source', data:{relation:'sequence'}}]);
  const ctx = {host:board.host, permission:'balanced' as const, instruction:'修改', createsThisRun:0, shortByReal:new Map<string,string>(), realByShort:new Map<string,string>(), nextShort:0};
  const stale = executeCanvasTool('update_text', {updates:[{cardId:'source', baseHash:'00000000', text:'不会写上'}]}, ctx);
  assert.equal(stale.observation.ok, false);
  assert.equal(stale.wrote, false);
  assert.equal(board.nodes[0].data.text, '原文');
  const before = {nodes:board.nodes.map(node => ({...node, data:{...node.data}})), edges:board.edges.map(edge => ({...edge}))};
  const copied = executeCanvasTool('duplicate_cards', {cardIds:['source']}, ctx);
  assert.equal(copied.wrote, true);
  assert.equal(board.edges.some(edge => edge.source === 'made-1' || edge.target === 'made-1'), true);
  board.host.write(before);
  assert.equal(board.nodes.length, 1);
  assert.equal(canvasFingerprint(board.nodes, board.edges), canvasFingerprint(before.nodes, before.edges));
});

await test('sessions survive per canvas, drop data URIs, cap history, and report storage failure', () => {
  const values = new Map<string, string>();
  const storage = {getItem:(key: string) => values.get(key) ?? null, setItem:(key: string, value: string) => { values.set(key, value); }};
  const longTool = '字'.repeat(5000);
  const messages: AgentUiMessage[] = Array.from({length:50}, (_, index) => ({id:`m${index}`, role:index % 2 ? 'assistant' : 'user', text:`消息 ${index} ${longTool}`}));
  const modelMessages = [{role:'tool', content:[{type:'text', text:`data:image/png;base64,${'A'.repeat(80)} ${longTool}`}]}] as ModelMessage[];
  assert.equal(saveAgentSession(storage, {projectId:'p', canvasId:'a', updatedAt:'', messages, modelMessages}).ok, true);
  assert.equal(saveAgentSession(storage, {projectId:'p', canvasId:'b', updatedAt:'', messages:[{id:'only-b', role:'user', text:'只在乙分集'}], modelMessages:[]}).ok, true);
  const first = loadAgentSession(storage, 'p', 'a');
  const second = loadAgentSession(storage, 'p', 'b');
  assert.equal(first?.messages.length, 40);
  assert.equal(first?.messages.some(message => message.text.includes('data:image')), false);
  assert.equal(JSON.stringify(first?.modelMessages).includes('data:image'), false);
  assert.ok((first?.messages.at(-1)?.text.length || 0) <= 4001);
  assert.equal(second?.messages[0].text, '只在乙分集');
  assert.equal(values.has('mjh.projects.v1'), false);
  assert.deepEqual([...values.keys()], [AGENT_SESSION_KEY]);
  const failing = {getItem:() => null, setItem:() => { throw new Error('quota'); }};
  assert.deepEqual(saveAgentSession(failing, {projectId:'p', canvasId:'a', updatedAt:'', messages, modelMessages:[]}), {ok:false, message:'对话未能保存'});
});

console.log(`${passed} agent checks passed`);
