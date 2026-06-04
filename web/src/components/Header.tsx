import { useAuth } from '../auth/AuthContext';

export default function Header({ subtitle }: { subtitle?: string }) {
  const { profile, signOut } = useAuth();
  return (
    <header className="app-header">
      <div className="brand small">🐇 <span>RabbitHole</span>{subtitle && <em className="muted"> · {subtitle}</em>}</div>
      <div className="header-right">
        <span className="muted small">{profile?.name || profile?.email} · {profile?.role}</span>
        <button className="btn ghost small" onClick={signOut}>Sign out</button>
      </div>
    </header>
  );
}
