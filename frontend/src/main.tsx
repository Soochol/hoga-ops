import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { LivePage } from './live/LivePage';
import Inventory from './pages/Inventory';
import { Screener } from './pages/Screener';
import Capture from './pages/Capture';
import Settings from './pages/Settings';
import { Heatmap } from './pages/Heatmap';
import { initLiveTabsSync } from './state/liveTabs';
import './styles/global.css';

const _disposeLiveTabsSync = initLiveTabsSync();
if (import.meta.hot) import.meta.hot.dispose(_disposeLiveTabsSync);

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } });

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route path="/" element={<Navigate to="/live" replace />} />
          <Route path="live" element={<LivePage />} />
          <Route path="heatmap" element={<Heatmap />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="screener" element={<Screener />} />
          <Route path="capture" element={<Capture />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>,
);
