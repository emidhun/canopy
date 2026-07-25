// Tag <html> with the OS so CSS can adapt window chrome. Only macOS uses
// titleBarStyle: Overlay (traffic lights inset into our toolbar); every other
// platform gets a native titlebar and no inset. Call once at startup.
export function applyPlatformClass(): void {
  const ua = navigator.userAgent;
  const isMac = /Mac|iPhone|iPad|iPod/.test(ua);
  document.documentElement.classList.add(isMac ? "mac" : "win");
}
