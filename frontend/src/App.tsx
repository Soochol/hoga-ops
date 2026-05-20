import { Outlet } from 'react-router';

export default function App() {
  return (
    <div className="grid grid-cols-[210px_1fr] h-screen w-screen overflow-hidden">
      <nav className="bg-bg-subtle border-r" />
      <main className="overflow-hidden min-w-0"><Outlet /></main>
    </div>
  );
}
