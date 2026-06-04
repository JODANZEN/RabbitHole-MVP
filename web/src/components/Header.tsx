import { useAuth } from '../auth/AuthContext';
import Brand from './Brand';

export default function Header({ subtitle }: { subtitle?: string }) {
  const { profile, signOut } = useAuth();
  return (
    <header className="app-header">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Brand size="sm" />
        {subtitle && <span className="tag">{subtitle}</span>}
      </div>
      <div className="header-right">
        <span className="muted small">{profile?.name || profile?.email}</span>
        <button className="btn ghost small" onClick={signOut}>Sign out</button>
      </div>
    </header>
  );
}
