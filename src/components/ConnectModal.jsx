import React, { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogClose } from './ui/Dialog'
import { ChevronDown, Server, X } from 'lucide-react'

const TAB_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
  '#ec4899','#06b6d4','#84cc16','#f97316','#6366f1',
]

// Field label
function Label({ children }) {
  return (
    <label style={{
      display: 'block',
      fontSize: 11,
      fontWeight: 700,
      color: '#334155',
      marginBottom: 5,
      letterSpacing: '.03em',
    }}>
      {children}
    </label>
  )
}

// Text / password input
function Input({ type = 'text', value, onChange, placeholder, required, autoComplete }) {
  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      required={required}
      autoComplete={autoComplete}
      style={{
        width: '100%',
        background: '#fff',
        border: '1.5px solid #cbd5e1',
        color: '#0f172a',
        borderRadius: 8,
        padding: '8px 11px',
        fontSize: 13,
        outline: 'none',
        transition: 'border-color .15s, box-shadow .15s',
        boxSizing: 'border-box',
      }}
      onFocus={e => { e.target.style.borderColor = '#3b82f6'; e.target.style.boxShadow = '0 0 0 3px rgba(59,130,246,.15)' }}
      onBlur={e => { e.target.style.borderColor = '#cbd5e1'; e.target.style.boxShadow = 'none' }}
    />
  )
}

// Select
function Select({ value, onChange, children, style }) {
  return (
    <select
      value={value}
      onChange={onChange}
      style={{
        width: '100%',
        background: '#fff',
        border: '1.5px solid #cbd5e1',
        color: '#0f172a',
        borderRadius: 8,
        padding: '8px 11px',
        fontSize: 13,
        outline: 'none',
        cursor: 'pointer',
        appearance: 'none',
        WebkitAppearance: 'none',
        transition: 'border-color .15s, box-shadow .15s',
        boxSizing: 'border-box',
        ...style,
      }}
      onFocus={e => { e.target.style.borderColor = '#3b82f6'; e.target.style.boxShadow = '0 0 0 3px rgba(59,130,246,.15)' }}
      onBlur={e => { e.target.style.borderColor = '#cbd5e1'; e.target.style.boxShadow = 'none' }}
    >
      {children}
    </select>
  )
}

// Segmented control
function Seg({ options, value, onChange }) {
  return (
    <div style={{
      display: 'flex',
      background: '#f1f5f9',
      borderRadius: 8,
      padding: 3,
      gap: 2,
      border: '1px solid #e2e8f0',
    }}>
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          style={{
            flex: 1,
            padding: '6px 10px',
            fontSize: 12,
            fontWeight: value === opt.value ? 700 : 500,
            borderRadius: 6,
            transition: 'all .15s',
            color: value === opt.value ? '#1e40af' : '#475569',
            background: value === opt.value ? '#fff' : 'transparent',
            boxShadow: value === opt.value ? '0 1px 4px rgba(0,0,0,.12)' : 'none',
            border: value === opt.value ? '1px solid #dbeafe' : '1px solid transparent',
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// Collapsible section
function Section({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ borderTop: '1px solid #e2e8f0' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '9px 0',
          cursor: 'pointer',
          background: 'none',
          border: 'none',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          {title}
        </span>
        <ChevronDown
          size={13}
          style={{ color: '#94a3b8', transition: 'transform .15s', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', flexShrink: 0 }}
        />
      </button>
      {open && <div style={{ paddingBottom: 14 }}>{children}</div>}
    </div>
  )
}

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
      <DialogContent style={{ maxWidth: 520, overflow: 'hidden', padding: 0 }}>

        {/* ── Dark header ── */}
        <div style={{
          background: 'var(--header-bg)',
          padding: '18px 22px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 9,
            background: 'rgba(255,255,255,.12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Server size={18} style={{ color: '#93c5fd' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#f1f5f9' }}>
              Connect to SQL Server
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 1 }}>
              Add a new monitored instance
            </div>
          </div>
          <DialogClose asChild>
            <button
              style={{ color: '#64748b', borderRadius: 7, padding: '4px 6px', lineHeight: 1, transition: 'all .15s' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,.1)'; e.currentTarget.style.color = '#e2e8f0' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748b' }}
            >
              <X size={16} />
            </button>
          </DialogClose>
        </div>

        {/* ── Tabs ── */}
        <div style={{
          display: 'flex',
          background: '#f8fafc',
          borderBottom: '1px solid #e2e8f0',
          padding: '0 22px',
          gap: 0,
        }}>
          {[
            { key: 'login',   label: 'Login' },
            { key: 'connstr', label: 'Connection String' },
          ].map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setModalTab(t.key)}
              style={{
                padding: '10px 14px',
                fontSize: 13,
                fontWeight: modalTab === t.key ? 700 : 500,
                color: modalTab === t.key ? '#1e40af' : '#64748b',
                borderBottom: modalTab === t.key ? '2px solid #3b82f6' : '2px solid transparent',
                marginBottom: -1,
                transition: 'all .15s',
                background: 'none',
                border: 'none',
                borderBottomWidth: 2,
                borderBottomStyle: 'solid',
                borderBottomColor: modalTab === t.key ? '#3b82f6' : 'transparent',
                cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Body ── */}
        <div style={{ padding: '20px 22px 22px', background: '#fff' }}>
          <form
            onSubmit={modalTab === 'login' ? handleLoginSubmit : e => { e.preventDefault(); handleConnStrSubmit() }}
            autoComplete="off"
          >

            {/* ── Login tab ── */}
            {modalTab === 'login' && (
              <div>

                {/* Connection group */}
                <div style={{ marginBottom: 4 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 10 }}>
                    Connection
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div>
                      <Label>Server</Label>
                      <Input
                        value={server}
                        onChange={e => setServer(e.target.value)}
                        placeholder="SERVER\INSTANCE  or  SERVER,PORT"
                        required
                      />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div>
                        <Label>
                          Label <span style={{ fontWeight: 400, fontSize: 10, color: '#94a3b8', textTransform: 'none' }}>(optional)</span>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignItems: 'end' }}>
                      <div>
                        <Label>Encryption</Label>
                        <Select value={encrypt} onChange={e => setEncrypt(e.target.value)}>
                          <option value="false">Optional</option>
                          <option value="true">Mandatory</option>
                          <option value="strict">Strict (SQL 2022 / Azure)</option>
                        </Select>
                      </div>
                      <div style={{ paddingBottom: 3 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
                          <input
                            type="checkbox"
                            checked={trustCert}
                            onChange={e => setTrustCert(e.target.checked)}
                            style={{ width: 15, height: 15, cursor: 'pointer', accentColor: '#3b82f6' }}
                          />
                          <span style={{ fontSize: 13, color: '#334155', fontWeight: 500 }}>Trust Certificate</span>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginTop: 4 }}>
                        {TAB_COLORS.map(c => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => setSelectedColor(c)}
                            title={c}
                            style={{
                              width: 20, height: 20,
                              borderRadius: '50%',
                              background: c,
                              border: selectedColor === c ? `2px solid #0f172a` : '2px solid transparent',
                              outline: selectedColor === c ? `2px solid ${c}` : 'none',
                              outlineOffset: 2,
                              cursor: 'pointer',
                              transition: 'transform .12s',
                              transform: selectedColor === c ? 'scale(1.25)' : 'scale(1)',
                            }}
                          />
                        ))}
                        <span style={{
                          marginLeft: 4,
                          display: 'inline-block',
                          width: 20, height: 20,
                          borderRadius: 5,
                          background: selectedColor,
                          border: '2px solid rgba(0,0,0,.12)',
                          flexShrink: 0,
                        }} />
                      </div>
                    </div>
                  </div>
                </Section>

                {error && (
                  <div style={{
                    marginTop: 12,
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    color: '#dc2626',
                    borderRadius: 8,
                    padding: '8px 12px',
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
                    marginTop: 16,
                    padding: '11px',
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 700,
                    color: '#fff',
                    background: loading ? '#94a3b8' : 'var(--header-bg)',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    transition: 'background .15s',
                    letterSpacing: '.01em',
                  }}
                >
                  {loading ? 'Connecting…' : 'Connect'}
                </button>
              </div>
            )}

            {/* ── Connection string tab ── */}
            {modalTab === 'connstr' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
                  ADO.NET connection strings are supported.
                </p>
                <textarea
                  rows={6}
                  value={connStr}
                  onChange={e => setConnStr(e.target.value)}
                  placeholder="Paste connection string here…"
                  style={{
                    width: '100%',
                    background: '#fff',
                    border: '1.5px solid #cbd5e1',
                    color: '#0f172a',
                    borderRadius: 8,
                    padding: '8px 12px',
                    fontSize: 12,
                    fontFamily: "'Cascadia Code','Fira Code','Consolas',monospace",
                    lineHeight: 1.6,
                    outline: 'none',
                    resize: 'none',
                    boxSizing: 'border-box',
                    transition: 'border-color .15s, box-shadow .15s',
                  }}
                  onFocus={e => { e.target.style.borderColor = '#3b82f6'; e.target.style.boxShadow = '0 0 0 3px rgba(59,130,246,.15)' }}
                  onBlur={e => { e.target.style.borderColor = '#cbd5e1'; e.target.style.boxShadow = 'none' }}
                />

                <div>
                  <Label>Tab Color</Label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginTop: 4 }}>
                    {TAB_COLORS.map(c => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setSelectedColor(c)}
                        title={c}
                        style={{
                          width: 20, height: 20,
                          borderRadius: '50%',
                          background: c,
                          border: selectedColor === c ? `2px solid #0f172a` : '2px solid transparent',
                          outline: selectedColor === c ? `2px solid ${c}` : 'none',
                          outlineOffset: 2,
                          cursor: 'pointer',
                          transition: 'transform .12s',
                          transform: selectedColor === c ? 'scale(1.25)' : 'scale(1)',
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
                    padding: '8px 12px',
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
                    padding: '11px',
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 700,
                    color: '#fff',
                    background: loading ? '#94a3b8' : 'var(--header-bg)',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    transition: 'background .15s',
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
