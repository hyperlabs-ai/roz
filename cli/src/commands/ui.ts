// zeus env ui: visor local de la bóveda. Un servidor en 127.0.0.1 (solo esta PC) que descifra aquí
// mismo y muestra los valores en el navegador de la persona: enmascarados, con "mostrar" y "copiar",
// historial, y para cambiar o agregar una variable sin escribirla en la terminal ni en un chat.
//
// Seguridad: escucha solo en loopback, exige un token aleatorio en cada llamada (en un encabezado,
// no en la URL de la API), revisa el Host (contra DNS rebinding) y se apaga solo tras un rato sin uso.
// Lo abre la PERSONA: el hook `zeus guard` impide que un agente lo lance.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { CliError, UsageError, type Ctx } from '../context.js';
import { MAX_SECRET_VALUE_BYTES, decryptSecret, encryptSecret, isValidSecretName, secretAad, zeroize } from '../crypto.js';
import { decryptAll, openEnv, parse, requireKey, resolveTarget, staleToCliError, type RegisteredKey } from './vault.js';

const IDLE_MS = 15 * 60 * 1000;

export interface UiRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
}
export interface UiResponse {
  status: number;
  type: string;
  body: string;
}

const json = (status: number, data: unknown): UiResponse => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(data) });

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** El manejador de peticiones, sin red: así se prueba igual que los demás comandos. */
export function uiHandler(ctx: Ctx, key: RegisteredKey, token: string, port: () => number) {
  return async (req: UiRequest): Promise<UiResponse> => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port()}` && host !== `localhost:${port()}`) return json(421, { error: 'host inválido' });
    const u = new URL(req.url, `http://${host}`);

    if (req.method === 'GET' && u.pathname === '/') return { status: 200, type: 'text/html; charset=utf-8', body: PAGE };
    if (!u.pathname.startsWith('/api/')) return json(404, { error: 'no existe' });
    if (!sameToken(req.headers['x-zeus-ui'] ?? '', token)) return json(401, { error: 'token inválido: abre la URL que imprimió `zeus env ui`' });

    try {
      if (req.method === 'GET' && u.pathname === '/api/envs') {
        const { projects } = await ctx.api.listProjects();
        return json(200, {
          envs: projects.flatMap((p) => p.envs.filter((e) => e.hasGrant).map((e) => ({ project: p.key, projectName: p.name, env: e.name, needsRotation: !!e.needsRotation }))),
        });
      }
      const project = u.searchParams.get('project') ?? '';
      const envName = u.searchParams.get('env') ?? '';
      if (req.method === 'GET' && u.pathname === '/api/env') {
        const t = await resolveTarget(ctx, project, envName);
        const { remote, dek } = await openEnv(ctx, key, t);
        try {
          const { values, stale } = decryptAll(t, remote, dek);
          return json(200, {
            label: `${t.projectKey}/${t.env}`,
            stale,
            secrets: remote.secrets
              .filter((s) => values.has(s.name))
              .map((s) => ({ name: s.name, value: values.get(s.name), version: s.version, updatedAt: s.updatedAt, updatedBy: s.updatedByName ?? null })),
          });
        } finally {
          zeroize(dek);
        }
      }
      if (req.method === 'GET' && u.pathname === '/api/history') {
        const name = u.searchParams.get('name') ?? '';
        if (!isValidSecretName(name)) return json(400, { error: 'nombre inválido' });
        const t = await resolveTarget(ctx, project, envName);
        const { remote, dek } = await openEnv(ctx, key, t);
        try {
          const h = await ctx.api.history(t.projectKey, t.env, key.keyId, name);
          return json(200, {
            versions: h.revisions.map((r) => ({
              version: r.version,
              current: r.current,
              deleted: r.ciphertext == null,
              setAt: r.setAt,
              setBy: r.setByName,
              value:
                r.ciphertext != null && r.dekVersion === remote.dekVersion
                  ? decryptSecret(dek, r.ciphertext, secretAad(t.projectKey, t.env, r.name, r.dekVersion))
                  : null,
            })),
          });
        } finally {
          zeroize(dek);
        }
      }
      if (req.method === 'POST' && u.pathname === '/api/set') {
        if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return json(415, { error: 'se espera JSON' });
        const b = JSON.parse(req.body || '{}') as { project?: string; env?: string; name?: string; value?: string };
        const name = String(b.name ?? '');
        const value = String(b.value ?? '');
        if (!isValidSecretName(name)) return json(400, { error: 'nombre inválido (letras, números y guion bajo; sin empezar con número)' });
        if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_VALUE_BYTES) return json(400, { error: 'el valor pasa de 64 KiB' });
        const t = await resolveTarget(ctx, String(b.project ?? ''), String(b.env ?? ''));
        const { remote, dek } = await openEnv(ctx, key, t);
        try {
          const ciphertext = encryptSecret(dek, value, secretAad(t.projectKey, t.env, name, remote.dekVersion));
          await ctx.api
            .putSecrets(t.projectKey, t.env, { keyId: key.keyId, dekVersion: remote.dekVersion, set: [{ name, ciphertext }], delete: [] })
            .catch((err: unknown) => staleToCliError(err, t));
        } finally {
          zeroize(dek);
        }
        return json(200, { ok: true });
      }
      return json(404, { error: 'no existe' });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

export async function envUi(ctx: Ctx, args: string[]): Promise<number> {
  const { values: opts, positionals } = parse(args, { port: { type: 'string' }, 'no-open': { type: 'boolean' } });
  if (positionals.length > 2) throw new UsageError('uso: zeus env ui [proyecto] [entorno] [--port N] [--no-open]');
  const key = await requireKey(ctx);
  const token = randomBytes(24).toString('base64url');
  let port = 0;
  const handle = uiHandler(ctx, key, token, () => port);

  let idle: NodeJS.Timeout | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      if (chunks.reduce((n, x) => n + x.length, 0) > 256 * 1024) req.destroy();
    });
    req.on('end', () => {
      bump();
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
      void handle({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body: Buffer.concat(chunks).toString('utf8') }).then((r) => {
        res.writeHead(r.status, {
          'content-type': r.type,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
        });
        res.end(r.body);
      });
    });
  });
  const bump = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      ctx.log('zeus env ui: 15 minutos sin uso, se cerró.');
      server.close();
    }, IDLE_MS);
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err) => reject(new CliError(`no se pudo abrir el visor: ${err.message}`)));
    server.listen(opts.port ? Number(opts.port) : 0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  bump();
  const pick = positionals[0] ? `&project=${encodeURIComponent(positionals[0])}${positionals[1] ? `&env=${encodeURIComponent(positionals[1])}` : ''}` : '';
  const url = `http://127.0.0.1:${port}/#t=${token}${pick}`;
  ctx.out(`visor de zeus en ${url}`);
  ctx.log('solo en esta PC. Ctrl+C para cerrarlo (se cierra solo tras 15 min sin uso). No compartas la URL.');
  if (!opts['no-open']) await ctx.openUrl(url);
  await new Promise<void>((resolve) => server.on('close', () => resolve()));
  return 0;
}

// ---------------------------------------------------------------- la página

const PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zeus · bóveda</title>
<style>
:root{--bg:#f6f4ef;--panel:#fffdf8;--ink:#1b1a17;--muted:#6f6a60;--line:#e4dfd3;--accent:#e8590c;--accent-ink:#fff;--ok:#2f7d4f;--warn:#b54708;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#141311;--panel:#1c1b18;--ink:#f1ede4;--muted:#a39d90;--line:#2e2c27;--accent:#ff7a33;--accent-ink:#141311;--ok:#5cc28a;--warn:#f5a35c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line)}
header b{font-size:15px}header span{color:var(--muted);font-size:12px}
main{display:grid;grid-template-columns:240px 1fr;min-height:calc(100vh - 52px)}
nav{border-right:1px solid var(--line);padding:12px;overflow:auto}
nav button{display:block;width:100%;text-align:left;background:none;border:0;color:var(--ink);padding:7px 10px;border-radius:6px;cursor:pointer;font:inherit}
nav button:hover{background:var(--line)}nav button.on{background:var(--accent);color:var(--accent-ink)}
nav small{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:12px 10px 4px}
section{padding:18px 22px;overflow:auto}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
input{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 9px}
input.mono,td.v{font-family:var(--mono);font-size:12.5px}
button.b{font:inherit;font-size:12.5px;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:6px;padding:5px 10px;cursor:pointer}
button.b:hover{border-color:var(--accent)}button.p{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
td.n{font-family:var(--mono);font-size:12.5px;white-space:nowrap}td.v{word-break:break-all;max-width:520px}
td.m{color:var(--muted);font-size:12px;white-space:nowrap}td.a{white-space:nowrap;text-align:right}
.msg{margin:10px 0;color:var(--muted)}.err{color:var(--warn)}.okc{color:var(--ok)}
.hist{background:var(--bg);font-size:12px}.hist td{border-bottom:1px dashed var(--line)}
@media (max-width:720px){main{grid-template-columns:1fr}nav{border-right:0;border-bottom:1px solid var(--line)}section{padding:16px}}
</style>
</head>
<body>
<header><b>zeus · bóveda</b><span id="who">descifrado en esta PC · nada de esto sale de aquí</span></header>
<main>
<nav id="envs"><small>Entornos</small></nav>
<section>
  <div class="bar"><input id="q" placeholder="filtrar por nombre" style="flex:1;min-width:160px"><button class="b" id="revealAll">mostrar todo</button></div>
  <div id="status" class="msg">elige un entorno</div>
  <table id="tbl" hidden><thead><tr><th>Variable</th><th>Valor</th><th>Versión</th><th></th></tr></thead><tbody id="rows"></tbody></table>
  <div class="bar" style="margin-top:14px" id="addBar" hidden>
    <input id="newName" class="mono" placeholder="NUEVA_VARIABLE"><input id="newValue" class="mono" placeholder="valor" style="flex:1;min-width:200px" type="password">
    <button class="b p" id="add">agregar / reemplazar</button>
  </div>
</section>
</main>
<script>
const P=new URLSearchParams(location.hash.slice(1));const T=P.get('t');history.replaceState(null,'',location.pathname);
let cur=null,data=[],shown=new Set(),all=false;
const $=s=>document.querySelector(s);
const api=(p,o={})=>fetch(p,{...o,headers:{'x-zeus-ui':T,'content-type':'application/json',...(o.headers||{})}}).then(async r=>{const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j});
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const when=s=>s?s.slice(0,16).replace('T',' '):'';
function say(t,c){const e=$('#status');e.textContent=t;e.className='msg '+(c||'')}
async function loadEnvs(){const {envs}=await api('/api/envs');const nav=$('#envs');let last='';
 for(const e of envs){if(e.project!==last){const s=document.createElement('small');s.textContent=e.projectName||e.project;nav.appendChild(s);last=e.project}
  const b=document.createElement('button');b.textContent=e.env+(e.needsRotation?' · por rotar':'');b.onclick=()=>open(e,b);nav.appendChild(b);
  if(P.get('project')&&P.get('project').toLowerCase()===e.project.toLowerCase()&&(!P.get('env')||P.get('env')===e.env)&&!cur)open(e,b)}
 if(!envs.length)say('no tienes acceso a ningún entorno','err')}
async function open(e,btn){document.querySelectorAll('nav button').forEach(x=>x.classList.remove('on'));btn&&btn.classList.add('on');cur=e;shown.clear();all=false;say('descifrando…');
 try{const r=await api('/api/env?project='+encodeURIComponent(e.project)+'&env='+encodeURIComponent(e.env));data=r.secrets;say(r.label+' · '+data.length+' variables'+(r.stale.length?' · ilegibles: '+r.stale.join(', '):''));render()}catch(err){say(err.message,'err')}}
function render(){const q=$('#q').value.toLowerCase();$('#tbl').hidden=false;$('#addBar').hidden=false;
 $('#rows').innerHTML=data.filter(s=>s.name.toLowerCase().includes(q)).map(s=>{const vis=all||shown.has(s.name);
  return '<tr data-n="'+esc(s.name)+'"><td class="n">'+esc(s.name)+'</td><td class="v">'+(vis?esc(s.value):'••••••••')+'</td><td class="m">v'+s.version+' · '+esc(s.updatedBy||'')+'<br>'+when(s.updatedAt)+'</td><td class="a"><button class="b" data-a="show">'+(vis?'ocultar':'mostrar')+'</button> <button class="b" data-a="copy">copiar</button> <button class="b" data-a="edit">cambiar</button> <button class="b" data-a="hist">historial</button></td></tr>'}).join('')}
$('#rows').onclick=async ev=>{const a=ev.target.dataset.a;if(!a)return;const tr=ev.target.closest('tr');const n=tr.dataset.n;const s=data.find(x=>x.name===n);
 if(a==='show'){shown.has(n)?shown.delete(n):shown.add(n);render()}
 if(a==='copy'){await navigator.clipboard.writeText(s.value);say(n+' copiada','okc')}
 if(a==='edit'){$('#newName').value=n;$('#newValue').value='';$('#newValue').focus()}
 if(a==='hist'){const nx=tr.nextElementSibling;if(nx&&nx.classList.contains('hist')){nx.remove();return}
  const r=await api('/api/history?project='+encodeURIComponent(cur.project)+'&env='+encodeURIComponent(cur.env)+'&name='+encodeURIComponent(n));
  const h=document.createElement('tr');h.className='hist';h.innerHTML='<td colspan="4"><table>'+r.versions.map(v=>'<tr><td class="m">v'+v.version+(v.current?' · actual':'')+'</td><td class="v">'+(v.deleted?'(borrada)':v.value==null?'(ilegible)':esc(v.value))+'</td><td class="m">'+esc(v.setBy||'')+' · '+when(v.setAt)+'</td></tr>').join('')+'</table></td>';tr.after(h)}};
$('#q').oninput=render;$('#revealAll').onclick=()=>{all=!all;$('#revealAll').textContent=all?'ocultar todo':'mostrar todo';render()};
$('#add').onclick=async()=>{const name=$('#newName').value.trim(),value=$('#newValue').value;if(!cur||!name)return;
 if(!confirm('¿Guardar '+name+' en '+cur.project+'/'+cur.env+'? Lo verá todo el que tenga acceso y le llegará el aviso.'))return;
 try{await api('/api/set',{method:'POST',body:JSON.stringify({project:cur.project,env:cur.env,name,value})});$('#newValue').value='';await open(cur,document.querySelector('nav button.on'));say(name+' guardada','okc')}catch(err){say(err.message,'err')}};
if(!T)say('falta el token: abre la URL que imprimió zeus env ui','err');else loadEnvs().catch(e=>say(e.message,'err'));
</script>
</body>
</html>`;
