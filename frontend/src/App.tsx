import { Outlet } from 'react-router';
import LeftNav from './nav/LeftNav';

export default function App() {
  return (
    <div className="grid grid-cols-[210px_1fr] h-screen w-screen overflow-hidden">
      <LeftNav />
      <main className="overflow-hidden min-w-0"><Outlet /></main>
    </div>
  );
}
