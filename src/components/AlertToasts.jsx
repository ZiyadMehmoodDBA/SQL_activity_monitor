import React, { useEffect, useRef, useState } from 'react';
import { useConnections } from '../context/ConnectionContext.jsx';
import { alertText } from '../lib/alertFmt.js';

const TOAST_MS = 8000;

export default function AlertToasts() {
  const { lastAlertEvent } = useConnections();
  const event = lastAlertEvent;
  const seenSeq = useRef(0);
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    if (!event || event.seq <= seenSeq.current) return;
    seenSeq.current = event.seq;
    const toast = { key: event.seq, alert: event.alert };
    setToasts((t) => [...t, toast]);
    const timer = setTimeout(() => {
      setToasts((t) => t.filter((x) => x.key !== toast.key));
    }, TOAST_MS);
    return () => clearTimeout(timer);
  }, [event]);

  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(({ key, alert }) => {
        const resolved = alert.resolvedAt != null;
        return (
          <div
            key={key}
            role="status"
            className={`rounded-2xl px-4 py-3 text-sm shadow-lg border ${
              resolved
                ? 'bg-emerald-950/90 border-emerald-700 text-emerald-200'
                : 'bg-red-950/90 border-red-700 text-red-200'
            }`}
          >
            <span className="font-semibold">{resolved ? 'Resolved: ' : 'Alert: '}</span>
            {alertText(alert)}
          </div>
        );
      })}
    </div>
  );
}
