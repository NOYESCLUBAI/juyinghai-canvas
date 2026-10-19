import { accountStorage, getAccountScope } from "../auth/accountStorage";
import { cloudActive } from "../lib/hosted";
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { SavedProject } from '../types';
import { cleanProject, copyProject, newProject, readLibrary, writeLibrary, type ProjectLibrary } from './projectStore';
import { loadCloudLibrary, saveCloudLibrary } from './cloudLibrary';
import { ProjectHome } from './ProjectHome';
import './projects.css';
import { ProjectAssetsProvider } from '../assets/ProjectAssets';

export type WorkspaceProps = {
  projectId: string;
  initialProject: SavedProject;
  onSave: (project: SavedProject) => void;
  onHome: () => void;
  registerExit: (guard: (() => boolean) | null) => void;
};
function routeProject() {
  const match = /^#\/project\/([^/]+)$/.exec(window.location.hash);
  return match?.[1] || null;
}
export function ProjectManager({ legacy, Workspace }: { legacy: () => SavedProject; Workspace: ComponentType<WorkspaceProps> }) {
  const cloud = cloudActive();
  const [booting, setBooting] = useState(cloud);
  const [loaded] = useState(() => {
    if (cloud) return { library: null as ProjectLibrary | null, error: '' };
    try { return { library: readLibrary(accountStorage, getAccountScope() ? () => newProject("未命名项目").project : legacy), error: '' }; }
    catch (error) { return { library: null, error: error instanceof Error ? error.message : '项目读取失败，原数据已保留。' }; }
  });
  const [library, setLibrary] = useState<ProjectLibrary | null>(loaded.library);
  const libraryRef = useRef(library);
  const saveGeneration = useRef(0);
  const [error, setError] = useState(loaded.error);
  const [projectId, setProjectId] = useState(routeProject);
  const routeRef = useRef(projectId);
  const exitRef = useRef<(() => boolean) | null>(null);
  const registerExit = useCallback((guard: (() => boolean) | null) => { exitRef.current = guard; }, []);
  const commit = useCallback((next: ProjectLibrary) => {
    if (cloud) {
      const previous = libraryRef.current;
      const token = ++saveGeneration.current;
      libraryRef.current = next;
      setLibrary(next);
      setError('');
      void saveCloudLibrary(next).then(saved => {
        if (token !== saveGeneration.current) return;
        libraryRef.current = saved;
        setLibrary(saved);
      }).catch(() => {
        if (token !== saveGeneration.current) return;
        libraryRef.current = previous;
        setLibrary(previous);
        setError('云端保存失败，操作尚未生效。请检查网络后重试。');
      });
      return;
    }
    writeLibrary(accountStorage, next);
    libraryRef.current = next;
    setLibrary(next);
    setError('');
  }, [cloud]);
  const attempt = (change: (current: ProjectLibrary) => ProjectLibrary) => {
    if (!libraryRef.current) return false;
    try {
      const current = cloud ? libraryRef.current : readLibrary(accountStorage, getAccountScope() ? () => newProject("未命名项目").project : legacy);
      commit(change(current));
      return true;
    }
    catch { setError('保存失败，操作尚未生效。请检查浏览器存储空间后重试。'); return false; }
  };
  useEffect(() => {
    if (!cloud) return;
    let live = true;
    loadCloudLibrary().then(next => {
      if (!live) return;
      libraryRef.current = next;
      setLibrary(next);
      setBooting(false);
    }).catch(loadError => {
      if (!live) return;
      setError(loadError instanceof Error ? loadError.message : '云端项目读取失败');
      setBooting(false);
    });
    return () => { live = false; };
  }, [cloud]);
  const goHome = useCallback(() => {
    if (exitRef.current && !exitRef.current()) return;
    window.location.hash = '/projects';
    routeRef.current = null;
    setProjectId(null);
  }, []);
  useEffect(() => {
    const navigate = () => {
      const target = routeProject();
      if (target === routeRef.current) return;
      if (exitRef.current && !exitRef.current()) {
        history.replaceState(null, '', routeRef.current ? `#/project/${routeRef.current}` : '#/projects');
        return;
      }
      routeRef.current = target;
      setProjectId(target);
    };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  const saveProject = useCallback((project: SavedProject) => {
    const current = cloud ? libraryRef.current : readLibrary(accountStorage, getAccountScope() ? () => newProject("未命名项目").project : legacy);
    if (!current || !projectId) throw new Error('未找到当前项目');
    const entry = current.projects.find(item => item.id === projectId);
    if (!entry || entry.trashedAt) throw new Error("项目已被移入回收站，暂时无法保存。");
    const next = cleanProject(project);
    commit({ ...current, projects: current.projects.map(entry => entry.id === projectId ? {
      ...entry, project: next, updatedAt: new Date().toISOString(),
    } : entry) });
  }, [cloud, commit, projectId, legacy]);
  const openProject = (id: string) => {
    if (exitRef.current && !exitRef.current()) return;
    if (!attempt(current => ({...current,lastOpenedProjectId:id,projects:current.projects.map(entry => entry.id === id ? {...entry,lastOpenedAt:new Date().toISOString()} : entry)}))) return;
    routeRef.current = id;
    setProjectId(id);
    window.location.hash = `/project/${id}`;
  };
  if (booting) return <main className="auth-loading">正在读取云端项目…</main>;
  if (!library) return <main className="project-load-error"><h1>暂时无法读取项目</h1><p role="alert">{error}</p><button onClick={() => window.location.reload()}>重新读取</button></main>;
  const active = library.projects.find(entry => entry.id === projectId && !entry.trashedAt);
  if (active) return <ReactFlowProvider key={active.id}><ProjectAssetsProvider projectId={active.id} project={active.project}><Workspace projectId={active.id} initialProject={active.project} onSave={saveProject} onHome={goHome} registerExit={registerExit}/></ProjectAssetsProvider></ReactFlowProvider>;
  return <ProjectHome storageLabel={cloud ? '云端保存' : '本机保存'} onImport={entry => { const current = cloud ? libraryRef.current : readLibrary(accountStorage, legacy); if (!current) return; commit({...current, projects:[...current.projects,entry]}); }} library={library} error={error} onOpen={openProject}
    onCreate={title => {
      const entry = newProject(title);
      if (!attempt(current => ({...current,projects:[...current.projects,entry]}))) return false;
      openProject(entry.id);
      return true;
    }}
    onRename={(id,title) => attempt(current => ({...current,projects:current.projects.map(entry => entry.id === id ? {...entry,updatedAt:new Date().toISOString(),project:{...entry.project,projectTitle:title}} : entry)}))}
    onCopy={id => attempt(current => {
      const source = current.projects.find(entry => entry.id === id);
      return source ? {...current,projects:[...current.projects,copyProject(source)]} : current;
    })}
    onFavorite={id => attempt(current => ({...current,projects:current.projects.map(entry => entry.id === id ? {...entry,favorite:!entry.favorite} : entry)}))}
    onTrash={id => attempt(current => ({...current,projects:current.projects.map(entry => entry.id === id ? {...entry,trashedAt:new Date().toISOString()} : entry)}))}
    onRestore={id => attempt(current => ({...current,projects:current.projects.map(entry => entry.id === id ? {...entry,trashedAt:undefined} : entry)}))}
    onCover={(id,coverAssetId) => attempt(current => ({...current,projects:current.projects.map(entry => entry.id === id ? {...entry,coverAssetId} : entry)}))}
  />;
}
