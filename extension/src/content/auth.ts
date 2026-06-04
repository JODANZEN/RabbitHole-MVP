/**
 * RabbitHole — extension auth against Supabase (GoTrue REST, no SDK).
 *
 * The session lives in chrome.storage.local (private to the extension, not the page's
 * localStorage). Access tokens are auto-refreshed when near expiry. The publishable
 * (anon) key below is safe to ship client-side by design.
 */

const SUPABASE_URL = 'https://djhqqjropmgdzlexbova.supabase.co';
const SUPABASE_ANON = 'sb_publishable_W07hkv76ArAEBIO70xDiGA_-KMorvhS';
const SESSION_KEY = 'rabbithole_supabase_session';

export interface AuthUser { id: string; email: string; }
interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number;        // unix seconds
  user: AuthUser;
}

function now(): number { return Math.floor(Date.now() / 1000); }

function saveSession(s: Session): Promise<void> {
  return new Promise((res) => chrome.storage.local.set({ [SESSION_KEY]: s }, () => res()));
}
function loadSession(): Promise<Session | null> {
  return new Promise((res) =>
    chrome.storage.local.get(SESSION_KEY, (r) => res(r[SESSION_KEY] || null))
  );
}
export function clearSession(): Promise<void> {
  return new Promise((res) => chrome.storage.local.remove(SESSION_KEY, () => res()));
}

function toSession(data: any): Session {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: now() + (data.expires_in || 3600),
    user: { id: data.user?.id, email: data.user?.email || '' },
  };
}

async function authFetch(path: string, body: object): Promise<any> {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error_description || data.msg || data.error || `Auth error ${resp.status}`);
  }
  return data;
}

export async function signIn(email: string, password: string): Promise<AuthUser> {
  const data = await authFetch('/token?grant_type=password', { email, password });
  const s = toSession(data);
  await saveSession(s);
  return s.user;
}

export async function signUp(email: string, password: string): Promise<{ user: AuthUser | null; needsConfirm: boolean }> {
  const data = await authFetch('/signup', { email, password });
  if (data.access_token) {
    const s = toSession(data);
    await saveSession(s);
    return { user: s.user, needsConfirm: false };
  }
  // Email confirmation is on — no session yet.
  return { user: null, needsConfirm: true };
}

export async function signOut(): Promise<void> {
  await clearSession();
}

/** Returns a valid access token (refreshing if near expiry), or null if signed out. */
export async function getAccessToken(): Promise<string | null> {
  const s = await loadSession();
  if (!s) return null;
  if (s.expires_at - now() > 60) return s.access_token;
  try {
    const data = await authFetch('/token?grant_type=refresh_token', { refresh_token: s.refresh_token });
    const fresh = toSession(data);
    await saveSession(fresh);
    return fresh.access_token;
  } catch {
    await clearSession();
    return null;
  }
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const s = await loadSession();
  return s ? s.user : null;
}
