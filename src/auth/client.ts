import { createClient } from '@supabase/supabase-js';
const viteEnv = import.meta.env ?? {};
const url = viteEnv?.VITE_SUPABASE_URL;
const key = viteEnv?.VITE_SUPABASE_PUBLISHABLE_KEY;
export const supabase = url && key ? createClient(url, key, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } }) : null;
export const authRedirect = () => `${window.location.origin}/`;
export function authError(error: unknown) {
  const e = error as { code?: string; message?: string };
  const messages: Record<string,string> = {
    invalid_credentials:'邮箱或密码不正确。', email_not_confirmed:'请先到邮箱完成验证，再登录。',
    over_email_send_rate_limit:'邮件发送过于频繁，请稍后再试。', over_request_rate_limit:'操作过于频繁，请稍后再试。',
    email_address_not_authorized:'当前邮件服务尚未开放此邮箱，请联系管理员配置发信服务。',
    signup_disabled:'暂未开放新用户注册。', weak_password:'密码强度不足，请使用更长的密码。', same_password:'新密码不能与原密码相同。',
  };
  return messages[e?.code || ''] || (e?.message?.includes('fetch') ? '暂时无法连接登录服务，请检查网络后重试。' : '操作未完成，请稍后重试。');
}
