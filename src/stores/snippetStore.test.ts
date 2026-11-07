import { beforeEach, describe, expect, it } from 'vitest';
import { useSnippetStore } from './snippetStore';

describe('snippetStore', () => {
  beforeEach(() => {
    useSnippetStore.setState({ snippets: [] });
  });

  it('adds a snippet with a trimmed name fallback', () => {
    const created = useSnippetStore.getState().addSnippet({ name: '  ', command: 'htop' });
    const snippets = useSnippetStore.getState().snippets;
    expect(snippets).toHaveLength(1);
    expect(snippets[0].name).toBe('htop');
    expect(snippets[0].command).toBe('htop');
    expect(created.id).toBeTruthy();
  });

  it('updates only the targeted snippet and keeps a cleared name at the old one', () => {
    const store = useSnippetStore.getState();
    const first = store.addSnippet({ name: 'first', command: 'ls' });
    store.addSnippet({ name: 'second', command: 'pwd' });

    useSnippetStore.getState().updateSnippet(first.id, { command: 'ls -la', name: '   ' });

    const snippets = useSnippetStore.getState().snippets;
    expect(snippets[0].command).toBe('ls -la');
    expect(snippets[0].name).toBe('first');
    expect(snippets[1].name).toBe('second');
  });

  it('removes the targeted snippet', () => {
    const store = useSnippetStore.getState();
    const first = store.addSnippet({ name: 'first', command: 'ls' });
    store.addSnippet({ name: 'second', command: 'pwd' });

    useSnippetStore.getState().removeSnippet(first.id);

    expect(useSnippetStore.getState().snippets.map((snippet) => snippet.name)).toEqual(['second']);
  });
});
