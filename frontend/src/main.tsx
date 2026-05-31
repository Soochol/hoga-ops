import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { LivePage } from './live/LivePage';
import Inventory from './pages/Inventory';
import { Screener } from './pages/Screener';
import Capture from './pages/Capture';
import Watchlist from './pages/Watchlist';
import Settings from './pages/Settings';
import './styles/global.css';

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } });

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route path="/" element={<Navigate to="/live" replace />} />
          <Route path="live" element={<LivePage />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="screener" element={<Screener />} />
          <Route path="capture" element={<Capture />} />
          <Route path="watchlist" element={<Watchlist />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>,
);
