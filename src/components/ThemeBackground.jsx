import React, { memo } from 'react';
import './ThemeBackground.css';

export const THEME_CONFIG = {
  midnight: {
    id: 'midnight',
    name: 'Midnight',
    accent: '#8b5cf6',
    secondary: '#6366f1',
    image: '/themes/midnight-bg.jpg',
    canvas: '#171039',
    paper: '#f0e9ff',
    lightAccent: '#5140a6',
  },
  aurora: {
    id: 'aurora',
    name: 'Aurora',
    accent: '#10b981',
    secondary: '#06b6d4',
    image: '/themes/aurora-bg.jpg',
    canvas: '#042c24',
    paper: '#dbf8ec',
    lightAccent: '#08745a',
  },
  sunset: {
    id: 'sunset',
    name: 'Sunset',
    accent: '#f97316',
    secondary: '#e11d48',
    image: '/themes/sunset-bg.jpg',
    canvas: '#411720',
    paper: '#fff0db',
    lightAccent: '#a54114',
  },
  rose: {
    id: 'rose',
    name: 'Rose Noir',
    accent: '#ec4899',
    secondary: '#a855f7',
    image: '/themes/rose-bg.jpg',
    canvas: '#3c1130',
    paper: '#fce8f3',
    lightAccent: '#9b2468',
  },
  ocean: {
    id: 'ocean',
    name: 'Deep Ocean',
    accent: '#0ea5e9',
    secondary: '#14b8a6',
    image: '/themes/ocean-bg.jpg',
    canvas: '#082a42',
    paper: '#e0f5ff',
    lightAccent: '#075f90',
  },
  minimal: {
    id: 'minimal',
    name: 'Minimal',
    accent: '#d4d4d8',
    secondary: '#71717a',
    image: '/themes/minimal-bg.jpg',
    canvas: '#292938',
    paper: '#f0eef3',
    lightAccent: '#505066',
  },
};

function ThemeBackground({ theme = 'midnight' }) {
  const current = THEME_CONFIG[theme] || THEME_CONFIG.midnight;

  return (
    <div
      key={current.id}
      className="room-ambient"
      data-theme={current.id}
      aria-hidden="true"
    >
      <img src={current.image} alt="" className="room-ambient-image" />
      <div className="room-ambient-motion" />
    </div>
  );
}

export default memo(ThemeBackground);
