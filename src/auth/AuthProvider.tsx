import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { ArrowRight, Clapperboard, FileText, Image, UserRound, X, LogOut, Settings, Download } from 'lucide-react';
import { supabase, authError, authRedirect } from './client';
import { setAccountScope } from './accountStorage';
import { importLocalLibrary } from './importLocalLibrary';
import './auth.css';
const ANIMAL_AVATARS = ['🐱', '🐶', '🐼', '🦊', '🐰', '🐻'];
const animalAvatar = (value: unknown) => typeof value === 'string' && ANIMAL_AVATARS.includes(value) ? value : ANIMAL_AVATARS[0];
type AuthContextValue = { user: User | null; openLogin: () => void; openProfile: () => void };
const AuthContext = createContext<AuthContextValue>({user:null,openLogin:()=>{},openProfile:()=>{}});
export function AccountButton() {
  const {user,openLogin,openProfile} = useContext(AuthContext);
  const nickname = typeof user?.user_metadata.nickname === 'string' ? user.user_metadata.nickname.trim() : '';
  const displayName = nickname || user?.email?.split('@')[0] || '创作者';
  return <button type="button" className="account-trigger" aria-label={user ? '个人中心' : '登录 / 注册'} onClick={user ? openProfile : openLogin}><span className="account-avatar">{user ? animalAvatar(user.user_metadata.avatar) : <UserRound size={18}/>}</span><span>{user ? displayName : '登录 / 注册'}</span></button>;
}
export function AuthProvider({children}:{children:ReactNode}) {
  const [user,setUser] = useState<User|null>(null);
  const [ready,setReady] = useState(false);
  const [mode,setMode] = useState<'login'|'register'|'forgot'|'recovery'|null>(null);
  const [profile,setProfile] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [busy,setBusy] = useState(false);
  const [email,setEmail] = useState('');
  const [password,setPassword] = useState('');
  const [repeat,setRepeat] = useState('');
  const [oldPassword,setOldPassword] = useState('');
  const [nickname,setNickname] = useState('');
  const [avatar,setAvatar] = useState(ANIMAL_AVATARS[0]);
  const scope = useRef<string|null|undefined>(undefined);
  const dialog = useRef<HTMLDialogElement>(null);
  const changeMode = (next:typeof mode) => {setError('');setNotice('');setPassword('');setRepeat('');setMode(next);};
  useEffect(() => {
    if (!supabase) {setReady(true);return;}
    let live=true;
    const apply = (next:User|null,recovery=false) => {
      if (!live) return;
      if (scope.current !== undefined && scope.current !== (next?.id || null)) {
        // A full remount also cancels outstanding canvas/media operations from the previous account.
        const target = new URL(window.location.pathname + (recovery ? '?recovery=1' : '') + '#/projects', window.location.origin);
        if (target.pathname === window.location.pathname && target.search === window.location.search) {
          // Hash-only navigation does not reload the provider or reset account-scoped stores.
          window.history.replaceState(null, '', target.href);
          window.location.reload();
        } else {
          window.location.replace(target.href);
        }
        return;
      }
      scope.current=next?.id || null;setAccountScope(scope.current);setUser(next);setReady(true);
      if (recovery || (next && new URLSearchParams(window.location.search).has('recovery'))) setMode('recovery');
    };
    const {data:{subscription}}=supabase.auth.onAuthStateChange((event,session)=>apply(session?.user || null,event==='PASSWORD_RECOVERY'));
    void supabase.auth.getSession().then(({data,error})=>{if(!live)return;if(error)setError(authError(error));if(scope.current===undefined)apply(data.session?.user||null);}).catch(()=>{if(live){setError('登录状态读取失败，请刷新重试。');setReady(true);}});
    return ()=>{live=false;subscription.unsubscribe();};
  },[]);
  useEffect(()=>{if(mode || profile){dialog.current?.showModal();}else dialog.current?.close();},[mode,profile]);
  const close = () => {if(busy)return;setMode(null);setProfile(false);setError('');setNotice('');setPassword('');setRepeat('');setOldPassword('');};
  const perform = async (task:()=>Promise<void>) => {if(busy)return;setBusy(true);setError('');setNotice('');try{await task();}catch(e){setError(authError(e));}finally{setBusy(false);}};
  const submit = (event:FormEvent) => {
    event.preventDefault();if(!supabase){setError('登录服务尚未配置。');return;}
    if((mode==='register'||mode==='recovery')&&password!==repeat){setError('两次输入的密码不一致。');return;}
    void perform(async()=>{
      if(mode==='login'){const {error}=await supabase!.auth.signInWithPassword({email:email.trim(),password});if(error)throw error;setMode(null);}
      if(mode==='register'){const {error}=await supabase!.auth.signUp({email:email.trim(),password,options:{emailRedirectTo:authRedirect(),data:{nickname:nickname.trim()||'创作者',avatar:ANIMAL_AVATARS[0]}}});if(error)throw error;setNotice('请查收验证邮件，完成验证后即可登录。');setPassword('');setRepeat('');}
      if(mode==='forgot'){const {error}=await supabase!.auth.resetPasswordForEmail(email.trim(),{redirectTo:authRedirect()});if(error)throw error;setNotice('如果此邮箱已注册，你会收到重置密码邮件。');}
      if(mode==='recovery'){const {error}=await supabase!.auth.updateUser({password});if(error)throw error;history.replaceState(null,'',window.location.pathname+'#/projects');setMode(null);setPassword('');setRepeat('');}
    });
  };
  const openProfile=()=>{setNickname(user?.user_metadata.nickname||'创作者');setAvatar(animalAvatar(user?.user_metadata.avatar));setPassword('');setRepeat('');setOldPassword('');setError('');setNotice('');setProfile(true);};
  if(!ready)return <main className="auth-loading">正在读取账号…</main>;
  return <AuthContext.Provider value={{user,openLogin:()=>changeMode('login'),openProfile}}>
    {children}
    <dialog ref={dialog} className={`auth-dialog ${profile?'auth-profile':''}`} onCancel={event=>{event.preventDefault();close();}} onClick={event=>{if(event.target===dialog.current)close();}}>
      <button className="auth-close" type="button" aria-label="关闭账号窗口" disabled={busy} onClick={close}><X size={20}/></button>
      {profile && user ? <div className="profile-body"><div className="profile-title"><span className="profile-avatar">{avatar}</span><div><h2>个人中心</h2><p>{user.email}</p></div></div>
        <form onSubmit={event=>{event.preventDefault();void perform(async()=>{const {data,error}=await supabase!.auth.updateUser({data:{nickname:nickname.trim(),avatar}});if(error)throw error;setUser(data.user);setNotice('个人资料已保存。');});}}>
          <label>昵称<input value={nickname} required maxLength={30} onChange={e=>setNickname(e.target.value)}/></label>
          <fieldset><legend>选择头像</legend><div className="avatar-options">{ANIMAL_AVATARS.map(text=><button type="button" aria-label={`头像 ${text}`} aria-pressed={avatar===text} key={text} onClick={()=>setAvatar(text)}>{text}</button>)}</div></fieldset>
          <button className="auth-primary" disabled={busy}>保存资料</button>
        </form>
        <details><summary><Settings size={16}/>修改密码</summary><form onSubmit={event=>{event.preventDefault();if(password!==repeat){setError('两次输入的密码不一致。');return;}void perform(async()=>{const {error}=await supabase!.auth.updateUser({password,current_password:oldPassword});if(error)throw error;setPassword('');setRepeat('');setOldPassword('');setNotice('密码已更新。');});}}>
          <label>当前密码<input type="password" required autoComplete="current-password" value={oldPassword} onChange={e=>setOldPassword(e.target.value)}/></label>
          <label>新密码<input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)}/></label>
          <label>再次输入新密码<input type="password" required minLength={8} autoComplete="new-password" value={repeat} onChange={e=>setRepeat(e.target.value)}/></label>
          <button className="auth-primary" disabled={busy}>更新密码</button></form></details>
        <div className="profile-storage"><strong>本机项目与资产</strong><p>按账号分别保存在当前浏览器，暂未开启跨设备同步。</p><button type="button" disabled={busy} onClick={()=>{if(!window.confirm('将此浏览器原有的本机项目和资产复制到当前账号？原件会保留。'))return;void perform(async()=>{await importLocalLibrary(user.id);window.location.replace('/#/projects');});}}><Download size={16}/>导入原有本机内容</button></div>
        <button className="auth-signout" disabled={busy} onClick={()=>void perform(async()=>{const {error}=await supabase!.auth.signOut({scope:'local'});if(error)throw error;})}><LogOut size={16}/>退出登录</button>
      </div> : <div className="auth-layout"><aside className="auth-story"><img src="/logo-juyinghai.png" alt="剧影海"/><span className="auth-eyebrow">剧影海 · 创作空间</span><h2>让想象，<br/>有迹可循。</h2><p>从一句灵感，到一整个故事。<br/>在同一张画布上，连接文字、图像与影像。</p><div className="auth-story-cards"><FileText/><ArrowRight/><Image/><ArrowRight/><Clapperboard/></div><small>你的下一个故事，从这里开始。</small></aside>
        <form className="auth-form" onSubmit={submit}><span className="auth-eyebrow">欢迎来到剧影海</span><h1>{mode==='register'?'创建你的账号':mode==='forgot'?'找回密码':mode==='recovery'?'设置新密码':'继续你的创作'}</h1><p>{mode==='register'?'用邮箱开启新的创作旅程。':mode==='forgot'?'我们会向你的邮箱发送重置链接。':mode==='recovery'?'输入新密码，重新回到创作。':'登录后进入你的个人创作空间。'}</p>
          {mode==='register'&&<label>昵称<input value={nickname} maxLength={30} required autoComplete="nickname" onChange={e=>setNickname(e.target.value)}/></label>}
          {mode!=='recovery'&&<label>邮箱<input type="email" value={email} required autoComplete="email" placeholder="输入邮箱地址" onChange={e=>setEmail(e.target.value)}/></label>}
          {mode!=='forgot'&&<label>{mode==='recovery'?'新密码':'密码'}<input type="password" value={password} minLength={mode==='login'?undefined:8} required autoComplete={mode==='login'?'current-password':'new-password'} placeholder={mode==='login'?'输入密码':'至少 8 位字符'} onChange={e=>setPassword(e.target.value)}/></label>}
          {(mode==='register'||mode==='recovery')&&<label>确认密码<input type="password" value={repeat} minLength={8} required autoComplete="new-password" onChange={e=>setRepeat(e.target.value)}/></label>}
          {mode==='login'&&<button className="auth-link" type="button" onClick={()=>changeMode('forgot')}>忘记密码？</button>}
          <button className="auth-primary" disabled={busy||!supabase}>{busy?'正在处理…':mode==='register'?'注册':mode==='forgot'?'发送重置邮件':mode==='recovery'?'保存新密码':'登录'}<ArrowRight size={16}/></button>
          {mode!=='recovery'&&<button className="auth-switch" type="button" disabled={busy} onClick={()=>changeMode(mode==='login'?'register':'login')}>{mode==='login'?'还没有账号？注册':'已有账号？返回登录'}</button>}
          <button className="auth-link" type="button" disabled={busy} onClick={close}>继续使用本机画布</button>
        </form></div>}
      {(error||notice)&&<p className={`auth-feedback ${error?'is-error':''}`} role={error?'alert':'status'}>{error||notice}</p>}
    </dialog>
  </AuthContext.Provider>;
}
