import ReactDOM from 'react-dom/client';
import { ThemeProvider } from './theme/ThemeProvider';
import WindowRoot from './windows/WindowRoot';
import './index.css';

// StrictMode is intentionally disabled: its dev double-invoke would spawn two
// PTY sessions per terminal (side effects are not idempotent in this app).
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <ThemeProvider>
    <WindowRoot />
  </ThemeProvider>
);
