import React, { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogClose } from './ui/Dialog'

const TAB_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
  '#ec4899','#06b6d4','#84cc16','#f97316','#6366f1',
]

export default function ConnectModal({ open, onClose, onConnected }) {
  const [modalTab,       setModalTab]       = useState('login')
  const [authType,       setAuthType]       = useState('windows')
  const [appIntent,      setAppIntent]      = useState('ReadWrite')
  const [selectedColor,  setSelectedColor]  = useState(TAB_COLORS[0])
  const [encrypt,        setEncrypt]        = useState('false')
  const [trustCert,      setTrustCert]      = useState(true)
  const [error,          setError]          = useState('')
  const [loading,        setLoading]        = useState(false)
  const [server,         setServer]         = useState('')
  const [label,          setLabel]          = useState('')
  const [database,       setDatabase]       = useState('')
  const [user,           setUser]           = useState('')
  const [password,       setPassword]       = useState('')
  const [hostname,       setHostname]       = useState('')
  const [connStr,        setConnStr]        = useState('')

  // Load defaults from server config
  useEffect(() => {
    if (!open) return
    fetch('/api/config').then(r => r.json()).then(cfg => {
      if (cfg.defaultServer)  setServer(cfg.defaultServer)
      if (cfg.defaultAuthType) setAuthType(cfg.defaultAuthType)
      if (cfg.defaultDb && cfg.defaultDb !== 'master') setDatabase(cfg.defaultDb)
    }).catch(() => {})
  }, [open])

  // ── Shared connect handler ────────────────────────────────────────────────
  async function submitConnect(body) {
    setError('')
    setLoading(true)
    try {
      const res  = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Connection failed')
      onConnected(data)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function handleLoginSubmit(e) {
    e.preventDefault()
    submitConnect({
      server, label, database, authType,
      user:     authType === 'sql' ? user     : undefined,
      password: authType === 'sql' ? password : undefined,
      encrypt, trustServerCert: trustCert,
      hostNameInCertificate: hostname || undefined,
      appIntent, color: selectedColor,
    })
  }

  function handleConnStrSubmit() {
    submitConnect({ connectionString: connStr, color: selectedColor })
  }

  // ── Segmented control ─────────────────────────────────────────────────────
  function SegBtn({ value, current, onChange, children }) {
    return (
      <button
        type="button"
        onClick={() => onChange(value)}
        className={`form-segmented-btn ${current === value ? 'seg-active' : ''}`}
      >
        {children}
      </button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent style={{ maxWidth: 440 }}>
        <DialogHeader>
          {/* Title row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div
              style={{
                width: 36, height: 36, borderRadius: 10,
                background: 'var(--header-bg)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <svg style={{ width: 18, height: 18, color: '#fff' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>
                Connect to SQL Server
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Add a new monitored instance
              </div>
            </div>
            <DialogClose asChild>
              <button
                style={{ color: 'var(--text-muted)', fontSize: 20, lineHeight: 1, padding: '2px 6px', borderRadius: 6 }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--section-hover)'; e.currentTarget.style.color = 'var(--text-primary)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}
              >
                ×
              </button>
            </DialogClose>
          </div>

          {/* Modal tabs */}
          <div
            style={{
              display: 'flex',
              borderBottom: '1px solid var(--divider)',
              margin: '0 -4px',
            }}
          >
            {[
              { key: 'login',   label: 'Login' },
              { key: 'connstr', label: 'Connection String' },
            ].map(t => (
              <button
                key={t.key}
                type="button"
                onClick={() => setModalTab(t.key)}
                className={`modal-tab px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${modalTab === t.key ? 'active' : ''}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </DialogHeader>

        <DialogBody>
          <form onSubmit={modalTab === 'login' ? handleLoginSubmit : e => { e.preventDefault(); handleConnStrSubmit() }} autoComplete="off">

            {/* ── Login tab ── */}
            {modalTab === 'login' && (
              <div className="space-y-4">
                <div>
                  <label className="form-label">Server</label>
                  <input
                    className="form-input"
                    value={server}
                    onChange={e => setServer(e.target.value)}
                    placeholder="SERVER\INSTANCE  or  SERVER,PORT"
                    required
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label className="form-label">
                      Label <span style={{ fontWeight: 400, textTransform: 'none', fontSize: 10, color: 'var(--text-muted)' }}>(optional)</span>
                    </label>
                    <input
                      className="form-input"
                      value={label}
                      onChange={e => setLabel(e.target.value)}
                      placeholder="e.g. Production"
                    />
                  </div>
                  <div>
                    <label className="form-label">Database</label>
                    <input
                      className="form-input"
                      value={database}
                      onChange={e => setDatabase(e.target.value)}
                      placeholder="master"
                    />
                  </div>
                </div>

                <div>
                  <label className="form-label">Authentication</label>
                  <div className="form-segmented">
                    <SegBtn value="windows" current={authType} onChange={setAuthType}>Windows Auth</SegBtn>
                    <SegBtn value="sql"     current={authType} onChange={setAuthType}>SQL Auth</SegBtn>
                  </div>
                </div>

                {authType === 'sql' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label className="form-label">Username</label>
                      <input
                        className="form-input"
                        value={user}
                        onChange={e => setUser(e.target.value)}
                        placeholder="sa"
                        autoComplete="username"
                      />
                    </div>
                    <div>
                      <label className="form-label">Password</label>
                      <input
                        type="password"
                        className="form-input"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="••••••••"
                        autoComplete="current-password"
                      />
                    </div>
                  </div>
                )}

                {/* Security section */}
                <div className="form-section-sep">
                  <p className="form-section-title">Security</p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label className="form-label">Encryption</label>
                      <select
                        className="form-select"
                        value={encrypt}
                        onChange={e => setEncrypt(e.target.value)}
                        style={{ cursor: 'pointer' }}
                      >
                        <option value="false">Optional</option>
                        <option value="true">Mandatory</option>
                        <option value="strict">Strict (SQL 2022 / Azure)</option>
                      </select>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', paddingBottom: 8 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
                        <input
                          type="checkbox"
                          checked={trustCert}
                          onChange={e => setTrustCert(e.target.checked)}
                          style={{ width: 15, height: 15, borderRadius: 4, cursor: 'pointer', accentColor: 'var(--sort-active)' }}
                        />
                        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Trust Server Certificate</span>
                      </label>
                    </div>
                  </div>

                  {encrypt === 'strict' && (
                    <div style={{ marginTop: 12 }}>
                      <label className="form-label">Host Name in Certificate</label>
                      <input
                        className="form-input"
                        value={hostname}
                        onChange={e => setHostname(e.target.value)}
                        placeholder="e.g. *.contoso.com"
                      />
                    </div>
                  )}

                  <div style={{ marginTop: 12 }}>
                    <label className="form-label">Application Intent</label>
                    <div className="form-segmented">
                      <SegBtn value="ReadWrite" current={appIntent} onChange={setAppIntent}>ReadWrite</SegBtn>
                      <SegBtn value="ReadOnly"  current={appIntent} onChange={setAppIntent}>ReadOnly</SegBtn>
                    </div>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <label className="form-label">Tab Color</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {TAB_COLORS.map(c => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setSelectedColor(c)}
                          style={{
                            width: 20, height: 20,
                            borderRadius: '50%',
                            background: c,
                            border: selectedColor === c ? `2px solid var(--text-primary)` : '2px solid transparent',
                            outline: selectedColor === c ? `2px solid ${c}` : 'none',
                            outlineOffset: 1,
                            cursor: 'pointer',
                            transition: 'transform .15s',
                            transform: selectedColor === c ? 'scale(1.2)' : 'scale(1)',
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                {error && <div className="form-error">{error}</div>}

                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    width: '100%',
                    padding: '10px',
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 600,
                    color: '#fff',
                    background: 'var(--header-bg)',
                    opacity: loading ? .6 : 1,
                    cursor: loading ? 'not-allowed' : 'pointer',
                    transition: 'opacity .15s',
                  }}
                >
                  {loading ? 'Connecting…' : 'Connect'}
                </button>
              </div>
            )}

            {/* ── Connection string tab ── */}
            {modalTab === 'connstr' && (
              <div className="space-y-3">
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  ADO.NET connection strings are supported.
                </p>
                <textarea
                  className="form-textarea"
                  rows={6}
                  value={connStr}
                  onChange={e => setConnStr(e.target.value)}
                  placeholder="Paste connection string here…"
                />
                {error && <div className="form-error">{error}</div>}
                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    width: '100%',
                    padding: '10px',
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 600,
                    color: '#fff',
                    background: 'var(--header-bg)',
                    opacity: loading ? .6 : 1,
                    cursor: loading ? 'not-allowed' : 'pointer',
                    transition: 'opacity .15s',
                  }}
                >
                  {loading ? 'Connecting…' : 'Connect'}
                </button>
              </div>
            )}

          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
