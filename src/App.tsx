import { TerminalSquare } from 'lucide-react';
import DockLayout from './components/layout/DockLayout';

export default function App() {
  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        <TerminalSquare className="h-4 w-4" />
        <span className="text-sm font-medium">NexTerm</span>
      </header>
      <main className="min-h-0 flex-1">
        <DockLayout />
      </main>
    </div>
  );
}
