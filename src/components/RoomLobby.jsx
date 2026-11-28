import React from 'react';
import { Copy, Share2, UserRound } from 'lucide-react';

const SOURCE_LABELS = {
  youtube: 'YouTube',
  audio: 'Audio Only (Spotify)',
  local: 'Sync test',
  spotify: 'Audio Only (Spotify)',
};

export default function RoomLobby({
  participants,
  pendingJoins,
  canManage,
  approvalRequired,
  onApprovalChange,
  respondingToJoin,
  onRespondToJoin,
  onSwitchDemoSource,
  invite,
}) {
  return (
    <div className="room-lobby">
      {invite && (
        <section aria-labelledby="room-lobby-waiting">
          <div className="room-lobby-heading">
            <h3 id="room-lobby-waiting">Waiting to join</h3>
            <span role="status">{pendingJoins.length} waiting</span>
          </div>
          {canManage && (
            <label className="room-lobby-approval">
              <input
                type="checkbox"
                role="switch"
                checked={approvalRequired}
                onChange={(event) => onApprovalChange(event.target.checked)}
              />
              Require approval to join
            </label>
          )}
          {pendingJoins.length === 0 ? (
            <p className="room-lobby-muted">
              {approvalRequired ? 'No one is waiting in the lobby.' : 'Guests join automatically while approval is off.'}
            </p>
          ) : (
            <ul className="room-lobby-list">
              {pendingJoins.map((request) => (
                <li key={request.id} className="room-lobby-request">
                  <div>
                    <p>{request.name}</p>
                    <span>{SOURCE_LABELS[request.source] || request.source}</span>
                  </div>
                  {canManage && (
                    <div className="room-lobby-actions">
                      <button
                        type="button"
                        disabled={respondingToJoin}
                        onClick={() => onRespondToJoin(request.id, false)}
                      >
                        Decline
                      </button>
                      <button
                        type="button"
                        disabled={respondingToJoin}
                        onClick={() => onRespondToJoin(request.id, true)}
                      >
                        Accept
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="room-lobby-participants">
        <div className="room-lobby-heading">
          <h3 id="room-lobby-participants">In this room</h3>
        </div>
        <ul className="room-lobby-list">
          {participants.map((participant) => (
            <li key={participant.id} className="room-lobby-person">
              <span className="room-lobby-avatar"><UserRound size={18} aria-hidden="true" /></span>
              <div>
                <p>{participant.name} {participant.isSelf && <span>(you)</span>}</p>
                <span>
                  {participant.role === 'host' ? 'Host' : 'Guest'} · {SOURCE_LABELS[participant.source] || participant.source}
                </span>
                {participant.detail && <span>{participant.detail}</span>}
              </div>
              <span className="room-lobby-presence" data-connected={participant.connected}>
                {participant.connected ? 'Connected' : 'Reconnecting'}
              </span>
            </li>
          ))}
        </ul>
        {participants.length === 1 && (
          <p className="room-lobby-muted">Waiting for your partner.</p>
        )}
        {onSwitchDemoSource && (
          <button className="room-lobby-demo-source" type="button" onClick={onSwitchDemoSource}>
            Switch partner source
          </button>
        )}
      </section>

      {invite && (
        <section aria-labelledby="room-lobby-invite">
          <div className="room-lobby-heading">
            <h3 id="room-lobby-invite">Invite listeners</h3>
          </div>
          <div className="room-lobby-share">
            <button type="button" onClick={invite.onCopyCode}>
              <Copy size={16} aria-hidden="true" /> {invite.copiedCode ? 'Code copied' : invite.code}
            </button>
            <button type="button" onClick={invite.onShareLink}>
              <Share2 size={16} aria-hidden="true" /> Share invite
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
