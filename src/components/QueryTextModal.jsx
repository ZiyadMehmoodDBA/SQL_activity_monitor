import React from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogClose } from './ui/Dialog'

export default function QueryTextModal({ row, onClose }) {
  return (
    <Dialog open={!!row} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-2xl" style={{ maxWidth: 720 }}>
        <DialogHeader>
          <DialogTitle>
            {row?.parent_object && row.parent_object !== 'Unknown' ? row.parent_object : 'Query Text'}
            {row?.object_type && (
              <span className="ml-2 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                {row.object_type}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <pre
            data-testid="query-full-text"
            className="text-xs rounded-lg p-3"
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'monospace',
              maxHeight: 420,
              overflow: 'auto',
              background: 'var(--divider)',
              color: 'var(--text-secondary)',
            }}
          >
            {row?.query_text_full || row?.query_text || ''}
          </pre>
          <div className="flex justify-end mt-4">
            <DialogClose asChild>
              <button
                className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
                style={{ background: 'var(--divider)', border: '1px solid var(--input-border)', color: 'var(--text-secondary)' }}
              >
                Close
              </button>
            </DialogClose>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
