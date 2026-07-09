import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogClose } from './ui/Dialog.jsx';
import { useConnections } from '../context/ConnectionContext.jsx';
import { alertText, fmtKpi, normalizeAlertRow } from '../lib/alertFmt.js';

const PAD_MS  = 15 * 60_000;
const WEEK_MS = 7 * 86_400_000;

function fmtDuration(ms) {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function AlertRow({ a, muted, onDeepLink, onAck }) {
  return (
    <div
      tabIndex={0}
      onClick={() => onDeepLink(a)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onDeepLink(a); }}
      className={[
        'flex items-center justify-between gap-3 rounded-xl border px-3 py-2 cursor-pointer transition-colors',
        muted
          ? 'border-slate-800 text-slate-500 hover:bg-slate-900'
          : 'border-red-900/60 bg-red-950/30 text-slate-200 hover:bg-red-950/50',
      ].join(' ')}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">{alertText(a)}</div>
        <div className="text-xs opacity-70">
          {new Date(a.startedAt).toLocaleString()}
          {' · '}
          {fmtDuration((a.resolvedAt ?? Date.now()) - a.startedAt)}
          {' · peak '}
          {fmtKpi(a.kpi, a.peakValue)}
        </div>
      </div>
      {!muted && !a.ackedAt && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAck(a.id); }}
          className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
        >
          Ack
        </button>
      )}
    </div>
  );
}

export default function AlertPanel({ open, onClose }) {
  const { connections, selectedConnectionId, dispatch } = useConnections();
  const connId = selectedConnectionId;
  const conn   = connections[connId];
  const active = (conn?.alerts || []).filter((a) => !a.resolvedAt);
  const [resolved, setResolved] = useState([]);

  useEffect(() => {
    if (!open || !connId) return;
    const now = Date.now();
    fetch(`/api/connections/${connId}/alerts?from=${now - WEEK_MS}&to=${now}`)
      .then((r) => (r.ok ? r.json() : { alerts: [] }))
      .then(({ alerts }) => setResolved(alerts.map(normalizeAlertRow).filter((a) => a.resolvedAt)))
      .catch(() => setResolved([]));
  }, [open, connId]);

  const ack = (alertId) => {
    fetch(`/api/connections/${connId}/alerts/${alertId}/ack`, { method: 'POST' })
      .then((r) => { if (r.ok) dispatch({ type: 'ALERT_ACKED', connId, alertId, ackedAt: Date.now() }); })
      .catch(() => {});
  };

  const deepLink = (a) => {
    const to = (a.resolvedAt ?? Date.now()) + PAD_MS;
    dispatch({ type: 'SET_DEEP_LINK', connId, from: a.startedAt - PAD_MS, to });
    onClose();
  };

  const connLabel = conn?.label || conn?.displayName || connId;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>
              Alerts{connLabel ? ` — ${connLabel}` : ''}
            </DialogTitle>
            <DialogClose asChild>
              <button
                type="button"
                aria-label="Close"
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </DialogClose>
          </div>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-2">
            {active.length === 0 && (
              <div className="text-sm text-slate-500">No active alerts.</div>
            )}
            {active.map((a) => (
              <AlertRow key={a.id} a={a} muted={false} onDeepLink={deepLink} onAck={ack} />
            ))}
          </div>
          <div className="mt-4">
            <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">
              Resolved — last 7 days
            </div>
            <div className="space-y-2">
              {resolved.length === 0 && (
                <div className="text-sm text-slate-600">Nothing resolved recently.</div>
              )}
              {resolved.map((a) => (
                <AlertRow key={a.id} a={a} muted onDeepLink={deepLink} onAck={ack} />
              ))}
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
