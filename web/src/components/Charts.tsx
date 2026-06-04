import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { OverTimePoint, TopicMastery } from '../lib/api';

const ORANGE = '#ff5a1f';
const LINE = '#26262d';
const MUTED = '#82828c';

/** Comprehension-over-time line chart (the mockup's main graph). */
export function ComprehensionChart({ data }: { data: OverTimePoint[] }) {
  if (!data || data.length === 0) {
    return <p className="muted small">No quiz attempts yet — the trend appears once students take quizzes.</p>;
  }
  return (
    <div style={{ width: '100%', height: 240 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 10, right: 16, left: -16, bottom: 0 }}>
          <CartesianGrid stroke={LINE} vertical={false} />
          <XAxis dataKey="period" stroke={MUTED} fontSize={11} tickLine={false} axisLine={{ stroke: LINE }} />
          <YAxis domain={[0, 100]} stroke={MUTED} fontSize={11} tickLine={false} axisLine={false} unit="%" />
          <Tooltip
            contentStyle={{ background: '#15151a', border: `1px solid ${LINE}`, borderRadius: 10, color: '#f4f4f6', fontSize: 12 }}
            labelStyle={{ color: MUTED }}
            formatter={(v: any) => [`${v}%`, 'Comprehension']}
          />
          <Line type="monotone" dataKey="pct" stroke={ORANGE} strokeWidth={3}
            dot={{ fill: ORANGE, r: 4 }} activeDot={{ r: 6 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal mastery bars per topic (weakest first). */
export function TopicMasteryBars({ data }: { data: TopicMastery[] }) {
  if (!data || data.length === 0) {
    return <p className="muted small">No topic data yet.</p>;
  }
  return (
    <div>
      {data.map((t) => {
        const color = t.pct < 60 ? ORANGE : (t.pct < 80 ? '#e6a72c' : '#4caf6a');
        return (
          <div key={t.topic} style={{ marginBottom: 12 }}>
            <div className="row-between" style={{ marginBottom: 4 }}>
              <span style={{ fontSize: 13 }}>{t.topic}</span>
              <span className="small" style={{ color, fontWeight: 700, fontFamily: 'Outfit' }}>{t.pct}%</span>
            </div>
            <div style={{ height: 8, background: LINE, borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ width: `${t.pct}%`, height: '100%', background: color, borderRadius: 6 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
