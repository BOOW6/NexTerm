import { create } from 'zustand';

interface WorkspaceState {
  activeSessionId: string | null;
  sidebarVisible: boolean;
  setActiveSessionId: (id: string | null) => void;
  toggleSidebar: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeSessionId: null,
  sidebarVisible: true,
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible }))
}));
