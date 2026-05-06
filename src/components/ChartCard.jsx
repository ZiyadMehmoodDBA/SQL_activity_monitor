import React, { useMemo } from 'react'
import ReactApexChart from 'react-apexcharts'

export default function ChartCard({ title, subtitle, value, unit, history, color, yMax }) {
  const series = useMemo(() => [{
    name: title,
    data: history && history.length > 0 ? history : Array(60).fill(null),
  }], [history, title])

  const options = useMemo(() => ({
    chart: {
      type: 'area',
      toolbar: { show: false },
      sparkline: { enabled: false },
      animations: {
        enabled: true,
        easing: 'linear',
        dynamicAnimation: { enabled: true, speed: 350 },
      },
      background: 'transparent',
    },
    stroke: { curve: 'smooth', width: 2 },
    fill: {
      type: 'gradient',
      gradient: {
        shadeIntensity: 1,
        opacityFrom: 0.4,
        opacityTo: 0.0,
        stops: [0, 90, 100],
        colorStops: [
          { offset: 0,   color: color, opacity: 0.35 },
          { offset: 50,  color: color, opacity: 0.1  },
          { offset: 100, color: color, opacity: 0.0  },
        ],
      },
    },
    colors: [color],
    xaxis: {
      labels: { show: false },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },
    yaxis: {
      min: 0,
      ...(yMax ? { max: yMax } : {}),
      opposite: true,
      labels: {
        style: { colors: '#94a3b8', fontSize: '10px' },
        formatter: (v) => v >= 1000 ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k' : String(Math.round(v)),
      },
      tickAmount: 4,
    },
    grid: {
      borderColor: 'rgba(0,0,0,.04)',
      strokeDashArray: 3,
      yaxis: { lines: { show: true } },
      xaxis: { lines: { show: false } },
      padding: { top: 4, right: 4, bottom: 0, left: 0 },
    },
    legend: { show: false },
    dataLabels: { enabled: false },
    tooltip: {
      theme: 'dark',
      style: { fontSize: '11px' },
      x: {
        formatter: (val, { dataPointIndex, w }) => {
          const total = w.globals.series[0].length
          const ago = (total - 1 - dataPointIndex) * 2
          return ago === 0 ? 'Now' : `${ago}s ago`
        },
      },
      y: {
        formatter: (val) => {
          if (val === null || val === undefined) return 'No data'
          return val >= 1000 ? Math.round(val).toLocaleString() : val % 1 === 0 ? val.toLocaleString() : val.toFixed(2)
        },
      },
    },
  }), [color, yMax, title])

  return (
    <div className="mc flex flex-col" style={{ padding: '20px 20px 16px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 6 }}>
        {title}
      </div>
      <div className="flex items-end justify-between mb-4">
        <div
          className="font-bold leading-none tabular-nums"
          style={{ fontSize: 38, color }}
        >
          {value !== null && value !== undefined ? value : '--'}
          {unit && <span style={{ fontSize: 18, marginLeft: 4 }}>{unit}</span>}
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', textAlign: 'right', lineHeight: 1.4, maxWidth: 110 }}>
          {subtitle}
        </div>
      </div>
      <div className="chart-wrap flex-1">
        <ReactApexChart
          type="area"
          series={series}
          options={options}
          height="100%"
        />
      </div>
    </div>
  )
}
