/**
 * The RabbitHole wordmark: "RabbitHole" + the signature orange dot,
 * with the bunny mascot if web/public/bunny.png is present (hidden gracefully if not).
 */
export default function Brand({ size = 'md', bunny = true }: { size?: 'sm' | 'md' | 'lg'; bunny?: boolean }) {
  return (
    <span className={`brand brand-${size}`}>
      {bunny && (
        <img
          src="/bunny.png"
          alt=""
          className="brand-bunny"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      )}
      <span className="wordmark">RabbitHole<span className="dot">.</span></span>
    </span>
  );
}
