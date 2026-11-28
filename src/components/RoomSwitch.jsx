import React from 'react';

export default function RoomSwitch({ checked, onChange, children, className = '' }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`room-button room-switch ${className}`.trim()}
      onClick={() => onChange(!checked)}
    >
      <span>{children}</span>
      <span className="room-switch-track" aria-hidden="true" />
    </button>
  );
}
