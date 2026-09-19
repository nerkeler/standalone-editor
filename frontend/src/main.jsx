import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
import { applyTheme, getInitialTheme } from './theme'

// Apply the saved/system theme before React paints to avoid a light-mode flash.
applyTheme(getInitialTheme())

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
