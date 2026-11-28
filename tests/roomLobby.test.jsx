// @vitest-environment jsdom
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
    const { container, root } = renderLobby({
      code: 'TEST01',
      copiedCode: false,
      onCopyCode: vi.fn(),
      onShareLink,
    });
    try {
      const button = Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent.includes('Share invite'));
      expect(button).not.toBeUndefined();
      act(() => { button.click(); });
      expect(onShareLink).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

});
