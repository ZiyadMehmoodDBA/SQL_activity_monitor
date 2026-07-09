import React, { useMemo, memo } from 'react'
import ReactApexChart from 'react-apexcharts'

// Compact axis label formatter (matches KPIBar's cFmt)
function axFmt(v) {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (abs >= 1_000)     return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(v))
}

export default memo(function ChartCard({ title, subtitle, value, unit, history, color, yMax, timestamps }) {
  const series = useMemo(() => {
    const data = history && history.length > 0 ? history : Array(60).fill(null)
    if (timestamps && history && history.length > 0 && timestamps.length === history.length) {
      return [{ name: title, data: history.map((y, i) => ({ x: timestamps[i], y })) }]
    }
    return [{ name: title, data }]
  }, [history, timestamps, title])

  const options = useMemo(() => ({
    chart: {
      type: 'area',
      toolbar:    { show: false },
      sparkline:  { enabled: false },
      animations: {
        enabled: true,
        easing: 'linear',
        // dynamicAnimation disabled: animating every 2s data update burns frame
        // budget and causes transition conflicts during widget toggle cycles
        dynamicAnimation: { enabled: false },
      },
      background: 'transparent',
      redrawOnWindowResize: false,
      redrawOnParentResize: false,
    },
    stroke: { curve: 'smooth', width: 1.5 },
    fill: {
      type: 'gradient',
      gradient: {
        shadeIntensity: 1,
        opacityFrom: 0.28,
        opacityTo: 0.0,
        stops: [0, 100],
        colorStops: [
          { offset: 0,   color, opacity: 0.28 },
          { offset: 100, color, opacity: 0.0  },
        ],
      },
    },
    colors: [color],
    xaxis: {
      ...(timestamps ? { type: 'datetime' } : {}),
      labels:     { show: false },
      axisBorder: { show: false },
      axisTicks:  { show: false },
    },
    yaxis: {
      min: 0,
      ...(yMax ? { max: yMax } : {}),
      opposite: true,
      labels: {
        style: { colors: ['var(--text-muted)'], fontSize: '9px', fontFamily: 'inherit' },
        formatter: axFmt,
        offsetX: -4,
      },
      tickAmount: 3,
    },
    grid: {
      borderColor: 'rgba(0,0,0,.05)',
      strokeDashArray: 4,
      yaxis: { lines: { show: true  } },
      xaxis: { lines: { show: false } },
      padding: { top: 2, right: 2, bottom: 0, left: 0 },
    },
    legend:     { show: false },
    dataLabels: { enabled: false },
    tooltip: {
      theme: 'dark',
      style: { fontSize: '11px' },
      x: {
        formatter: (val, { dataPointIndex, w }) => {
          if (timestamps) return new Date(val).toLocaleString()
          const total = w.globals.series[0].length
          const ago = (total - 1 - dataPointIndex) * 2
          return ago === 0 ? 'Now' : `${ago}s ago`
        },
      },
      y: {
        formatter: v => {
          if (v === null || v === undefined) return 'No data'
          return v >= 1000 ? Math.round(v).toLocaleString() : v % 1 === 0 ? v.toLocaleString() : v.toFixed(2)
        },
      },
    },
  }), [color, yMax, title, timestamps])

  return (
    // overflow:hidden prevents ApexCharts from momentarily overflowing the card boundary,
    // which would trigger a ResizeObserver → layout reflow → 1fr grid row growth loop.
    <div className="mc flex flex-col" style={{ padding: '18px 18px 12px', overflow: 'hidden', minHeight: 290, maxHeight: 360 }}>
      {/* Label */}
      <div style={{
        fontSize: 10,
        fontWeight: 700,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '.065em',
        marginBottom: 8,
      }}>
        {title}
      </div>

      {/* Value + subtitle */}
      <div className="flex items-end justify-between" style={{ marginBottom: 12 }}>
        <div className="font-bold leading-none tabular-nums" style={{ fontSize: 32, color, letterSpacing: '-.02em' }}>
          {value !== null && value !== undefined ? value : '--'}
          {unit && <span style={{ fontSize: 16, marginLeft: 3, opacity: 0.7 }}>{unit}</span>}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'right', lineHeight: 1.45, maxWidth: 100 }}>
          {subtitle}
        </div>
      </div>

      {/* Chart — fixed 224px, never grows */}
      <div className="chart-wrap">
        <ReactApexChart
          type="area"
          series={series}
          options={options}
          height={224}
        />
      </div>
    </div>
  )
})
