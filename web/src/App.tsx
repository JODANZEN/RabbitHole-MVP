import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import Login from './pages/Login';
import Onboarding from './pages/Onboarding';
import TeacherDashboard from './pages/TeacherDashboard';
import CourseInsights from './pages/CourseInsights';
import QuizManager from './pages/QuizManager';
import StudentDashboard from './pages/StudentDashboard';
import StudentClass from './pages/StudentClass';

export default function App() {
  const { session, profile, loading } = useAuth();

  if (loading) return <div className="center muted">Loading…</div>;
  if (!session) return <Login />;
  if (!profile?.role) return <Onboarding />;

  return (
    <Routes>
      {profile.role === 'teacher' ? (
        <>
          <Route path="/" element={<TeacherDashboard />} />
          <Route path="/course/:id" element={<CourseInsights />} />
          <Route path="/course/:id/quizzes" element={<QuizManager />} />
        </>
      ) : (
        <>
          <Route path="/" element={<StudentDashboard />} />
          <Route path="/class/:id" element={<StudentClass />} />
          <Route path="/course/:id/quizzes" element={<QuizManager />} />
        </>
      )}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
