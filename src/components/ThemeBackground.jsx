import React, { memo } from 'react';

/**
 * Premium Ambient Theme Background for Duet
 * Multi-layer cinematic stage featuring theme-specific atmospheric gradients,
 * organic ambient orbs, living light effects, and filmic vignette depth.
 */
export const THEME_CONFIG = {
  midnight: {
    id: 'midnight',
    name: 'Midnight',
    accent: '#8b5cf6',
    secondary: '#6366f1',
    glow: 'rgba(139, 92, 246, 0.35)',
    dot: 'bg-violet-400',
    border: 'border-violet-500/20',
    image: '/themes/midnight-bg.jpg',
    bgBase: 'bg-[#06050c]',
    gradient: 'from-violet-950/40 via-[#070612]/70 to-[#06050c]',
    orb1: 'rgba(124, 58, 237, 0.28)',
    orb2: 'rgba(79, 70, 229, 0.22)',
  },
  aurora: {
    id: 'aurora',
    name: 'Aurora',
    accent: '#10b981',
    secondary: '#06b6d4',
    glow: 'rgba(16, 185, 129, 0.35)',
    dot: 'bg-emerald-400',
    border: 'border-emerald-500/20',
    image: '/themes/aurora-bg.jpg',
    bgBase: 'bg-[#030c0c]',
    gradient: 'from-emerald-950/35 via-teal-950/40 to-[#030c0c]',
    orb1: 'rgba(16, 185, 129, 0.26)',
    orb2: 'rgba(6, 182, 212, 0.22)',
  },
  sunset: {
    id: 'sunset',
    name: 'Sunset',
    accent: '#f97316',
    secondary: '#e11d48',
    glow: 'rgba(249, 115, 22, 0.35)',
    dot: 'bg-orange-400',
    border: 'border-orange-500/20',
    image: '/themes/sunset-bg.jpg',
    bgBase: 'bg-[#0c0608]',
    gradient: 'from-orange-950/35 via-rose-950/45 to-[#0c0608]',
    orb1: 'rgba(249, 115, 22, 0.28)',
    orb2: 'rgba(225, 29, 72, 0.22)',
  },
  rose: {
    id: 'rose',
    name: 'Rose Noir',
    accent: '#ec4899',
    secondary: '#a855f7',
    glow: 'rgba(236, 72, 153, 0.35)',
    dot: 'bg-pink-400',
    border: 'border-pink-500/20',
    image: '/themes/rose-bg.jpg',
    bgBase: 'bg-[#0e040a]',
    gradient: 'from-pink-950/35 via-purple-950/40 to-[#0e040a]',
    orb1: 'rgba(236, 72, 153, 0.28)',
    orb2: 'rgba(168, 85, 247, 0.20)',
  },
  ocean: {
    id: 'ocean',
    name: 'Deep Ocean',
    accent: '#0ea5e9',
    secondary: '#14b8a6',
    glow: 'rgba(14, 165, 233, 0.35)',
    dot: 'bg-sky-400',
    border: 'border-sky-500/20',
    image: '/themes/ocean-bg.jpg',
    bgBase: 'bg-[#020a14]',
    gradient: 'from-sky-950/40 via-cyan-950/40 to-[#020a14]',
    orb1: 'rgba(14, 165, 233, 0.26)',
    orb2: 'rgba(20, 184, 166, 0.20)',
  },
  minimal: {
    id: 'minimal',
    name: 'Minimal',
    accent: '#d4d4d8',
    secondary: '#71717a',
    glow: 'rgba(212, 212, 216, 0.25)',
    dot: 'bg-zinc-400',
    border: 'border-zinc-500/20',
    image: '/themes/minimal-bg.jpg',
    bgBase: 'bg-[#09090b]',
    gradient: 'from-zinc-900/30 via-zinc-950/60 to-[#09090b]',
    orb1: 'rgba(82, 82, 91, 0.18)',
    orb2: 'rgba(39, 39, 42, 0.24)',
  },
};

function ThemeBackground({ theme = 'midnight', isPlaying = false }) {
  const current = THEME_CONFIG[theme] || THEME_CONFIG.midnight;

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed inset-0 z-0 overflow-hidden transition-colors duration-1000 select-none ${current.bgBase}`}
    >
      {/* Layer 1: Ambient Floating Light Orbs */}
      <div className="absolute inset-0 overflow-hidden">
        {/* Primary Ambient Orb */}
        <div
          className={`theme-orb-primary absolute -top-[15%] left-[10%] h-[75vw] w-[75vw] max-w-[900px] max-h-[900px] rounded-full blur-[110px] transition-all duration-1000 ${
            isPlaying ? 'opacity-80 scale-105' : 'opacity-60 scale-100'
          }`}
          style={{
            background: `radial-gradient(circle, ${current.orb1} 0%, transparent 70%)`,
          }}
        />

        {/* Secondary Ambient Orb */}
        <div
          className={`theme-orb-secondary absolute -bottom-[10%] right-[5%] h-[65vw] w-[65vw] max-w-[800px] max-h-[800px] rounded-full blur-[120px] transition-all duration-1000 ${
            isPlaying ? 'opacity-70 scale-105' : 'opacity-50 scale-100'
          }`}
          style={{
            background: `radial-gradient(circle, ${current.orb2} 0%, transparent 70%)`,
          }}
        />
      </div>

      {/* Layer 2: High-Definition Theme Artwork with Cinematic Drift */}
      <div className="absolute inset-0 transition-opacity duration-1000" key={theme}>
        <img
          src={current.image}
          alt=""
          loading="eager"
          className="theme-bg-artwork h-full w-full object-cover opacity-50 transition-all duration-1000"
        />
      </div>

      {/* Layer 3: Theme-Specific Procedural Atmospheric Accent */}
      {theme === 'aurora' && (
        <div className="theme-aurora-curtain absolute inset-0 opacity-40 mix-blend-screen" />
      )}
      {theme === 'midnight' && (
        <div className="theme-starlight-field absolute inset-0 opacity-45 mix-blend-screen" />
      )}
      {theme === 'sunset' && (
        <div className="theme-sunset-flare absolute inset-0 opacity-35 mix-blend-screen" />
      )}
      {theme === 'rose' && (
        <div className="theme-rose-bloom absolute inset-0 opacity-35 mix-blend-screen" />
      )}
      {theme === 'ocean' && (
        <div className="theme-ocean-caustic absolute inset-0 opacity-35 mix-blend-screen" />
      )}
      {theme === 'minimal' && (
        <div className="theme-minimal-sheen absolute inset-0 opacity-20 mix-blend-screen" />
      )}

      {/* Layer 4: Filmic Micro-Grain Overlay (Eliminates banding, adds cinema depth) */}
      <div className="theme-film-grain absolute inset-0 opacity-[0.035] mix-blend-overlay" />

      {/* Layer 5: Authoritative Vignette Gradient (Ensures UI & text contrast) */}
      <div
        className={`absolute inset-0 bg-gradient-to-b ${current.gradient} transition-all duration-1000`}
      />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_40%,transparent_15%,rgba(0,0,0,0.45)_70%,rgba(0,0,0,0.92)_100%)]" />
    </div>
  );
}

export default memo(ThemeBackground);
