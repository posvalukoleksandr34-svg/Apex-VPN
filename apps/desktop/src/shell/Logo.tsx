/** The Meridian mark: a globe's meridian inside a rounded tile. */
export function Logo({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <linearGradient id="meridian-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8aa0ff" />
          <stop offset="1" stopColor="#4a5fd6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#meridian-tile)" />
      <circle cx="16" cy="16" r="8.5" fill="none" stroke="#fff" strokeOpacity="0.9" strokeWidth="1.8" />
      <ellipse cx="16" cy="16" rx="3.6" ry="8.5" fill="none" stroke="#fff" strokeWidth="1.8" />
      <path d="M7.8 13.2h16.4M7.8 18.8h16.4" stroke="#fff" strokeOpacity="0.55" strokeWidth="1.2" />
    </svg>
  );
}
