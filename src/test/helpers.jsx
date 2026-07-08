import React from 'react'
import { render } from '@testing-library/react'
import { AppProvider } from '../context/AppContext'
import { ConnectionProvider } from '../context/ConnectionContext'

// ── Render helper ──────────────────────────────────────────────────────────────
export function renderWithContext(ui) {
  return render(
    <AppProvider>
      <ConnectionProvider>{ui}</ConnectionProvider>
    </AppProvider>
  )
}

// ── Profile factory ───────────────────────────────────────────────────────────
export function makeProfileFixture(overrides = {}) {
  return {
    schemaVersion: 1, id: 'c1', displayName: 'Dev', serverName: 'DEV',
    authenticationType: 'windows', autoConnect: false, displayOrder: 0,
    color: '#3b82f6', appIntent: 'ReadWrite', createdAt: 't', updatedAt: 't',
    ...overrides,
  }
}

// ── Mock data factories ────────────────────────────────────────────────────────

export function makeJob(overrides = {}) {
  return {
    job_id: 'job-001',
    job_name: 'Test Backup Job',
    enabled: 1,
    last_run_outcome: 1,
    last_run_date: '2026-05-06T12:00:00',
    last_run_duration: 150,
    next_run_date: '2026-05-07T12:00:00',
    status: 'Succeeded',
    ...overrides,
  }
}

export function makeSession(overrides = {}) {
  return {
    session_id: 51,
    host_name: 'DEVBOX01',
    login_name: 'sa',
    status: 'sleeping',
    cpu_time: 1200,
    elapsed_sec: 45,
    blocking_session_id: 0,
    wait_type: null,
    last_query: 'SELECT * FROM dbo.Orders',
    ...overrides,
  }
}

export function makeProcess(overrides = {}) {
  return {
    session_id: 52,
    login_name: 'appuser',
    host_name: 'APPSERVER',
    db_name: 'Northwind',
    status: 'running',
    cpu_time: 5000,
    elapsed_sec: 30,
    blocking_session_id: 0,
    wait_type: 'ASYNC_NETWORK_IO',
    last_query: 'SELECT TOP 100 * FROM Orders WHERE OrderDate > @dt',
    ...overrides,
  }
}

export function makeWiaRow(overrides = {}) {
  return {
    'session_id': 55,
    'login_name': 'sa',
    'host_name': 'SERVER01',
    'database_name': 'master',
    'dd hh:mm:ss.mss': '00 00:00:05.123',
    'sql_text': 'SELECT @@VERSION',
    'status': 'running',
    'wait_info': null,
    'blocking_session_id': null,
    ...overrides,
  }
}

export function makeMetrics(overrides = {}) {
  return {
    cpu_percent: 42,
    waiting_tasks: 3,
    db_io_mb: 1.5,
    batch_requests: 220,
    processes: [],
    jobs: [],
    resource_waits: [],
    file_io: [],
    recent_expensive: [],
    active_expensive: [],
    db_sizes: [],
    serverPerf: { netMbs: 0.5, compilationsSec: 15 },
    ...overrides,
  }
}
