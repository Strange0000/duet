import React, { memo } from 'react';
import './ThemeBackground.css';

export const THEME_CONFIG = {
  midnight: {
    id: 'midnight',
    name: 'Midnight',
    accent: '#8b5cf6',
    secondary: '#6366f1',
    image: '/themes/midnight-bg.jpg',
    bgBase: 'bg-[#06050c]',
  },
  aurora: {
    id: 'aurora',
    name: 'Aurora',
    accent: '#10b981',
    secondary: '#06b6d4',
    image: '/themes/aurora-bg.jpg',
    bgBase: 'bg-[#030c0c]',
  },
  sunset: {
    id: 'sunset',
    name: 'Sunset',
    accent: '#f97316',
    secondary: '#e11d48',
    image: '/themes/sunset-bg.jpg',
    bgBase: 'bg-[#0c0608]',
  },
  rose: {
    id: 'rose',
    name: 'Rose Noir',
    accent: '#ec4899',
    secondary: '#a855f7',
    image: '/themes/rose-bg.jpg',
    bgBase: 'bg-[#0e040a]',
  },
  ocean: {
    id: 'ocean',
    name: 'Deep Ocean',
    accent: '#0ea5e9',
    secondary: '#14b8a6',
    image: '/themes/ocean-bg.jpg',
    bgBase: 'bg-[#020a14]',
  },
  minimal: {
    id: 'minimal',
    name: 'Minimal',
    accent: '#d4d4d8',
    secondary: '#71717a',
    image: '/themes/minimal-bg.jpg',
    bgBase: 'bg-[#09090b]',
  },
};

function ThemeBackground({ theme = 'midnight' }) {
  const current = THEME_CONFIG[theme] || THEME_CONFIG.midnight;

  return (
    <div
      key={current.id}
      className={`room-ambient ${current.bgBase}`}
      data-theme={current.id}
      style={{ '--ambient-accent': current.accent }}
      aria-hidden="true"
    >
      <img src={current.image} alt="" className="room-ambient-image" />
      <div className="room-ambient-motion" />
    </div>
  );
}

export default memo(ThemeBackground);
