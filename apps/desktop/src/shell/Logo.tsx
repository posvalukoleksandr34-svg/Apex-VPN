import logoUrl from "@/assets/logo.png";

/**
 * The Apexy VPN mark: a shield with a lock and signal waves on a rounded
 * tile. Cut from the brand artwork (src-tauri/icons/apexy-original.webp);
 * the app icons are generated from the same source.
 */
export function Logo({ size = 30, className }: { size?: number; className?: string }) {
  return <img src={logoUrl} width={size} height={size} className={className} alt="" aria-hidden draggable={false} />;
}
