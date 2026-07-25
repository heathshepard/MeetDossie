import { createRoot } from 'react-dom/client';
import { AuthProvider } from './lib/auth';
import App from './App';
import './app.css';

createRoot(document.getElementById('root')!).render(
  <AuthProvider>
    <App />
  </AuthProvider>
);
