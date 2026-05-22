import { Outlet } from 'react-router';
import LeftNav from './nav/LeftNav';
import { useEventStream } from './api/sse';

export default function App() {
  useEventStream();
  return (
    <div className="grid grid-cols-[var(--nav-w)_1fr] h-screen w-screen overflow-hidden">
      <LeftNav />
      <main className="overflow-hidden min-w-0"><Outlet /></main>
    </div>
  );
}
