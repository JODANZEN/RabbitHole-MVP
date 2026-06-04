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
export interface Course { id: string; name: string; reading_count: number; join_code?: string; processed?: any; }
export interface Insights {
  course: { id: string; name: string };
  question_count: number;
  recent: { question: string; created_at: string }[];
  themes: { topic: string; why: string; count: number }[];
}
export interface Member {
  enrollment_id: string;
  status: string;
  student: { id: string; name: string; email: string };
  requested_at: string;
}
export interface Roster {
  course: { id: string; name: string; join_code: string };
  pending: Member[];
  active: Member[];
}
export interface Enrollment {
  enrollment_id: string;
  status: string;
  course: { id: string; name: string; reading_count: number };
}
export interface QuizQuestion { id?: string; prompt: string; options: string[]; correct_index: number; explanation: string; }
export interface Quiz { id: string; course_id: string; topic: string; week?: number | null; status: string; questions: QuizQuestion[]; }
export interface QuizSummary { id: string; topic: string; week?: number | null; status: string; question_count: number; created_at: string; }

export const api = {
  me:          ()                         => request<Profile>('/me'),
  setRole:     (role: string, name?: string) => request<Profile>('/me', { method: 'POST', body: JSON.stringify({ role, name }) }),
  myCourses:   ()                         => request<{ courses: Course[] }>('/me/courses'),
  allCourses:  ()                         => request<{ courses: Course[] }>('/courses'),
  createCourse:(name: string, syllabus: string) => request<Course>('/courses', { method: 'POST', body: JSON.stringify({ name, syllabus }) }),
  insights:    (courseId: string)         => request<Insights>(`/courses/${courseId}/insights`),
  // enrollment
  enroll:      (joinCode: string)         => request<{ status: string; course: { id: string; name: string } }>('/enroll', { method: 'POST', body: JSON.stringify({ join_code: joinCode }) }),
  myEnrollments: ()                       => request<{ enrollments: Enrollment[] }>('/me/enrollments'),
  roster:      (courseId: string)         => request<Roster>(`/courses/${courseId}/roster`),
  decide:      (enrollmentId: string, status: 'active' | 'rejected') => request<{ status: string }>(`/enrollments/${enrollmentId}/decision`, { method: 'POST', body: JSON.stringify({ status }) }),
  // course detail + material
  getCourse:   (courseId: string)         => request<Course>(`/courses/${courseId}`),
  addReading:  (courseId: string, title: string, text: string) => request<{ chunks: number }>(`/courses/${courseId}/readings`, { method: 'POST', body: JSON.stringify({ title, text }) }),
  // quizzes
  genQuiz:     (courseId: string, topic: string, week?: number | null, n?: number) => request<Quiz>(`/courses/${courseId}/quizzes/generate`, { method: 'POST', body: JSON.stringify({ topic, week, num_questions: n }) }),
  listQuizzes: (courseId: string)         => request<{ quizzes: QuizSummary[] }>(`/courses/${courseId}/quizzes`),
  getQuiz:     (quizId: string)           => request<Quiz>(`/quizzes/${quizId}`),
  updateQuiz:  (quizId: string, questions: QuizQuestion[] | null, status?: string) => request<Quiz>(`/quizzes/${quizId}`, { method: 'PUT', body: JSON.stringify({ questions, status }) }),
  deleteQuiz:  (quizId: string)           => request<{ status: string }>(`/quizzes/${quizId}`, { method: 'DELETE' }),
};
