import React, { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogClose } from './ui/Dialog'
import { X } from 'lucide-react'

// ── Dark design tokens (matches reference image) ──────────────────────────────
const T = {
  bg:          '#0f172a',   // modal surface
  surface:     '#1e2937',   // input / seg track background
  border:      '#374151',   // all borders
  borderSub:   '#1f2937',   // subtle divider
  text:        '#f9fafb',   // primary text / input values
  textSub:     '#d1d5db',   // secondary labels
  label:       '#9ca3af',   // field labels (uppercase)
  placeholder: '#6b7280',
  accent:      '#3b82f6',
  accentHover: '#2563eb',
  accentRing:  'rgba(59,130,246,0.25)',
  danger:      '#fca5a5',
  dangerBg:    'rgba(239,68,68,0.15)',
  dangerBd:    'rgba(239,68,68,0.4)',
}

const TAB_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
  '#ec4899','#06b6d4','#84cc16','#f97316','#6366f1',
]

// ── Field components ──────────────────────────────────────────────────────────

function Label({ children, style }) {
  return (
    <label style={{
      display: 'block',
      fontSize: 11,
      fontWeight: 600,
      color: T.label,
      marginBottom: 7,
      letterSpacing: '.07em',
      textTransform: 'uppercase',
      ...style,
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
        background: T.surface,
        border: `1px solid ${focused ? T.accent : T.border}`,
        boxShadow: focused ? `0 0 0 3px ${T.accentRing}` : 'none',
        color: T.text,
        borderRadius: 8,
        padding: '10px 14px',
        fontSize: 13,
        outline: 'none',
        transition: 'border-color .15s, box-shadow .15s',
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
        background: T.surface,
        border: `1px solid ${focused ? T.accent : T.border}`,
        boxShadow: focused ? `0 0 0 3px ${T.accentRing}` : 'none',
        color: T.text,
        borderRadius: 8,
        padding: '10px 14px',
        fontSize: 13,
        outline: 'none',
        cursor: 'pointer',
        appearance: 'none',
        WebkitAppearance: 'none',
        transition: 'border-color .15s, box-shadow .15s',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </select>
  )
}

function Seg({ options, value, onChange }) {
  return (
    <div style={{
      display: 'flex',
      background: T.surface,
      borderRadius: 9,
      padding: 4,
      gap: 4,
      border: `1px solid ${T.border}`,
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
              fontSize: 13,
              fontWeight: active ? 700 : 500,
              borderRadius: 7,
              transition: 'all .15s',
              color: active ? '#fff' : T.placeholder,
              background: active ? T.accent : 'transparent',
              boxShadow: active ? '0 2px 8px rgba(59,130,246,0.4)' : 'none',
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

function Divider() {
  return <div style={{ height: 1, background: T.border, margin: '18px 0' }} />
}

// ── Main component ────────────────────────────────────────────────────────────

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
      <DialogContent style={{ maxWidth: 520, padding: 0, overflow: 'hidden', background: T.bg, border: `1px solid ${T.border}` }}>

        {/* ── Header ── */}
        <div style={{
          padding: '20px 24px 0',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: T.surface,
            border: `1px solid ${T.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke={T.textSub} strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: T.text, lineHeight: 1.3 }}>
              Connect to SQL Server
            </div>
            <div style={{ fontSize: 12, color: T.label, marginTop: 2 }}>
              Add a new monitored instance
            </div>
          </div>
          <DialogClose asChild>
            <button
              style={{
                width: 32, height: 32,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: T.label, borderRadius: 7, border: `1px solid ${T.border}`,
                background: T.surface, cursor: 'pointer', transition: 'all .15s',
                flexShrink: 0,
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.text }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.label }}
            >
              <X size={14} />
            </button>
          </DialogClose>
        </div>

        {/* ── Tabs ── */}
        <div style={{
          display: 'flex',
          borderBottom: `1px solid ${T.border}`,
          padding: '0 24px',
          marginTop: 18,
          gap: 4,
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
                  padding: '10px 16px',
                  fontSize: 13,
                  fontWeight: active ? 700 : 500,
                  color: active ? T.accent : T.label,
                  borderBottom: `2px solid ${active ? T.accent : 'transparent'}`,
                  marginBottom: -1,
                  background: 'none',
                  border: 'none',
                  borderBottomWidth: 2,
                  borderBottomStyle: 'solid',
                  borderBottomColor: active ? T.accent : 'transparent',
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

        {/* ── Scrollable form body ── */}
        <div style={{ padding: '20px 24px 24px', overflowY: 'auto', maxHeight: '70vh' }}>
          <form
            onSubmit={modalTab === 'login' ? handleLoginSubmit : e => { e.preventDefault(); handleConnStrSubmit() }}
            autoComplete="off"
          >

            {/* ── Login tab ── */}
            {modalTab === 'login' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

                {/* Server */}
                <div>
                  <Label>Server</Label>
                  <Input
                    value={server}
                    onChange={e => setServer(e.target.value)}
                    placeholder="SERVER\INSTANCE  or  SERVER,PORT"
                    required
                  />
                </div>

                {/* Label + Database */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <Label>
                      Label{' '}
                      <span style={{ fontSize: 10, fontWeight: 400, textTransform: 'none', color: T.placeholder }}>
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

                {/* Authentication */}
                <div>
                  <Label>Authentication</Label>
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

                <Divider />

                {/* Security */}
                <Label style={{ marginBottom: 12 }}>Security</Label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'end', marginTop: -8 }}>
                  <div>
                    <Label>Encryption</Label>
                    <SelInput value={encrypt} onChange={e => setEncrypt(e.target.value)}>
                      <option value="false">Optional</option>
                      <option value="true">Mandatory</option>
                      <option value="strict">Strict (SQL 2022 / Azure)</option>
                    </SelInput>
                  </div>
                  <label style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    cursor: 'pointer', userSelect: 'none', minHeight: 44,
                  }}>
                    <input
                      type="checkbox"
                      checked={trustCert}
                      onChange={e => setTrustCert(e.target.checked)}
                      style={{ width: 16, height: 16, cursor: 'pointer', accentColor: T.accent, flexShrink: 0 }}
                    />
                    <span style={{ fontSize: 13, color: T.textSub, fontWeight: 500 }}>
                      Trust Server Certificate
                    </span>
                  </label>
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

                {/* Application Intent */}
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

                {/* Tab Color */}
                <div>
                  <Label>Tab Color</Label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                    {TAB_COLORS.map(c => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setSelectedColor(c)}
                        title={c}
                        style={{
                          width: 26, height: 26,
                          borderRadius: '50%',
                          background: c,
                          border: selectedColor === c ? '2.5px solid #fff' : '2.5px solid transparent',
                          outline: selectedColor === c ? `2px solid ${c}` : 'none',
                          outlineOffset: 2,
                          cursor: 'pointer',
                          transition: 'transform .12s',
                          transform: selectedColor === c ? 'scale(1.2)' : 'scale(1)',
                        }}
                      />
                    ))}
                  </div>
                </div>

                {/* Error */}
                {error && (
                  <div style={{
                    background: T.dangerBg,
                    border: `1px solid ${T.dangerBd}`,
                    color: T.danger,
                    borderRadius: 8,
                    padding: '10px 14px',
                    fontSize: 12,
                    fontWeight: 500,
                    lineHeight: 1.5,
                  }}>
                    {error}
                  </div>
                )}

                {/* Connect button */}
                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    width: '100%',
                    minHeight: 46,
                    padding: '12px',
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 700,
                    color: '#fff',
                    background: loading ? T.border : T.accent,
                    border: 'none',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    transition: 'background .15s',
                    letterSpacing: '.02em',
                    boxShadow: loading ? 'none' : '0 4px 14px rgba(59,130,246,0.4)',
                    marginTop: 4,
                  }}
                  onMouseEnter={e => { if (!loading) e.currentTarget.style.background = T.accentHover }}
                  onMouseLeave={e => { if (!loading) e.currentTarget.style.background = T.accent }}
                >
                  {loading ? 'Connecting…' : 'Connect'}
                </button>

              </div>
            )}

            {/* ── Connection string tab ── */}
            {modalTab === 'connstr' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <p style={{ fontSize: 12, color: T.label, margin: 0 }}>
                  ADO.NET connection strings are supported.
                </p>
                <textarea
                  rows={7}
                  value={connStr}
                  onChange={e => setConnStr(e.target.value)}
                  placeholder="Paste connection string here…"
                  onFocus={e => { e.target.style.borderColor = T.accent; e.target.style.boxShadow = `0 0 0 3px ${T.accentRing}` }}
                  onBlur={e => { e.target.style.borderColor = T.border; e.target.style.boxShadow = 'none' }}
                  style={{
                    width: '100%',
                    background: T.surface,
                    border: `1px solid ${T.border}`,
                    color: T.text,
                    borderRadius: 8,
                    padding: '10px 14px',
                    fontSize: 12,
                    fontFamily: "'Cascadia Code','Fira Code','Consolas',monospace",
                    lineHeight: 1.7,
                    outline: 'none',
                    resize: 'none',
                    boxSizing: 'border-box',
                    transition: 'border-color .15s, box-shadow .15s',
                  }}
                />

                <div>
                  <Label>Tab Color</Label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                    {TAB_COLORS.map(c => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setSelectedColor(c)}
                        title={c}
                        style={{
                          width: 26, height: 26,
                          borderRadius: '50%',
                          background: c,
                          border: selectedColor === c ? '2.5px solid #fff' : '2.5px solid transparent',
                          outline: selectedColor === c ? `2px solid ${c}` : 'none',
                          outlineOffset: 2,
                          cursor: 'pointer',
                          transition: 'transform .12s',
                          transform: selectedColor === c ? 'scale(1.2)' : 'scale(1)',
                        }}
                      />
                    ))}
                  </div>
                </div>

                {error && (
                  <div style={{
                    background: T.dangerBg,
                    border: `1px solid ${T.dangerBd}`,
                    color: T.danger,
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
                    minHeight: 46,
                    padding: '12px',
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 700,
                    color: '#fff',
                    background: loading ? T.border : T.accent,
                    border: 'none',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    transition: 'background .15s',
                    boxShadow: loading ? 'none' : '0 4px 14px rgba(59,130,246,0.4)',
                  }}
                  onMouseEnter={e => { if (!loading) e.currentTarget.style.background = T.accentHover }}
                  onMouseLeave={e => { if (!loading) e.currentTarget.style.background = T.accent }}
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
