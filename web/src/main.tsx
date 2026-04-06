import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// No StrictMode — avoids double-mount of Deck.gl / WebGL under dev
createRoot(document.getElementById('root')!).render(<App />)
