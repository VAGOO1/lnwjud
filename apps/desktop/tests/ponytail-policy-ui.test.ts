import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PonytailPolicyEditor } from '../src/renderer/features/settings/PonytailPolicyEditor.js';

describe('Ponytail scoped settings UI', () => {
  it('inherits Global Full into Workspace and Goal without requiring duplicate Full selections', () => {
    const markup = renderToStaticMarkup(createElement(PonytailPolicyEditor, {
      locale: 'en',
      globalMode: 'full',
      context: {
        workspaceId: 'workspace-1',
        globalMode: 'full',
        workspaceMode: 'inherit',
        effectiveWorkspaceMode: 'full',
        effectiveWorkspaceSource: 'global',
        activeGoals: [{
          goalId: 'goal-1',
          goalKey: 'demo-goal',
          mode: 'inherit',
          revision: 7,
          effectiveMode: 'full',
          effectiveSource: 'global',
          editable: true,
          editBlockedReason: null,
        }],
      },
      busy: false,
      error: null,
      onGlobalModeChange: async () => undefined,
      onWorkspaceModeChange: async () => undefined,
      onGoalModeChange: async () => undefined,
    }));

    expect(markup.match(/id="ponytail-global-mode"/g)?.length).toBe(1);
    expect(markup.match(/id="ponytail-workspace-mode"/g)?.length).toBe(1);
    expect(markup).toContain('EFFECTIVE Full');
    expect(markup).toContain('Workspace override');
    expect(markup).toContain('Current Goal overrides');
    expect(markup).toContain('Inherit Global');
    expect(markup).toContain('Inherit Workspace');
  });
});
