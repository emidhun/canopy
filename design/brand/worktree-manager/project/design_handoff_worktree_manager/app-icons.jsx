// app-icons.jsx — inline SVG icons for the app window (Tabler-style, stroke=currentColor)
function isvg(size, sw) {
  return { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: sw || 2, strokeLinecap: "round", strokeLinejoin: "round" };
}

const Icons = {
  fork: ({ size = 14 }) => (
    <svg {...isvg(size)}>
      <circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" />
      <path d="M6 8.2v2.3a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2v-2.3" /><path d="M12 12.5v3.3" />
    </svg>
  ),
  search: ({ size = 14 }) => (
    <svg {...isvg(size)}><circle cx="10.5" cy="10.5" r="6.5" /><path d="M21 21l-4.5 -4.5" /></svg>
  ),
  plus: ({ size = 14 }) => (<svg {...isvg(size)}><path d="M12 5v14" /><path d="M5 12h14" /></svg>),
  refresh: ({ size = 15 }) => (
    <svg {...isvg(size)}><path d="M20 11a8 8 0 1 0 -2.3 5.7" /><path d="M20 5v6h-6" /></svg>
  ),
  settings: ({ size = 15 }) => (
    <svg {...isvg(size)}>
      <path d="M10.3 3.2a1.6 1.6 0 0 1 3.4 0l.1.6a1.6 1.6 0 0 0 2.3 1l.5-.3a1.6 1.6 0 0 1 2.2 2.2l-.3.5a1.6 1.6 0 0 0 1 2.3l.6.1a1.6 1.6 0 0 1 0 3.4l-.6.1a1.6 1.6 0 0 0-1 2.3l.3.5a1.6 1.6 0 0 1-2.2 2.2l-.5-.3a1.6 1.6 0 0 0-2.3 1l-.1.6a1.6 1.6 0 0 1-3.4 0l-.1-.6a1.6 1.6 0 0 0-2.3-1l-.5.3a1.6 1.6 0 0 1-2.2-2.2l.3-.5a1.6 1.6 0 0 0-1-2.3l-.6-.1a1.6 1.6 0 0 1 0-3.4l.6-.1a1.6 1.6 0 0 0 1-2.3l-.3-.5a1.6 1.6 0 0 1 2.2-2.2l.5.3a1.6 1.6 0 0 0 2.3-1z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  ),
  editor: ({ size = 15 }) => (
    <svg {...isvg(size)}><path d="M16 18l6-6-6-6" /><path d="M8 6l-6 6 6 6" /></svg>
  ),
  finder: ({ size = 15 }) => (
    <svg {...isvg(size)}><path d="M5 4h14a1 1 0 0 1 1 1v3H4V5a1 1 0 0 1 1-1z" /><rect x="4" y="8" width="16" height="12" rx="1.5" /></svg>
  ),
  terminal: ({ size = 15 }) => (
    <svg {...isvg(size)}><path d="M5 7l5 5-5 5" /><path d="M12 19h7" /></svg>
  ),
  pull: ({ size = 15 }) => (
    <svg {...isvg(size)}><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></svg>
  ),
  database: ({ size = 15 }) => (
    <svg {...isvg(size)}><ellipse cx="12" cy="6" rx="7" ry="2.6" /><path d="M5 6v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6" /><path d="M5 12v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6" /></svg>
  ),
  more: ({ size = 16 }) => (
    <svg {...isvg(size)}><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" /></svg>
  ),
  play: ({ size = 15 }) => (<svg {...isvg(size)}><path d="M7 5v14l11-7z" fill="currentColor" stroke="none" /></svg>),
  stop: ({ size = 14 }) => (<svg {...isvg(size)}><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" /></svg>),
  restart: ({ size = 15 }) => (
    <svg {...isvg(size)}><path d="M20 11a8 8 0 1 0 -2.3 5.7" /><path d="M20 5v6h-6" /></svg>
  ),
  logs: ({ size = 15 }) => (
    <svg {...isvg(size)}><path d="M4 7h16" /><path d="M4 12h10" /><path d="M4 17h13" /></svg>
  ),
  globe: ({ size = 15 }) => (
    <svg {...isvg(size, 1.7)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.5 2.5 2.5 15 0 18" /><path d="M12 3c-2.5 2.5-2.5 15 0 18" /></svg>
  ),
  server: ({ size = 15 }) => (
    <svg {...isvg(size, 1.7)}><rect x="3" y="4" width="18" height="7" rx="1.6" /><rect x="3" y="13" width="18" height="7" rx="1.6" /><path d="M7 7.5h.01" /><path d="M7 16.5h.01" /></svg>
  ),
  cog: ({ size = 15 }) => (
    <svg {...isvg(size, 1.7)}><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></svg>
  ),
  check: ({ size = 18 }) => (
    <svg {...isvg(size)}><path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /><path d="M9 12l2 2l4 -4" /></svg>
  ),
  x: ({ size = 18 }) => (
    <svg {...isvg(size)}><path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /><path d="M10 10l4 4m0 -4l-4 4" /></svg>
  ),
  spinner: ({ size = 18 }) => (
    <svg {...isvg(size)} className="spin"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
  ),
  external: ({ size = 13 }) => (
    <svg {...isvg(size)}><path d="M12 6h-5a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-5" /><path d="M11 13l9 -9" /><path d="M15 4h5v5" /></svg>
  ),
};

window.Icons = Icons;
