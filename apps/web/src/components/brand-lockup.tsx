type BrandLockupProps = {
  compact?: boolean;
  className?: string;
};

export function BrandLockup({ compact = false, className = '' }: BrandLockupProps) {
  return (
    <div className={`brand-lockup ${compact ? 'brand-lockup--compact' : ''} ${className}`.trim()}>
      <img
        className="brand-mark"
        src="/brand/masters-diagnostics-mark.svg"
        alt=""
        width={64}
        height={64}
        aria-hidden="true"
      />
      <span className="brand-copy">
        <span className="brand-name">Masters Diagnostics</span>
        {!compact && (
          <span className="brand-tagline">Leistungsdiagnostik für Masters-Athleten</span>
        )}
      </span>
    </div>
  );
}
