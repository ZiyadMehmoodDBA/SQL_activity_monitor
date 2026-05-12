import React, { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogClose } from './ui/Dialog'
import { ChevronDown, Server, X } from 'lucide-react'

const TAB_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
  '#ec4899','#06b6d4','#84cc16','#f97316','#6366f1',
]

// ── Field components ─────────────────────────────────────────────────────────

function Label({ children }) {
  return (
    <label style={{
      display: 'block',
      fontSize: 11,
      fontWeight: 700,
      // #334155 = slate-700: 9.7:1 on white — passes AA at any size
      color: '#334155',
      marginBottom: 6,
      letterSpacing: '.05em',
      textTransform: 'uppercase',
    }}>
      {children}
    </label>
  )
}

function Input({ type = 'text', value, onChange, placeholder, required, autoComplete }) {
  const [focused, setFocused] = useState(false)
  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      required={required}
      autoComplete={autoComplete}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        width: '100%',
        minHeight: 44,
        // Slightly off-white bg so inputs have depth against white card
        background: focused ? 'var(--input-bg)' : '#f8fafc',
        border: `1.5px solid ${focused ? '#3b82f6' : '#94a3b8'}`,
        boxShadow: focused ? '0 0 0 3px rgba(59,130,246,0.18)' : 'none',
        color: 'var(--text-primary)',
        borderRadius: 8,
        padding: '10px 13px',
        fontSize: 13,
        outline: 'none',
        transition: 'all .15s',
        boxSizing: 'border-box',
      }}
    />
  )
}

function SelInput({ value, onChange, children }) {
  const [focused, setFocused] = useState(false)
  return (
    <select
      value={value}
      onChange={onChange}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        width: '100%',
        minHeight: 44,
        background: focused ? 'var(--input-bg)' : '#f8fafc',
        border: `1.5px solid ${focused ? '#3b82f6' : '#94a3b8'}`,
        boxShadow: focused ? '0 0 0 3px rgba(59,130,246,0.18)' : 'none',
        color: 'var(--text-primary)',
        borderRadius: 8,
        padding: '10px 13px',
        fontSize: 13,
        outline: 'none',
        cursor: 'pointer',
        appearance: 'none',
        WebkitAppearance: 'none',
        transition: 'all .15s',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </select>
  )
}

// Active = solid blue fill + white text. Inactive = #e2e8f0 bg + #475569 text.
// Both pass AA contrast at 12px regardless of palette.
function Seg({ options, value, onChange }) {
  return (
    <div style={{
      display: 'flex',
      background: '#e2e8f0',
      borderRadius: 9,
      padding: 3,
      gap: 3,
      border: '1px solid #cbd5e1',
    }}>
      {options.map(opt => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              flex: 1,
              minHeight: 38,
              padding: '7px 12px',
              fontSize: 12,
              fontWeight: active ? 700 : 500,
              borderRadius: 7,
              transition: 'all .15s',
              color: active ? '#fff' : '#475569',
              background: active ? '#3b82f6' : 'transparent',
              boxShadow: active ? '0 1px 6px rgba(59,130,246,0.4)' : 'none',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// Section collapse — #475569 label (7.5:1 on white = passes AA large text + UI)
// Divider #cbd5e1 — clearly visible on white without being harsh
function Section({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ borderTop: '1.5px solid #cbd5e1', marginTop: 2 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 0',
          cursor: 'pointer',
          background: 'none',
          border: 'none',
          minHeight: 44,
        }}
      >
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          color: '#475569',
          textTransform: 'uppercase',
          letterSpacing: '.07em',
        }}>
          {title}
        </span>
        <ChevronDown
          size={14}
          style={{
            color: '#64748b',
            transition: 'transform .15s',
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            flexShrink: 0,
          }}
        />
      </button>
      {open && <div style={{ paddingBottom: 14 }}>{children}</div>}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ConnectModal({ open, onClose, onConnected }) {
  const [modalTab,      setModalTab]      = useState('login')
  const [authType,      setAuthType]      = useState('windows')
  const [appIntent,     setAppIntent]     = useState('ReadWrite')
  const [selectedColor, setSelectedColor] = useState(TAB_COLORS[0])
  const [encrypt,       setEncrypt]       = useState('false')
  const [trustCert,     setTrustCert]     = useState(true)
  const [error,         setError]         = useState('')
  const [loading,       setLoading]       = useState(false)
  const [server,        setServer]        = useState('')
  const [label,         setLabel]         = useState('')
  const [database,      setDatabase]      = useState('')
  const [user,          setUser]          = useState('')
  const [password,      setPassword]      = useState('')
  const [hostname,      setHostname]      = useState('')
  const [connStr,       setConnStr]       = useState('')

  useEffect(() => {
    if (!open) return
    fetch('/api/config').then(r => r.json()).then(cfg => {
      if (cfg.defaultServer)   setServer(cfg.defaultServer)
      if (cfg.defaultAuthType) setAuthType(cfg.defaultAuthType)
      if (cfg.defaultDb && cfg.defaultDb !== 'master') setDatabase(cfg.defaultDb)
    }).catch(() => {})
  }, [open])

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

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent style={{ maxWidth: 520, padding: 0, overflow: 'hidden' }}>

        {/* ── Header — always dark ── */}
        <div style={{
          background: 'var(--header-bg)',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          padding: '18px 22px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: 'rgba(255,255,255,0.1)',
            border: '1px solid rgba(255,255,255,0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Server size={18} style={{ color: 'var(--header-server)' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#f1f5f9', lineHeight: 1.3 }}>
              Connect to SQL Server
            </div>
            <div style={{ fontSize: 12, color: 'var(--header-status-txt)', marginTop: 2 }}>
              Add a new monitored instance
            </div>
          </div>
          <DialogClose asChild>
            <button
              style={{
                width: 32, height: 32,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#64748b', borderRadius: 7, border: 'none',
                background: 'transparent', cursor: 'pointer', transition: 'all .15s',
                flexShrink: 0,
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; e.currentTarget.style.color = '#e2e8f0' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748b' }}
            >
              <X size={15} />
            </button>
          </DialogClose>
        </div>

        {/* ── Tabs ── */}
        <div style={{
          display: 'flex',
          background: '#f1f5f9',
          // #cbd5e1 border is visible on both #f1f5f9 and white card below
          borderBottom: '1.5px solid #cbd5e1',
          padding: '0 22px',
        }}>
          {[
            { key: 'login',   label: 'Login' },
            { key: 'connstr', label: 'Connection String' },
          ].map(t => {
            const active = modalTab === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setModalTab(t.key)}
                style={{
                  padding: '11px 14px',
                  fontSize: 13,
                  fontWeight: active ? 700 : 500,
                  color: active ? '#2563eb' : '#64748b',
                  borderBottom: `2px solid ${active ? '#3b82f6' : 'transparent'}`,
                  marginBottom: -1,
                  background: 'none',
                  border: 'none',
                  borderBottomWidth: 2,
                  borderBottomStyle: 'solid',
                  borderBottomColor: active ? '#3b82f6' : 'transparent',
                  cursor: 'pointer',
                  transition: 'all .15s',
                  minHeight: 44,
                  whiteSpace: 'nowrap',
                }}
              >
                {t.label}
              </button>
            )
          })}
        </div>

        {/* ── Form body ── */}
        <div style={{
          padding: '20px 22px 24px',
          background: '#fff',
          overflowY: 'auto',
          maxHeight: '70vh',
        }}>
          <form
            onSubmit={modalTab === 'login' ? handleLoginSubmit : e => { e.preventDefault(); handleConnStrSubmit() }}
            autoComplete="off"
          >

            {/* ── Login tab ── */}
            {modalTab === 'login' && (
              <div>

                {/* Connection group label — #475569 (7.5:1 on white) */}
                <div style={{ marginBottom: 4 }}>
                  <div style={{
                    fontSize: 10, fontWeight: 800, color: '#475569',
                    textTransform: 'uppercase', letterSpacing: '.09em', marginBottom: 12,
                  }}>
                    Connection
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div>
                      <Label>Server</Label>
                      <Input
                        value={server}
                        onChange={e => setServer(e.target.value)}
                        placeholder="SERVER\INSTANCE  or  SERVER,PORT"
                        required
                      />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <div>
                        <Label>
                          Label{' '}
                          <span style={{ fontWeight: 400, textTransform: 'none', fontSize: 10, color: '#94a3b8' }}>
                            (optional)
                          </span>
                        </Label>
                        <Input
                          value={label}
                          onChange={e => setLabel(e.target.value)}
                          placeholder="e.g. Production"
                        />
                      </div>
                      <div>
                        <Label>Database</Label>
                        <Input
                          value={database}
                          onChange={e => setDatabase(e.target.value)}
                          placeholder="master"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Authentication */}
                <Section title="Authentication" defaultOpen={true}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div>
                      <Label>Auth Type</Label>
                      <Seg
                        options={[
                          { value: 'windows', label: 'Windows Auth' },
                          { value: 'sql',     label: 'SQL Auth' },
                        ]}
                        value={authType}
                        onChange={setAuthType}
                      />
                    </div>
                    {authType === 'sql' && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <div>
                          <Label>Username</Label>
                          <Input
                            value={user}
                            onChange={e => setUser(e.target.value)}
                            placeholder="sa"
                            autoComplete="username"
                          />
                        </div>
                        <div>
                          <Label>Password</Label>
                          <Input
                            type="password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            placeholder="••••••••"
                            autoComplete="current-password"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </Section>

                {/* Security */}
                <Section title="Security">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'end' }}>
                      <div>
                        <Label>Encryption</Label>
                        <SelInput value={encrypt} onChange={e => setEncrypt(e.target.value)}>
                          <option value="false">Optional</option>
                          <option value="true">Mandatory</option>
                          <option value="strict">Strict (SQL 2022 / Azure)</option>
                        </SelInput>
                      </div>
                      <div>
                        <label style={{
                          display: 'flex', alignItems: 'center', gap: 9,
                          cursor: 'pointer', userSelect: 'none',
                          minHeight: 44, paddingBottom: 2,
                        }}>
                          <input
                            type="checkbox"
                            checked={trustCert}
                            onChange={e => setTrustCert(e.target.checked)}
                            style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#3b82f6', flexShrink: 0 }}
                          />
                          <span style={{ fontSize: 13, color: '#1e293b', fontWeight: 500 }}>
                            Trust Certificate
                          </span>
                        </label>
                      </div>
                    </div>
                    {encrypt === 'strict' && (
                      <div>
                        <Label>Host Name in Certificate</Label>
                        <Input
                          value={hostname}
                          onChange={e => setHostname(e.target.value)}
                          placeholder="e.g. *.contoso.com"
                        />
                      </div>
                    )}
                  </div>
                </Section>

                {/* Advanced */}
                <Section title="Advanced">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div>
                      <Label>Application Intent</Label>
                      <Seg
                        options={[
                          { value: 'ReadWrite', label: 'ReadWrite' },
                          { value: 'ReadOnly',  label: 'ReadOnly' },
                        ]}
                        value={appIntent}
                        onChange={setAppIntent}
                      />
                    </div>
                    <div>
                      <Label>Tab Color</Label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                        {TAB_COLORS.map(c => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => setSelectedColor(c)}
                            title={c}
                            style={{
                              width: 22, height: 22,
                              borderRadius: '50%',
                              background: c,
                              border: selectedColor === c ? '2.5px solid #1e293b' : '2.5px solid transparent',
                              outline: selectedColor === c ? `2px solid ${c}` : 'none',
                              outlineOffset: 2,
                              cursor: 'pointer',
                              transition: 'transform .12s',
                              transform: selectedColor === c ? 'scale(1.22)' : 'scale(1)',
                            }}
                          />
                        ))}
                        <span style={{
                          marginLeft: 4,
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          fontSize: 11, color: '#64748b',
                        }}>
                          <span style={{
                            width: 20, height: 20, borderRadius: 5,
                            background: selectedColor,
                            border: '1.5px solid #cbd5e1',
                            display: 'inline-block', flexShrink: 0,
                          }} />
                          {selectedColor}
                        </span>
                      </div>
                    </div>
                  </div>
                </Section>

                {/* Error */}
                {error && (
                  <div style={{
                    marginTop: 14,
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    color: '#dc2626',
                    borderRadius: 8,
                    padding: '10px 14px',
                    fontSize: 12,
                    fontWeight: 500,
                    lineHeight: 1.5,
                  }}>
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    width: '100%',
                    marginTop: 18,
                    minHeight: 44,
                    padding: '11px',
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 700,
                    color: '#fff',
                    background: loading ? '#94a3b8' : 'var(--header-bg)',
                    border: 'none',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    transition: 'opacity .15s',
                    letterSpacing: '.02em',
                    boxShadow: loading ? 'none' : '0 2px 10px rgba(0,0,0,0.25)',
                  }}
                >
                  {loading ? 'Connecting…' : 'Connect'}
                </button>
              </div>
            )}

            {/* ── Connection string tab ── */}
            {modalTab === 'connstr' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
                  ADO.NET connection strings are supported.
                </p>
                <textarea
                  rows={6}
                  value={connStr}
                  onChange={e => setConnStr(e.target.value)}
                  placeholder="Paste connection string here…"
                  onFocus={e => { e.target.style.borderColor = '#3b82f6'; e.target.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.18)'; e.target.style.background = '#fff' }}
                  onBlur={e => { e.target.style.borderColor = '#94a3b8'; e.target.style.boxShadow = 'none'; e.target.style.background = '#f8fafc' }}
                  style={{
                    width: '100%',
                    background: '#f8fafc',
                    border: '1.5px solid #94a3b8',
                    color: '#1e293b',
                    borderRadius: 8,
                    padding: '10px 13px',
                    fontSize: 12,
                    fontFamily: "'Cascadia Code','Fira Code','Consolas',monospace",
                    lineHeight: 1.7,
                    outline: 'none',
                    resize: 'none',
                    boxSizing: 'border-box',
                    transition: 'all .15s',
                  }}
                />

                <div>
                  <Label>Tab Color</Label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                    {TAB_COLORS.map(c => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setSelectedColor(c)}
                        title={c}
                        style={{
                          width: 22, height: 22,
                          borderRadius: '50%',
                          background: c,
                          border: selectedColor === c ? '2.5px solid #1e293b' : '2.5px solid transparent',
                          outline: selectedColor === c ? `2px solid ${c}` : 'none',
                          outlineOffset: 2,
                          cursor: 'pointer',
                          transition: 'transform .12s',
                          transform: selectedColor === c ? 'scale(1.22)' : 'scale(1)',
                        }}
                      />
                    ))}
                  </div>
                </div>

                {error && (
                  <div style={{
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    color: '#dc2626',
                    borderRadius: 8,
                    padding: '10px 14px',
                    fontSize: 12,
                    fontWeight: 500,
                  }}>
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    width: '100%',
                    minHeight: 44,
                    padding: '11px',
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 700,
                    color: '#fff',
                    background: loading ? '#94a3b8' : 'var(--header-bg)',
                    border: 'none',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    transition: 'opacity .15s',
                    boxShadow: loading ? 'none' : '0 2px 10px rgba(0,0,0,0.25)',
                  }}
                >
                  {loading ? 'Connecting…' : 'Connect'}
                </button>
              </div>
            )}

          </form>
        </div>
      </DialogContent>
    </Dialog>
  )
}
