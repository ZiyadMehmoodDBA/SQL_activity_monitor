export const fmtNum = (n) => {
  if (n == null) return '—'
  return Number(n).toLocaleString()
}

export const fmtBytes = (bytes) => {
  if (bytes == null) return '—'
  if (bytes >= 1099511627776) return (bytes / 1099511627776).toFixed(1) + ' TB'
  if (bytes >= 1073741824)    return (bytes / 1073741824).toFixed(1) + ' GB'
  if (bytes >= 1048576)       return (bytes / 1048576).toFixed(1) + ' MB'
  return (bytes / 1024).toFixed(0) + ' KB'
}

export const fmtMs = (ms) => {
  if (ms == null) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  return h + 'h'
}

export const fmtJobDuration = (n) => {
  if (!n) return '—'
  const h = Math.floor(n / 10000)
  const m = Math.floor((n % 10000) / 100)
  const s = n % 100
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export const kSuffix = (n) => {
  if (n == null) return '—'
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}
