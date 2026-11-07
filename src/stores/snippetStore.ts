import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
}

export const useSnippetStore = create<SnippetState>()(
  persist(
    (set) => ({
      snippets: [],

      addSnippet: (draft) => {
        const snippet: Snippet = {
          id: crypto.randomUUID(),
          name: draft.name.trim() || draft.command.trim() || '片段',
          command: draft.command
        };
        set((state) => ({ snippets: [...state.snippets, snippet] }));
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
      },

      removeSnippet: (id) => {
        set((state) => ({ snippets: state.snippets.filter((snippet) => snippet.id !== id) }));
      }
    }),
    { name: 'nexterm.snippets.v1' }
  )
);
