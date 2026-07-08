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
import { StudyPage } from './studyViews/StudyPage';
import { initLiveTabsSync } from './state/liveTabs';
import { initStudyTabsSync } from './state/studyTabs';
import './styles/global.css';

const _disposeLiveTabsSync = initLiveTabsSync();
const _disposeStudyTabsSync = initStudyTabsSync();
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _disposeLiveTabsSync();
    _disposeStudyTabsSync();
  });
}

// refetchOnWindowFocus/Reconnect default to true — a tab refocus or network
// blip fires every active /live poll at once, and each sidecar refetch can
// launch the heavy peak query on the backend. Disabling both cuts that burst
// at the source (the interval polls still keep data fresh).
const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      // Default gcTime is 5 min. Past-only /live chunks are immutable and now
      // frozen (staleTime Infinity, no poll); a longer gcTime keeps a code's
      // walk-back chunks cached across a switch-away so revisiting within the
      // window re-derives the merged history from cache, not the network.
      gcTime: 30 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route path="/" element={<Navigate to="/live" replace />} />
          <Route path="live" element={<LivePage />} />
          <Route path="study" element={<StudyPage />} />
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
