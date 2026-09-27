/** The Apexy VPN mark (the same artwork as the app icons). */
export function Logo({ size = 32 }: { size?: number }) {
  return <img src="/logo.png" width={size} height={size} alt="" aria-hidden draggable={false} />;
}
