import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { AppProvider } from './context/AppContext'
import { ConnectionProvider } from './context/ConnectionContext'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppProvider>
      <ConnectionProvider>
        <App />
      </ConnectionProvider>
    </AppProvider>
  </React.StrictMode>
)
