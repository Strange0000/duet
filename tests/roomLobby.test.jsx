// @vitest-environment jsdom
// RoomLobby invite buttons: the "Share invite" button must call the native
// share handler (onShareLink) and fall back to the copy handler when it
// is not provided. The "Copy code" button is unchanged.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import RoomLobby from '../src/components/RoomLobby.jsx';

function renderLobby(invite) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <RoomLobby
        participants={[{ id: 'host-1', name: 'Host', role: 'host', source: 'youtube', connected: true }]}
        pendingJoins={[]}
        canManage
        approvalRequired={false}
        onApprovalChange={() => {}}
        respondingToJoin={false}
        onRespondToJoin={() => {}}
        invite={invite}
      />
    );
  });
  return { container, root };
}

describe('RoomLobby invite', () => {
  it('calls onShareLink when "Share invite" is clicked', () => {
    const onShareLink = vi.fn();
    const onCopyLink = vi.fn();
    const { container, root } = renderLobby({
      code: 'TEST01',
      copiedCode: false,
      copiedLink: false,
      onCopyCode: vi.fn(),
      onCopyLink,
      onShareLink,
    });
    try {
      const button = Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent.includes('Share invite'));
      expect(button).not.toBeUndefined();
      act(() => { button.click(); });
      expect(onShareLink).toHaveBeenCalledTimes(1);
      expect(onCopyLink).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('falls back to onCopyLink when onShareLink is not provided', () => {
    const onCopyLink = vi.fn();
    const { container, root } = renderLobby({
      code: 'TEST01',
      copiedCode: false,
      copiedLink: false,
      onCopyCode: vi.fn(),
      onCopyLink,
    });
    try {
      const button = Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent.includes('Share invite'));
      expect(button).not.toBeUndefined();
      act(() => { button.click(); });
      expect(onCopyLink).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
