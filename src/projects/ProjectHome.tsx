import { exportProject, importProject } from './projectBackup';
import { cloudActive } from '../lib/hosted';
import { SourceFooter } from '../components/SourceFooter';
import { AccountButton } from "../auth/AuthProvider";
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Copy, Folder, ImagePlus, Laptop, MoreHorizontal, Pencil, Plus, Search, Star, Trash2, Undo2, X, FileText, Library } from 'lucide-react';
import { GlobalAssets } from '../assets/GlobalAssets';
import { readMedia } from '../lib/mediaStore';
import type { ProjectEntry, ProjectLibrary } from './projectStore';

function coverId(entry: ProjectEntry) {
  return entry.coverAssetId || entry.project.canvases.flatMap(c => c.nodes).find(n => n.data.kind === 'image' && n.data.assetId)?.data.assetId;
}
export function ProjectCover({ entry }: { entry: ProjectEntry }) {
  const assetId = coverId(entry);
  const [url, setUrl] = useState('');
  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    setUrl('');
    if (assetId) void readMedia(assetId).then(media => {
      if (cancelled || !media) return;
      objectUrl = URL.createObjectURL(media.blob);
      setUrl(objectUrl);
    }).catch(() => {});
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [assetId]);
  const text = entry.project.canvases.flatMap(c => c.nodes).find(n => n.data.kind === 'text' && n.data.text)?.data.text;
  return url ? <img src={url} alt="" onError={() => setUrl('')} /> : <div className="project-cover-fallback" aria-hidden="true"><FileText size={24} strokeWidth={1.3}/>{text ? <p>{text.replace(/[#*_>`]/g, '').slice(0, 150)}</p> : <span>故事，即将开始</span>}</div>;
}

type Props = {
  library: ProjectLibrary;
  error: string;
  storageLabel?: string;
  onImport: (entry: ProjectEntry) => void;
  onOpen: (id: string) => void;
  onCreate: (title: string) => boolean;
  onRename: (id: string, title: string) => boolean;
  onCopy: (id: string) => void;
  onFavorite: (id: string) => void;
  onTrash: (id: string) => void;
  onRestore: (id: string) => void;
  onCover: (id: string, assetId?: string) => boolean;
};
export function ProjectHome(props: Props) {
  const { library } = props;
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupNotice, setBackupNotice] = useState('');
  const backupInput = useRef<HTMLInputElement>(null);
  const backupAction = async (action: () => Promise<void>, success: string) => {
    setBackupBusy(true); setBackupNotice('');
    try { await action(); setBackupNotice(success); }
    catch (e) { setBackupNotice(e instanceof Error ? e.message : '备份操作失败，请重试。'); }
    finally { setBackupBusy(false); }
  };
  const [section, setSection] = useState<'all' | 'favorites' | 'trash' | 'assets'>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('updated');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ type: 'create' | 'rename' | 'cover'; id?: string } | null>(null);
  const [title, setTitle] = useState('');
  const modal = useRef<HTMLDialogElement>(null);
  const active = library.projects.filter(entry => !entry.trashedAt);
  const recent = active.find(entry => entry.id === library.lastOpenedProjectId) || [...active].sort((a,b) => (b.lastOpenedAt || b.updatedAt).localeCompare(a.lastOpenedAt || a.updatedAt))[0];
  const heading = section === 'all' ? '全部项目' : section === 'favorites' ? '收藏' : '回收站';
  const visible = library.projects.filter(entry => {
    if (section === 'trash' ? !entry.trashedAt : !!entry.trashedAt) return false;
    return (section !== 'favorites' || entry.favorite) && entry.project.projectTitle.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }).sort((a,b) => sort === 'name' ? a.project.projectTitle.localeCompare(b.project.projectTitle, 'zh-CN') :
    (sort === 'created' ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt)));
  const coverEntry = library.projects.find(entry => entry.id === dialog?.id);
  const coverNodes = coverEntry?.project.canvases.flatMap(c => c.nodes).filter(n => n.data.kind === 'image' && n.data.assetId) || [];
  useEffect(() => {
    if (dialog) {
      modal.current?.showModal();
      modal.current?.querySelector<HTMLInputElement>("input")?.focus();
    } else modal.current?.close();
  }, [dialog]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest('.project-actions')) setMenuId(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuId(null); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, []);
  function create() { setTitle(''); setDialog({type:'create'}); }
  return <div className="project-home">
    <aside className="home-sidebar">
      <a href="#/projects" className="home-brand" onClick={() => {setSection('all');setQuery('');}}><img src="/logo-manjinhai.png" alt=""/><span>漫金海</span></a>
      <nav aria-label="项目导航">
        {([{id:'all', label:'全部项目', Icon:Folder}, {id:'assets', label:'全局资产', Icon:Library}, {id:'favorites', label:'收藏', Icon:Star}, {id:'trash', label:'回收站', Icon:Trash2}] as const).map(({id,label,Icon}) => <button key={id} type="button" aria-current={section === id ? 'page' : undefined} onClick={() => {setSection(id);setQuery('');setMenuId(null);}}><Icon size={19}/><span>{label}</span></button>)}
      </nav>
      <div className="home-storage"><div className="home-storage-row"><Laptop size={17}/><span>{props.storageLabel || '本机保存'}</span></div><SourceFooter/></div>
    </aside>
    <main className="home-main"><div className="home-account"><button className="backup-import" disabled={backupBusy} onClick={()=>backupInput.current?.click()}>{backupBusy?'正在处理备份…':'导入项目备份'}</button><AccountButton/></div>
      <input ref={backupInput} type="file" accept=".json" hidden aria-label="选择项目备份" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file) void backupAction(()=>importProject(file,props.onImport, cloudActive() ? 512 * 1024 * 1024 : undefined),'已导入独立副本，原有项目保持不变。');}}/>
      {backupNotice && <p role="status">{backupNotice}</p>}
      {section === 'assets' ? <GlobalAssets library={library} onOpenProject={props.onOpen}/> : <>
      <header className="home-heading"><div><h1>{heading}</h1><p>{section === 'all' ? '每一个故事，从这里继续。' : section === 'favorites' ? '把想继续的故事，留在手边。' : '移入这里的项目可以随时恢复。'}</p></div>{section !== 'trash' && <button className="home-primary" onClick={create}><Plus size={18}/>新建项目</button>}</header>
      {props.error && <p className="home-error" role="alert">{props.error}</p>}
      {section === 'all' && recent && !query && <button className="home-resume" onClick={() => props.onOpen(recent.id)}><div className="resume-cover"><ProjectCover entry={recent}/></div><span><small>继续上次创作</small><strong>{recent.project.projectTitle || '未命名项目'}</strong></span><ArrowRight size={20}/></button>}
      <div className="home-toolbar"><label className="home-search"><Search size={18}/><input aria-label="搜索项目" placeholder="搜索项目" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button aria-label="清除搜索" onClick={() => setQuery('')}><X size={15}/></button>}</label><select aria-label="项目排序" value={sort} onChange={e => setSort(e.target.value)}><option value="updated">最近编辑</option><option value="created">创建时间</option><option value="name">项目名称</option></select></div>
      <div className="project-grid">
        {section === 'all' && !query && <button className="project-create-tile" onClick={create}><Plus size={31} strokeWidth={1.4}/><span>新建项目</span></button>}
        {visible.map(entry => <article className="project-tile" key={entry.id} aria-label={`项目：${entry.project.projectTitle}`}>
          <button className="project-open" disabled={!!entry.trashedAt} aria-label={`打开项目：${entry.project.projectTitle}`} onClick={() => props.onOpen(entry.id)}><div className="project-cover"><ProjectCover entry={entry}/></div><strong>{entry.project.projectTitle || '未命名项目'}</strong></button>
          <div className="project-meta"><span>{entry.project.canvases.length} 个画布 · {new Date(entry.updatedAt).toLocaleDateString('zh-CN', {month:'numeric',day:'numeric'})}</span>
            <div className="project-actions">{section === 'trash' ? <button className="project-restore" onClick={() => props.onRestore(entry.id)}><Undo2 size={15}/>恢复</button> : <><button aria-label={entry.favorite ? '取消收藏' : '收藏项目'} aria-pressed={entry.favorite} onClick={() => props.onFavorite(entry.id)}><Star size={17} fill={entry.favorite ? 'currentColor' : 'none'}/></button><button aria-label={`项目操作：${entry.project.projectTitle}`} aria-haspopup="menu" aria-expanded={menuId === entry.id} onClick={() => setMenuId(menuId === entry.id ? null : entry.id)}><MoreHorizontal size={20}/></button></>}
            {menuId === entry.id && <div className="project-menu" role="menu" aria-label="项目操作">
              <button role="menuitem" onClick={() => {setTitle(entry.project.projectTitle);setDialog({type:'rename',id:entry.id});setMenuId(null);}}><Pencil size={15}/>重命名</button>
              <button role="menuitem" disabled={backupBusy} onClick={()=>{setMenuId(null);void backupAction(()=>exportProject(entry),'备份已生成，请保存下载文件。');}}>导出项目备份</button>
              <button role="menuitem" onClick={() => {props.onCopy(entry.id);setMenuId(null);}}><Copy size={15}/>复制项目</button>
              <button role="menuitem" onClick={() => {setDialog({type:'cover',id:entry.id});setMenuId(null);}}><ImagePlus size={15}/>更换封面</button>
              <button role="menuitem" onClick={() => {props.onTrash(entry.id);setMenuId(null);}}><Trash2 size={15}/>移入回收站</button>
            </div>}
          </div></div>
        </article>)}
      </div>
      {!visible.length && !(section === 'all' && !query) && <div className="home-empty"><Folder size={34} strokeWidth={1.2}/><h2>{query ? '没有找到这个项目' : section === 'trash' ? '回收站是空的' : '还没有收藏的项目'}</h2><p>{query ? '试试其他名称。' : section === 'favorites' ? '点击项目上的星标，就能在这里找到它。' : '移入回收站的项目会显示在这里。'}</p></div>}
      </>}
    </main>
    <dialog ref={modal} className="project-dialog" onCancel={() => setDialog(null)} onClick={e => {if(e.target === e.currentTarget) setDialog(null);}}>
      {dialog && <><header><h2>{dialog.type === 'create' ? '新建项目' : dialog.type === 'rename' ? '重命名项目' : '更换封面'}</h2><button aria-label="关闭对话框" onClick={() => setDialog(null)}><X size={20}/></button></header>
      {dialog.type === 'cover' && coverEntry ? <><p>选择项目中的一张图片作为封面。</p><div className="cover-choices"><button onClick={() => {if(props.onCover(coverEntry.id)) setDialog(null);}}>自动选择</button>{Array.from(new Map(coverNodes.map(n => [n.data.assetId!,n])).values()).map(n => <button key={n.data.assetId} aria-label={`选择封面：${n.data.fileName || '图片'}`} onClick={() => {if(props.onCover(coverEntry.id,n.data.assetId)) setDialog(null);}}><ProjectCover entry={{...coverEntry,coverAssetId:n.data.assetId}}/></button>)}</div>{!coverNodes.length && <p>项目里还没有图片，添加图片后即可选择封面。</p>}</> : <form onSubmit={e => {e.preventDefault();if(!title.trim()) return;const ok=dialog.type === 'create' ? props.onCreate(title.trim()) : props.onRename(dialog.id!,title.trim());if(ok) setDialog(null);}}><label>项目名称<input autoFocus required maxLength={80} placeholder="给这个故事起个名字" value={title} onChange={e => setTitle(e.target.value)}/></label>{props.error && <p role="alert">{props.error}</p>}<footer><button type="button" onClick={() => setDialog(null)}>取消</button><button className="home-primary" disabled={!title.trim()}>{dialog.type === 'create' ? '创建并进入' : '保存'}</button></footer></form>}</>}
    </dialog>
  </div>;
}
