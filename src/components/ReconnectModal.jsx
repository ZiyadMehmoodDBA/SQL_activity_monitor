import React, { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { KeyRound } from 'lucide-react'
import { useConnections } from '../context/ConnectionContext'
import { setSessionPassword } from '../lib/profileStore'

export default function ReconnectModal({ connectionId, onClose }) {
  const { getProfile, reconnect } = useConnections()
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  const profile = connectionId ? getProfile(connectionId) : null

  useEffect(() => {
    setPassword(''); setRemember(false); setError(''); setLoading(false)
  }, [connectionId])

  if (!profile) return null

  async function handleSubmit(e) {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      await reconnect(profile.id, password)
      if (remember && password) setSessionPassword(profile.id, password)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent style={{ maxWidth: 420, background: 'var(--card-bg)', border: '1px solid var(--input-border)' }}>
        <div className="flex items-center gap-3 mb-4">
          <span className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
            <KeyRound size={16} style={{ color: 'var(--text-secondary)' }} />
          </span>
          <div className="min-w-0">
            <DialogTitle style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>
              Reconnect to {profile.displayName}
            </DialogTitle>
            <p className="text-xs truncate m-0" style={{ color: 'var(--text-muted)' }}>
              {profile.serverName} — SQL authentication ({profile.username})
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} autoComplete="off">
          <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoFocus
            required
            autoComplete="current-password"
            className="w-full rounded-lg px-3.5 py-2.5 text-sm outline-none"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}
          />

          <label className="flex items-center gap-2.5 mt-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={e => setRemember(e.target.checked)}
              style={{ width: 15, height: 15, accentColor: 'var(--sort-active)' }}
            />
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Remember password for this session (cleared when browser closes)
            </span>
          </label>

          {error && (
            <div className="mt-3 rounded-lg px-3 py-2 text-xs font-medium"
                 style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-4 rounded-lg py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed"
            style={{ background: loading ? 'var(--input-border)' : 'var(--sort-active)' }}
          >
            {loading ? 'Reconnecting…' : 'Reconnect'}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
