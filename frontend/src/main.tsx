import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import ReplayViewer from './pages/ReplayViewer';
import Inventory from './pages/Inventory';
import Capture from './pages/Capture';
import Settings from './pages/Settings';
import './styles/global.css';

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } });

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route path="/" element={<Navigate to="/replay" replace />} />
          <Route path="replay" element={<ReplayViewer />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="capture" element={<Capture />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>,
);
