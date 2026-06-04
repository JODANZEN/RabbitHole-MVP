import { supabase } from './supabase';

const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || 'http://127.0.0.1:8000';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BACKEND + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(await authHeaders()),
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new Error(`Can't reach the backend at ${BACKEND}. Is it running?`);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export interface Profile { id: string; email: string; name: string; role: string; }
export interface Course { id: string; name: string; reading_count: number; processed?: any; }
export interface Insights {
  course: { id: string; name: string };
  question_count: number;
  recent: { question: string; created_at: string }[];
  themes: { topic: string; why: string; count: number }[];
}

export const api = {
  me:          ()                         => request<Profile>('/me'),
  setRole:     (role: string, name?: string) => request<Profile>('/me', { method: 'POST', body: JSON.stringify({ role, name }) }),
  myCourses:   ()                         => request<{ courses: Course[] }>('/me/courses'),
  allCourses:  ()                         => request<{ courses: Course[] }>('/courses'),
  createCourse:(name: string, syllabus: string) => request<Course>('/courses', { method: 'POST', body: JSON.stringify({ name, syllabus }) }),
  insights:    (courseId: string)         => request<Insights>(`/courses/${courseId}/insights`),
};
