import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import Brand from '../components/Brand';

export default function Onboarding() {
  const { refreshProfile, signOut } = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  async function pick(role: 'student' | 'teacher') {
    setBusy(role); setErr('');
    try {
      await api.setRole(role, name.trim() || undefined);
      await refreshProfile();
    } catch (e: any) {
      setErr(e.message);
      setBusy(null);
    }
  }

  return (
    <div className="center">
      <div className="card auth-card">
        <Brand size="md" />
        <p className="hero-tagline">How will you use RabbitHole?</p>

        <label>Your name (optional)</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. José" />

        <div className="role-grid">
          <button className="role-btn" disabled={!!busy} onClick={() => pick('student')}>
            <div className="role-emoji">🎓</div>
            <div className="role-title">I'm a student</div>
            <div className="muted small">Study with a tutor that knows my courses</div>
          </button>
          <button className="role-btn" disabled={!!busy} onClick={() => pick('teacher')}>
            <div className="role-emoji">🧑‍🏫</div>
            <div className="role-title">I'm a teacher</div>
            <div className="muted small">See where my class is struggling</div>
          </button>
        </div>

        {err && <p className="msg">{err}</p>}
        <p className="muted small"><a onClick={signOut}>Sign out</a></p>
      </div>
    </div>
  );
}
