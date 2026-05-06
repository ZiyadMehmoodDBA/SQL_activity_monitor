import React, { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogClose } from './ui/Dialog'

const TAB_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316','#6366f1'
]

export default function ConnectModal({ open, onClose, onConnected }) {
  const [modalTab, setModalTab] = useState('login')
  const [authType, setAuthType] = useState('windows')
  const [appIntent, setAppIntent] = useState('ReadWrite')
  const [selectedColor, setSelectedColor] = useState(TAB_COLORS[0])
  const [encrypt, setEncrypt] = useState('false')
  const [trustCert, setTrustCert] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Form state
  const [server, setServer] = useState('')
  const [label, setLabel] = useState('')
  const [database, setDatabase] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [hostname, setHostname] = useState('')
  const [connStr, setConnStr] = useState('')

  // Load defaults from /api/config
  useEffect(() => {
    if (!open) return
    fetch('/api/config').then(r => r.json()).then(cfg => {
      if (cfg.defaultServer) setServer(cfg.defaultServer)
      if (cfg.defaultAuthType) setAuthType(cfg.defaultAuthType)
      if (cfg.defaultDb && cfg.defaultDb !== 'master') setDatabase(cfg.defaultDb)
    }).catch(() => {})
  }, [open])

  async function handleConnect(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const body = {
        server, label, database,
        authType,
        user: authType === 'sql' ? user : undefined,
        password: authType === 'sql' ? password : undefined,
        encrypt,
        trustServerCert: trustCert,
        hostNameInCertificate: hostname || undefined,
        appIntent,
        color: selectedColor,
      }
      const res = await fetch('/api/connect', {
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

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'var(--header-bg)' }}>
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </div>
            <div>
              <div className="font-bold text-slate-800 text-base">Connect to SQL Server</div>
              <div className="text-slate-400 text-xs">Add a new monitored instance</div>
            </div>
            <DialogClose asChild>
              <button className="ml-auto text-slate-400 hover:text-slate-600 text-xl leading-none px-1">×</button>
            </DialogClose>
          </div>
          {/* Modal tabs */}
          <div className="flex gap-0 border-b border-slate-200 -mx-1">
            {['login', 'connstr'].map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setModalTab(t)}
                className={`modal-tab px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${modalTab === t ? 'active' : ''}`}
              >
                {t === 'login' ? 'Login' : 'Connection String'}
              </button>
            ))}
          </div>
        </DialogHeader>
        <DialogBody>
          <form onSubmit={handleConnect} autoComplete="off">
            {modalTab === 'login' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Server</label>
                  <input
                    value={server}
                    onChange={e => setServer(e.target.value)}
                    className="w-full px-3 py-2 border-[1.5px] border-slate-200 rounded-lg text-sm text-slate-800 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                    placeholder="SERVER\INSTANCE  or  SERVER,PORT"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                      Label <span className="normal-case font-normal text-slate-400">(optional)</span>
                    </label>
                    <input
                      value={label}
                      onChange={e => setLabel(e.target.value)}
                      className="w-full px-3 py-2 border-[1.5px] border-slate-200 rounded-lg text-sm text-slate-800 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                      placeholder="e.g. Production"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Database</label>
                    <input
                      value={database}
                      onChange={e => setDatabase(e.target.value)}
                      className="w-full px-3 py-2 border-[1.5px] border-slate-200 rounded-lg text-sm text-slate-800 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                      placeholder="master"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Authentication</label>
                  <div className="flex bg-slate-100 rounded-lg p-0.5 gap-0.5">
                    {['windows', 'sql'].map(t => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setAuthType(t)}
                        className={`flex-1 py-1.5 px-3 text-xs font-medium rounded-md transition-all ${authType === t ? 'bg-white shadow text-blue-600 font-semibold' : 'text-slate-500'}`}
                      >
                        {t === 'windows' ? 'Windows Auth' : 'SQL Auth'}
                      </button>
                    ))}
                  </div>
                </div>
                {authType === 'sql' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Username</label>
                      <input
                        value={user}
                        onChange={e => setUser(e.target.value)}
                        className="w-full px-3 py-2 border-[1.5px] border-slate-200 rounded-lg text-sm text-slate-800 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                        placeholder="sa"
                        autoComplete="username"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Password</label>
                      <input
                        type="password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        className="w-full px-3 py-2 border-[1.5px] border-slate-200 rounded-lg text-sm text-slate-800 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                        placeholder="••••••••"
                        autoComplete="current-password"
                      />
                    </div>
                  </div>
                )}
                {/* Security */}
                <div className="border-t border-slate-100 pt-3.5">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2.5">Security</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Encryption</label>
                      <select
                        value={encrypt}
                        onChange={e => setEncrypt(e.target.value)}
                        className="w-full px-3 py-2 border-[1.5px] border-slate-200 rounded-lg text-sm text-slate-800 focus:outline-none cursor-pointer"
                      >
                        <option value="false">Optional</option>
                        <option value="true">Mandatory</option>
                        <option value="strict">Strict (SQL 2022 / Azure)</option>
                      </select>
                    </div>
                    <div className="flex flex-col justify-end pb-2">
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={trustCert}
                          onChange={e => setTrustCert(e.target.checked)}
                          className="w-4 h-4 rounded"
                        />
                        <span className="text-sm text-slate-600">Trust Server Certificate</span>
                      </label>
                    </div>
                  </div>
                  {encrypt === 'strict' && (
                    <div className="mt-3">
                      <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Host Name in Certificate</label>
                      <input
                        value={hostname}
                        onChange={e => setHostname(e.target.value)}
                        className="w-full px-3 py-2 border-[1.5px] border-slate-200 rounded-lg text-sm text-slate-800 focus:outline-none focus:border-blue-500"
                        placeholder="e.g. *.contoso.com"
                      />
                    </div>
                  )}
                  <div className="mt-3">
                    <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Application Intent</label>
                    <div className="flex bg-slate-100 rounded-lg p-0.5 gap-0.5">
                      {['ReadWrite', 'ReadOnly'].map(t => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setAppIntent(t)}
                          className={`flex-1 py-1.5 px-3 text-xs font-medium rounded-md transition-all ${appIntent === t ? 'bg-white shadow text-blue-600 font-semibold' : 'text-slate-500'}`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mt-3">
                    <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2">Tab Color</label>
                    <div className="flex items-center gap-2 flex-wrap">
                      {TAB_COLORS.map(c => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setSelectedColor(c)}
                          className={`w-5 h-5 rounded-full cursor-pointer border-2 transition-transform hover:scale-110 ${selectedColor === c ? 'scale-110' : 'border-transparent'}`}
                          style={{ background: c, borderColor: selectedColor === c ? '#1e293b' : 'transparent' }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
                {error && (
                  <div className="bg-red-50 border border-red-200 text-red-600 rounded-lg px-3 py-2.5 text-xs">
                    {error}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-85 disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ background: 'var(--header-bg)' }}
                >
                  {loading ? 'Connecting…' : 'Connect'}
                </button>
              </div>
            )}
            {modalTab === 'connstr' && (
              <div className="space-y-3">
                <p className="text-xs text-slate-400">Note: Only ADO.NET connection strings are supported.</p>
                <textarea
                  value={connStr}
                  onChange={e => setConnStr(e.target.value)}
                  rows={6}
                  className="w-full px-3 py-2 border-[1.5px] border-slate-200 rounded-lg font-mono text-[11px] leading-relaxed resize-none focus:outline-none focus:border-blue-500"
                  placeholder="Paste connection string here…"
                />
                {error && (
                  <div className="bg-red-50 border border-red-200 text-red-600 rounded-lg px-3 py-2.5 text-xs">
                    {error}
                  </div>
                )}
                <button
                  type="button"
                  disabled={loading}
                  onClick={async () => {
                    setError('')
                    setLoading(true)
                    try {
                      const res = await fetch('/api/connect', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ connectionString: connStr, color: selectedColor }),
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
                  }}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-85 disabled:opacity-50"
                  style={{ background: 'var(--header-bg)' }}
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
