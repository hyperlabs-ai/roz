import { describe, it, expect } from 'vitest';
import { renamedFrom } from '../src/routes/webhooks.js';

describe('renamedFrom', () => {
  it('rename: reconstruye el full_name viejo conservando el owner', () => {
    const payload = {
      repository: { full_name: 'hyperlabs-ai/roz', name: 'roz' },
      changes: { repository: { name: { from: 'hyper-roz' } } },
    };
    expect(renamedFrom(payload)).toBe('hyperlabs-ai/hyper-roz');
  });

  it('transfer (organization): owner viejo + nombre actual', () => {
    const payload = {
      repository: { full_name: 'hyperlabs-ai/roz', name: 'roz' },
      changes: { owner: { from: { organization: { login: 'old-org' } } } },
    };
    expect(renamedFrom(payload)).toBe('old-org/roz');
  });

  it('transfer (user): owner viejo + nombre actual', () => {
    const payload = {
      repository: { full_name: 'hyperlabs-ai/roz', name: 'roz' },
      changes: { owner: { from: { user: { login: 'mcortezv' } } } },
    };
    expect(renamedFrom(payload)).toBe('mcortezv/roz');
  });

  it('sin changes (otra action de repository): null', () => {
    expect(renamedFrom({ repository: { full_name: 'hyperlabs-ai/roz', name: 'roz' } })).toBeNull();
  });

  it('sin full_name: null', () => {
    expect(renamedFrom({ changes: { repository: { name: { from: 'x' } } } })).toBeNull();
  });
});
