import React from 'react';
import { Bell } from 'lucide-react';
import { useConnections } from '../context/ConnectionContext.jsx';

export default function AlertBell({ onClick }) {
  const { connections } = useConnections();
  const count = Object.values(connections || {}).reduce(
    (sum, c) => sum + (c.alerts || []).filter((a) => !a.resolvedAt && !a.ackedAt).length,
    0
  );
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Alerts"
      className="relative flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium hover:bg-white/10 transition-colors"
      style={{ color: 'var(--header-icon)' }}
    >
      <Bell size={14} />
      {count > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white animate-pulse">
          {count}
        </span>
      )}
    </button>
  );
}
