import { create } from 'zustand';
import { tStatic } from '../i18n';
import { persist } from 'zustand/middleware';
import { emit } from '@tauri-apps/api/event';

export interface Snippet {
  id: string;
  name: string;
  command: string;
}

export interface SnippetDraft {
  name: string;
  command: string;
}

interface SnippetState {
  snippets: Snippet[];
  addSnippet: (draft: SnippetDraft) => Snippet;
  updateSnippet: (id: string, patch: Partial<SnippetDraft>) => void;
  removeSnippet: (id: string) => void;
  /** Replace the whole list from a cross-window broadcast. */
  replaceSnippets: (incoming: unknown) => void;
}

function isSnippet(value: unknown): value is Snippet {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.command === 'string'
  );
}

/**
 * The settings window owns snippet CRUD and persists through the shared
 * localStorage key, but this window's zustand instance only hydrates once at
 * startup — without the broadcast the command palette would serve stale
 * snippets until a full restart.
 */
function broadcastSnippetsChanged(snippets: Snippet[]): void {
  void emit('nexterm-snippets-changed', { snippets }).catch(() => undefined);
}

export const useSnippetStore = create<SnippetState>()(
  persist(
    (set) => ({
      snippets: [],

      addSnippet: (draft) => {
        const snippet: Snippet = {
          id: crypto.randomUUID(),
          name: draft.name.trim() || draft.command.trim() || tStatic('snippet.fallbackTitle'),
          command: draft.command
        };
        set((state) => ({ snippets: [...state.snippets, snippet] }));
        broadcastSnippetsChanged(useSnippetStore.getState().snippets);
        return snippet;
      },

      updateSnippet: (id, patch) => {
        set((state) => ({
          snippets: state.snippets.map((snippet) =>
            snippet.id === id
              ? {
                  ...snippet,
                  ...patch,
                  name: patch.name !== undefined ? patch.name.trim() || snippet.name : snippet.name
                }
              : snippet
          )
        }));
        broadcastSnippetsChanged(useSnippetStore.getState().snippets);
      },

      removeSnippet: (id) => {
        set((state) => ({ snippets: state.snippets.filter((snippet) => snippet.id !== id) }));
        broadcastSnippetsChanged(useSnippetStore.getState().snippets);
      },

      replaceSnippets: (incoming) => {
        set({ snippets: Array.isArray(incoming) ? incoming.filter(isSnippet) : [] });
      }
    }),
    { name: 'nexterm.snippets.v1' }
  )
);
