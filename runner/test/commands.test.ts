import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  branchFor,
  buildClaudeArgs,
  buildImplementPrompt,
  buildMcpConfig,
  buildPrBody,
  ghPrCreateArgs,
  isSafeBranch,
  parseClaudeOutput,
  parseDefaultBranch,
  parsePrUrl,
  parseRemoteRepo,
  worktreeAddArgs,
  worktreePathFor,
} from '../src/commands.js';
import { normalizeRepo, repoPathFor, type RunnerConfig } from '../src/config.js';
import { buildSpawnSpec, quoteCmdArg } from '../src/exec.js';
import { pullTarget } from '../src/pull.js';
import { RUNNER_ALLOWED_TOOLS_PLAN } from '../src/types.js';

describe('buildClaudeArgs', () => {
  it('modo -p, salida JSON, MCP estricto y la lista blanca al final', () => {
    const args = buildClaudeArgs({ allowedTools: RUNNER_ALLOWED_TOOLS_PLAN, maxTurns: 40, mcpConfigPath: '/h/tmp/mcp-1.json' });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--max-turns',
      '40',
      '--mcp-config',
      '/h/tmp/mcp-1.json',
      '--strict-mcp-config',
      '--allowedTools',
      'Read',
      'Glob',
      'Grep',
      'Write(PLAN.md)',
      'mcp__roz__*',
    ]);
    // El prompt nunca va como argumento.
    expect(args.some((a) => a.includes('Implementa'))).toBe(false);
  });

  it('agrega el modelo si se pide y omite allowedTools vacía', () => {
    const args = buildClaudeArgs({ allowedTools: [], maxTurns: 5, mcpConfigPath: 'x', model: 'sonnet' });
    expect(args).toContain('--model');
    expect(args).not.toContain('--allowedTools');
  });
});

describe('buildMcpConfig', () => {
  it('servidor HTTP roz con el token del runner', () => {
    const cfg = JSON.parse(buildMcpConfig('https://roz.test/mcp', 'rozr_abc'));
    expect(cfg).toEqual({
      mcpServers: { roz: { type: 'http', url: 'https://roz.test/mcp', headers: { Authorization: 'Bearer rozr_abc' } } },
    });
  });
});

describe('parseClaudeOutput', () => {
  it('éxito', () => {
    const out = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'listo', num_turns: 7, total_cost_usd: 0.4 });
    expect(parseClaudeOutput(`ruido\n${out}\n`, 0)).toEqual({ ok: true, result: 'listo', turns: 7, costUsd: 0.4 });
  });
  it('sin turnos, error explícito, código distinto de 0 y salida ilegible', () => {
    expect(parseClaudeOutput(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }), 1)).toMatchObject({
      ok: false,
      result: 'se acabaron los turnos permitidos',
    });
    expect(parseClaudeOutput(JSON.stringify({ subtype: 'success', is_error: true, result: 'API caída' }), 0)).toMatchObject({
      ok: false,
      result: 'API caída',
    });
    expect(parseClaudeOutput(JSON.stringify({ subtype: 'success', result: 'x' }), 2).ok).toBe(false);
    expect(parseClaudeOutput('Error: no auth', 1)).toMatchObject({ ok: false, result: 'Claude Code salió con código 1' });
  });
});

describe('git', () => {
  it('rama con el ID de Linear y slug sin acentos, máximo 40', () => {
    expect(branchFor('HYP-123', 'Arreglar la paginación del Pulso')).toBe('hyp-123-arreglar-la-paginacion-del-pulso');
    expect(branchFor('HYP-9', '¡¡¡')).toBe('hyp-9');
    const long = branchFor('HYP-1', 'a'.repeat(30) + ' ' + 'b'.repeat(30));
    expect(long.length).toBeLessThanOrEqual('hyp-1-'.length + 40);
    expect(long.endsWith('-')).toBe(false);
  });

  it('isSafeBranch', () => {
    expect(isSafeBranch('hyp-123-algo')).toBe(true);
    expect(isSafeBranch('mdjes/hyp-123-algo')).toBe(true);
    for (const bad of ['', '-x', 'a..b', 'a b', 'a;rm', 'x.lock', 'a@{1}', '/a', 'a/']) expect(isSafeBranch(bad), bad).toBe(false);
  });

  it('worktree add según qué ramas existen', () => {
    const wt = '/w/hyp-1';
    expect(worktreeAddArgs(wt, 'hyp-1-x', 'main', { local: true, remote: true })).toEqual(['worktree', 'add', wt, 'hyp-1-x']);
    expect(worktreeAddArgs(wt, 'hyp-1-x', 'main', { local: false, remote: true })).toEqual([
      'worktree', 'add', '--track', '-b', 'hyp-1-x', wt, 'origin/hyp-1-x',
    ]);
    expect(worktreeAddArgs(wt, 'hyp-1-x', 'develop', { local: false, remote: false })).toEqual([
      'worktree', 'add', '--no-track', '-b', 'hyp-1-x', wt, 'origin/develop',
    ]);
  });

  it('ruta del worktree por repo e identificador', () => {
    expect(worktreePathFor('/h/wt', 'HyperLabs/Roz', 'HYP-12')).toBe(path.join('/h/wt', 'hyperlabs__roz', 'hyp-12'));
  });

  it('rama por defecto y repo del remoto', () => {
    expect(parseDefaultBranch('origin/main\n')).toBe('main');
    expect(parseDefaultBranch('')).toBeNull();
    expect(parseRemoteRepo('git@github.com:HyperLabs-AI/roz.git\n')).toBe('hyperlabs-ai/roz');
    expect(parseRemoteRepo('https://github.com/a/b')).toBe('a/b');
    expect(parseRemoteRepo('https://gitlab.com/a/b')).toBeNull();
  });
});

describe('gh y PR', () => {
  it('pr create con body en archivo', () => {
    expect(ghPrCreateArgs({ repo: 'a/b', base: 'main', branch: 'hyp-1-x', title: 'HYP-1: X', bodyFile: '/t/pr.md' })).toEqual([
      'pr', 'create', '--repo', 'a/b', '--base', 'main', '--head', 'hyp-1-x', '--title', 'HYP-1: X', '--body-file', '/t/pr.md',
    ]);
  });
  it('parsePrUrl', () => {
    expect(parsePrUrl('Creating pull request…\nhttps://github.com/a/b/pull/42\n')).toEqual({
      prNumber: 42,
      prUrl: 'https://github.com/a/b/pull/42',
    });
    expect(parsePrUrl('nada')).toBeNull();
  });
  it('body con issue, riesgo y plan; sin atribuciones', () => {
    const body = buildPrBody(
      { identifier: 'HYP-1', issue: { title: 't', description: null, url: 'https://linear.app/x/HYP-1', projectName: null }, risk: 1, riskReasons: [{ code: 'cliente_sla', detail: 'cliente con SLA' }] },
      '1. hacer x',
    );
    expect(body).toContain('https://linear.app/x/HYP-1');
    expect(body).toContain('cliente con SLA');
    expect(body).toContain('## Plan');
    expect(body).not.toMatch(/Co-Authored-By/i);
  });
  it('prompt de implementación incluye el plan y la rama', () => {
    const p = buildImplementPrompt({ identifier: 'HYP-1', issue: { title: 'X', description: null, url: null, projectName: null }, branch: 'hyp-1-x' }, '- paso 1');
    expect(p).toContain('hyp-1-x');
    expect(p).toContain('- paso 1');
    expect(p).toContain('No hagas push');
  });
});

describe('config de repos', () => {
  it('normaliza owner/name desde varias formas', () => {
    expect(normalizeRepo('HyperLabs-AI/Roz')).toBe('hyperlabs-ai/roz');
    expect(normalizeRepo('https://github.com/a/b.git')).toBe('a/b');
    expect(normalizeRepo('git@github.com:a/b.git')).toBe('a/b');
    expect(normalizeRepo('nada')).toBeNull();
  });
  it('repoPathFor sin importar mayúsculas', () => {
    const cfg: RunnerConfig = { url: 'u', token: 't', name: 'n', repos: { 'a/b': '/src/b' } };
    expect(repoPathFor(cfg, 'A/B')).toBe('/src/b');
    expect(repoPathFor(cfg, 'a/c')).toBeNull();
    expect(repoPathFor(cfg, null)).toBeNull();
  });
});

describe('pullTarget', () => {
  it('ID de Linear o uuid', () => {
    expect(pullTarget('hyp-12')).toEqual({ identifier: 'HYP-12' });
    expect(pullTarget('3F2504E0-4F89-11D3-9A0C-0305E82C3301')).toEqual({ planId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' });
    expect(() => pullTarget('hola')).toThrow();
  });
});

describe('spawn en Windows', () => {
  it('POSIX y .exe van directo, sin shell', () => {
    expect(buildSpawnSpec('git', ['status'], 'linux', null)).toEqual({ file: 'git', args: ['status'], windowsVerbatimArguments: false });
    expect(buildSpawnSpec('gh', ['pr'], 'win32', 'C:\\bin\\gh.exe')).toEqual({
      file: 'C:\\bin\\gh.exe',
      args: ['pr'],
      windowsVerbatimArguments: false,
    });
  });

  it('.cmd pasa por cmd.exe con los argumentos escapados (doble para shims de npm)', () => {
    const spec = buildSpawnSpec('claude', ['-p', 'Bash(git status:*)'], 'win32', 'C:\\npm\\claude.cmd');
    expect(spec.file).toBe('cmd.exe');
    expect(spec.windowsVerbatimArguments).toBe(true);
    expect(spec.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    const line = spec.args[3]!;
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    expect(line).toContain('C:\\npm\\claude.cmd');
    // paréntesis, espacio y asterisco quedan escapados con ^ (dos veces)
    expect(line).toContain('^^^(');
    expect(line).toContain('^^^*');
  });

  it('quoteCmdArg', () => {
    expect(quoteCmdArg('abc')).toBe('^"abc^"');
    expect(quoteCmdArg('a b')).toBe('^"a^ b^"');
    expect(quoteCmdArg('a"b')).toBe('^"a\\^"b^"');
    expect(quoteCmdArg('')).toBe('^"^"');
  });
});
