// El ÚNICO layout de correo de roz y zeus. Todos los correos (avisos de tareas y PRs, bandeja de
// zeus, resúmenes semanales, alertas de infraestructura) se arman como un `EmailDoc` de bloques y
// salen por `renderEmailDoc`: mismo encabezado, misma tipografía, mismos chips y el mismo pie.
//
// Sigue la estética del front (identidad Stape del rediseño): hueso de fondo, tarjeta blanca con
// hairline cálida, naranja roz para lo que pide acción, Inter Tight para texto y JetBrains Mono para
// ids, ramas y comandos, etiquetas en MAYÚSCULAS con tracking abierto.
//
// Reglas de correo (Gmail, Outlook, Apple Mail): tablas, estilos inline, sin SVG ni <style> que
// dependa del cliente, ancho fijo de 560px, solo modo claro. Nada de caracteres usados como ícono
// (palomitas, flechas, viñetas): los indicadores son formas con CSS (puntos redondeados) o chips de
// texto. Funciones PURAS: sin red, sin base de datos.

export type EmailTone = 'brand' | 'ok' | 'alert' | 'warn' | 'info' | 'thinking' | 'neutral';

export interface EmailPerson {
  name: string;
  /** Login de GitHub: su avatar (`github.com/<login>.png`), como en el front. */
  login?: string | null;
}

export interface EmailFact {
  label: string;
  value: string;
  /** Ids, ramas, repos, comandos: en mono. */
  mono?: boolean;
  /** El valor como chip de estado (prioridad, estado del servicio). */
  chip?: EmailTone;
  /** El valor es una persona: avatar + nombre. */
  person?: EmailPerson;
}

export interface EmailListItem {
  /** Id corto en mono (ROZ-330, #12, ORWEL/production). */
  code?: string | null;
  text: string;
  url?: string | null;
  /** Línea secundaria en gris (fecha, repo, quién). */
  meta?: string | null;
  chip?: { label: string; tone: EmailTone } | null;
}

export interface EmailKpi {
  label: string;
  value: string;
  /** Variación contra el periodo anterior, como texto ("+12%", "sin cambio"). */
  delta?: { text: string; tone: EmailTone } | null;
}

export type EmailBlock =
  | { kind: 'facts'; title?: string; rows: EmailFact[] }
  | { kind: 'list'; title?: string; items: EmailListItem[]; empty?: string }
  | { kind: 'kpis'; title?: string; items: EmailKpi[] }
  | { kind: 'code'; title?: string; lines: string[] }
  | { kind: 'callout'; tone: EmailTone; text: string };

export interface EmailDoc {
  subject: string;
  /** Texto de vista previa en la bandeja del cliente de correo. */
  preheader?: string;
  /** Avatar de Roz-bot que firma el correo (`/brand/<archivo>`). */
  botFile: string;
  /** Sección de roz de la que viene el correo, en la esquina del encabezado ("Tareas", "Zeus · Bandeja"). */
  section: string;
  kicker: string;
  tone: EmailTone;
  headline: string;
  lead?: string | null;
  blocks: EmailBlock[];
  cta?: { label: string; url: string } | null;
  secondary?: { label: string; url: string } | null;
  /** Por qué le llega este correo a la persona (una línea en el pie). */
  reason?: string | null;
  /** URL pública del dashboard: avatar de Roz y enlace a Configuración. */
  base: string;
}

// ------------------------------------------------------------------ tokens (los del front)

export const EMAIL_COLOR = {
  bg: '#f6f5f1', // hueso
  tray: '#efede7', // la "bandeja" que envuelve el panel, como la consola
  card: '#ffffff',
  ink: '#1b1b1a',
  ink2: '#5f5e59',
  ink3: '#8d8b84',
  border: '#e4e1d9',
  hairline: '#eeece6',
  sunken: '#faf9f6',
  panel2: '#eeede8',
  orange: '#ff5b23',
  orangeLine: '#e84a14',
  terminal: '#1f1f1d',
  terminalInk: '#f2f1ec',
} as const;

/** Color de texto por tono. En el cuerpo los estados van como TEXTO de color, no como chips. */
const TONE: Record<EmailTone, { ink: string; soft: string; line: string }> = {
  brand: { ink: '#c2410c', soft: '#fff1ea', line: '#ffd6c4' },
  ok: { ink: '#1f7a57', soft: '#ecf8f2', line: '#bfe6d3' },
  alert: { ink: '#b4262b', soft: '#fdf0f0', line: '#f6c9ca' },
  warn: { ink: '#8a5a00', soft: '#fff8e6', line: '#f3dc9c' },
  info: { ink: '#1d5fcf', soft: '#eef4fe', line: '#c7dafb' },
  thinking: { ink: '#5546c4', soft: '#f3f1fd', line: '#d8d3f7' },
  neutral: { ink: '#5f5e59', soft: '#f3f2ee', line: '#e4e1d9' },
};

const SANS = "'Inter Tight','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const C = EMAIL_COLOR;

export const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Solo http(s): un enlace raro no entra al href. */
const safeUrl = (u: string): string => (/^https?:\/\//i.test(u) ? escHtml(u) : '#');

const trimBase = (base: string): string => base.replace(/\/+$/, '');

// ------------------------------------------------------------------ secciones y sus imágenes

/**
 * Cada sección de roz tiene su arte (web/public/brand/email, generado a partir de los íconos de lucide
 * del front y de Roz-bot): la cabecera del correo, el ícono de su etiqueta y el de sus filas.
 */
export type EmailArt = 'tareas' | 'repos' | 'juntas' | 'codigo' | 'variables' | 'bandeja' | 'resumen' | 'infra' | 'infra-alert' | 'agentes';

export function artOf(section: string, tone: EmailTone): EmailArt {
  const s = section.toLowerCase();
  if (s.includes('infra')) return tone === 'alert' || tone === 'warn' ? 'infra-alert' : 'infra';
  if (s.includes('variable')) return 'variables';
  if (s.includes('bandeja') || s.includes('zeus')) return 'bandeja';
  if (s.includes('repo')) return 'repos';
  if (s.includes('junta')) return 'juntas';
  if (s.includes('código') || s.includes('codigo') || s.includes('pr')) return 'codigo';
  if (s.includes('semana') || s.includes('resumen')) return 'resumen';
  if (s.includes('agente') || s.includes('plan')) return 'agentes';
  return 'tareas';
}

const asset = (base: string, file: string): string => `${base}/brand/email/${file}`;

/**
 * Imagen con su gemela oscura: la clara se ve por defecto (Gmail, Outlook de escritorio) y en los
 * clientes que respetan el modo oscuro (Apple Mail, iOS, Outlook.com) el <style> cambia a la oscura.
 */
function dualImg(base: string, light: string, dark: string, w: number, style: string, h?: number): string {
  const size = h ? ` width="${w}" height="${h}"` : ` width="${w}"`;
  return `<img class="e-l" src="${safeUrl(asset(base, light))}"${size} alt="" style="display:block;${style}"><!--[if !mso]><!--><img class="e-d" src="${safeUrl(asset(base, dark))}"${size} alt="" style="display:none;max-height:0;overflow:hidden;mso-hide:all;${style}"><!--<![endif]-->`;
}

// ------------------------------------------------------------------ modo oscuro y móvil

/** Colores del tema oscuro del front, por clase. */
const DARK: Record<string, string> = {
  'e-bg': 'background:#161615',
  'e-tray': 'background:#1b1b19;border-color:#2c2c29;box-shadow:none',
  'e-card': 'background:#1f1f1d;border-color:#353532',
  'e-sunken': 'background:#232321;border-color:#353532',
  'e-badge': 'background:#232321;border-color:#353532;box-shadow:none',
  'e-hair': 'border-color:#2f2f2c',
  'e-ink': 'color:#f2f1ec',
  'e-ink2': 'color:#b9b7b0',
  'e-ink3': 'color:#8f8d86',
  'e-code': 'background:#2a2a28;border-color:#3a3a37;color:#f2f1ec',
  'e-t-brand': 'color:#ff9a70',
  'e-t-ok': 'color:#5fc79d',
  'e-t-alert': 'color:#f2878a',
  'e-t-warn': 'color:#f5c35c',
  'e-t-info': 'color:#8db8fb',
  'e-t-thinking': 'color:#b3abf3',
  'e-t-neutral': 'color:#b9b7b0',
  'e-c-brand': 'background:#3d2015;border-color:#5a2e1c;color:#ffb393',
  'e-c-ok': 'background:#15302a;border-color:#1f4a3d;color:#7fd6b0',
  'e-c-alert': 'background:#3d1a1c;border-color:#5c2629;color:#f6a5a7',
  'e-c-warn': 'background:#3a2d10;border-color:#56441a;color:#f5cf7a',
  'e-c-info': 'background:#1a2740;border-color:#26395c;color:#a9c9fb',
  'e-c-thinking': 'background:#2a2546;border-color:#3b3466;color:#c6c0f6',
  'e-c-neutral': 'background:#262624;border-color:#353532;color:#b9b7b0',
};

const darkRules = (scope: string): string =>
  Object.entries(DARK)
    .map(([cls, decl]) => `${scope}.${cls}{${decl.split(';').map((d) => `${d}!important`).join(';')}}`)
    .join('\n');

/**
 * Estilos del <head>. Modo oscuro para los clientes que lo respetan (y `[data-ogsc]` para Outlook.com);
 * en móvil (≤ 540 px) el correo se reacomoda en vez de comprimirse: menos margen lateral, los datos
 * se apilan (etiqueta arriba, valor abajo), los botones se apilan y las cifras bajan de tamaño.
 */
const HEAD_STYLE = `<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme: dark){
${darkRules('')}
.e-l{display:none!important}
.e-d{display:block!important;max-height:none!important;overflow:visible!important}
}
${darkRules('[data-ogsc] ')}
[data-ogsc] .e-l{display:none!important}
[data-ogsc] .e-d{display:block!important;max-height:none!important;overflow:visible!important}
@media only screen and (max-width:540px){
.e-outer{padding:20px 6px 28px!important}
.e-pad{padding-left:20px!important;padding-right:20px!important}
.e-h1{font-size:22px!important}
.e-stack{display:block!important;width:100%!important;box-sizing:border-box}
.e-fl{padding:12px 16px 2px!important;width:auto!important}
.e-fv{border-top:0!important;padding:0 16px 12px!important}
.e-kpi{padding:14px 12px!important}
.e-kv{font-size:22px!important}
.e-btn2{padding:14px 0 0!important}
}
</style>`;

// ------------------------------------------------------------------ piezas

/** Avatar de una persona: su foto de GitHub o, sin login, sus iniciales en un círculo. */
export function avatarHtml(p: EmailPerson, size = 20): string {
  if (p.login && /^[A-Za-z0-9-]{1,39}$/.test(p.login)) {
    return `<img src="https://github.com/${p.login}.png?size=${size * 3}" width="${size}" height="${size}" alt="" style="display:inline-block;vertical-align:middle;width:${size}px;height:${size}px;border-radius:50%;border:0;background:${C.panel2}">`;
  }
  const initials = p.name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return `<span style="display:inline-block;vertical-align:middle;width:${size}px;height:${size}px;line-height:${size}px;border-radius:50%;background:${C.panel2};color:${C.ink2};font-family:${SANS};font-size:${Math.round(size * 0.42)}px;font-weight:600;text-align:center">${escHtml(initials || '?')}</span>`;
}

/** Estado como texto de color (sin pastilla ni punto): se lee limpio en cualquier cliente. */
export function chipHtml(label: string, tone: EmailTone): string {
  return `<span class="e-t-${tone}" style="font-family:${SANS};font-size:13px;font-weight:600;color:${TONE[tone].ink};white-space:nowrap">${escHtml(label)}</span>`;
}

const eyebrow = (s?: string): string =>
  s ? `<div class="e-ink3" style="margin:0 0 10px;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:${C.ink3}">${escHtml(s)}</div>` : '';

const panel = (inner: string): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="e-sunken" style="border-collapse:separate;background:${C.sunken};border:1px solid ${C.border};border-radius:12px">${inner}</table>`;

const hair = (i: number): string => (i ? `border-top:1px solid ${C.hairline};` : '');
/** Clase de las celdas con línea divisoria (el modo oscuro le cambia el color). */
const HAIR = 'e-hair';

/** La etiqueta de la sección sobre el título: píldora blanca con su ícono en círculo de color. */
function sectionBadge(base: string, art: EmailArt, label: string): string {
  const img = base
    ? `<img src="${safeUrl(asset(base, `badge-${art}.png`))}" width="22" height="22" alt="" style="display:block;border:0;width:22px;height:22px;border-radius:22px">`
    : `<span style="display:block;width:22px;height:22px;border-radius:22px;background:${C.orange}"></span>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" class="e-badge" style="border-collapse:separate;background:#ffffff;border:1px solid ${C.border};border-radius:999px;box-shadow:0 1px 2px rgba(27,27,26,.05),0 6px 16px -8px rgba(27,27,26,.18)"><tr>
    <td valign="middle" style="padding:3px 0 3px 3px">${img}</td>
    <td valign="middle" class="e-ink" style="padding:0 13px 0 8px;font-family:${SANS};font-size:12.5px;font-weight:600;color:${C.ink};white-space:nowrap">${escHtml(label)}</td>
  </tr></table>`;
}

// ------------------------------------------------------------------ bloques

function factsHtml(b: Extract<EmailBlock, { kind: 'facts' }>): string {
  const rows = b.rows.filter((r) => r.value || r.person);
  if (!rows.length) return '';
  const cells = rows
    .map((r, i) => {
      let value: string;
      if (r.person) value = `${avatarHtml(r.person, 22)}<span class="e-ink" style="vertical-align:middle;margin-left:9px;font-family:${SANS};font-size:14px;font-weight:500;color:${C.ink}">${escHtml(r.person.name)}</span>`;
      else if (r.chip) value = chipHtml(r.value, r.chip);
      else if (r.mono) value = `<span class="e-code" style="font-family:${MONO};font-size:12.5px;font-weight:500;color:${C.ink};background:#ffffff;border:1px solid ${C.border};border-radius:6px;padding:2px 7px;word-break:break-all">${escHtml(r.value)}</span>`;
      else value = `<span class="e-ink" style="font-family:${SANS};font-size:14px;line-height:1.5;font-weight:500;color:${C.ink}">${escHtml(r.value)}</span>`;
      // En móvil la etiqueta va arriba y el valor abajo (e-stack), en vez de dos columnas apretadas.
      return `<tr>
        <td class="${HAIR} e-ink3 e-stack e-fl" style="${hair(i)}padding:12px 0 12px 18px;width:36%;vertical-align:middle;font-family:${SANS};font-size:13px;color:${C.ink3}">${escHtml(r.label)}</td>
        <td class="${HAIR} e-stack e-fv" style="${hair(i)}padding:12px 18px 12px 10px;vertical-align:middle">${value}</td>
      </tr>`;
    })
    .join('');
  return `${eyebrow(b.title)}${panel(cells)}`;
}

function listHtml(b: Extract<EmailBlock, { kind: 'list' }>, base: string, art: EmailArt): string {
  if (!b.items.length) {
    return b.empty ? `${eyebrow(b.title)}<p style="margin:0;font-family:${SANS};font-size:13.5px;color:${C.ink3}">${escHtml(b.empty)}</p>` : '';
  }
  const icon = base ? dualImg(base, `icon-${art}.png`, `icon-${art}-dark.png`, 32, 'border:0;width:32px;height:32px;border-radius:9px', 32) : '';
  const last = b.items.length - 1;
  const rows = b.items
    .map((it, i) => {
      const pad = `padding:${i ? 14 : 4}px 0 ${i === last ? 4 : 14}px;`;
      const text = it.url
        ? `<a href="${safeUrl(it.url)}" class="e-ink" style="font-family:${SANS};font-size:14.5px;line-height:1.4;font-weight:600;color:${C.ink};text-decoration:none">${escHtml(it.text)}</a>`
        : `<span class="e-ink" style="font-family:${SANS};font-size:14.5px;line-height:1.4;font-weight:600;color:${C.ink}">${escHtml(it.text)}</span>`;
      const code = it.code ? `<div class="e-ink3" style="margin:0 0 3px;font-family:${MONO};font-size:11.5px;font-weight:500;color:${C.ink3}">${escHtml(it.code)}</div>` : '';
      const meta = it.meta ? `<div class="e-ink2" style="margin-top:3px;font-family:${SANS};font-size:12.5px;line-height:1.5;color:${C.ink2}">${escHtml(it.meta)}</div>` : '';
      // El estado va bajo el texto en una línea propia: en móvil una columna extra a la derecha aprieta el título.
      const status = it.chip ? `<div style="margin-top:6px">${chipHtml(it.chip.label, it.chip.tone)}</div>` : '';
      return `<tr>
        ${icon ? `<td width="44" valign="top" class="${HAIR}" style="${hair(i)}${pad}">${icon}</td>` : ''}
        <td valign="top" class="${HAIR}" style="${hair(i)}${pad}">${code}${text}${meta}${status}</td>
      </tr>`;
    })
    .join('');
  return `${eyebrow(b.title)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
}

/**
 * Reparte las cifras en filas sin huecos: hasta 3 por fila, y si el último renglón quedaría con una
 * sola, se equilibra (4 → 2+2, 5 → 3+2, 7 → 3+2+2). Cada fila es su propia tabla, así sus celdas se
 * reparten el ancho completo en vez de dejar columnas vacías.
 */
export function kpiRows<T>(items: T[]): T[][] {
  const n = items.length;
  if (n <= 3) return n ? [items] : [];
  const sizes: number[] = [];
  let left = n;
  while (left > 0) {
    if (left === 4) {
      sizes.push(2, 2);
      break;
    }
    const take = Math.min(3, left);
    sizes.push(take);
    left -= take;
  }
  const out: T[][] = [];
  let at = 0;
  for (const s of sizes) {
    out.push(items.slice(at, at + s));
    at += s;
  }
  return out;
}

function kpisHtml(b: Extract<EmailBlock, { kind: 'kpis' }>): string {
  if (!b.items.length) return '';
  const html = kpiRows(b.items)
    .map((row, r) => {
      const width = Math.floor(100 / row.length);
      const cells = row
        .map((k: EmailKpi, i: number) => {
          const delta = k.delta
            ? `<div class="e-t-${k.delta.tone}" style="margin-top:6px;font-family:${SANS};font-size:12.5px;font-weight:600;color:${TONE[k.delta.tone].ink}">${escHtml(k.delta.text)}</div>`
            : '';
          const borderL = i ? `border-left:1px solid ${C.hairline};` : '';
          return `<td width="${width}%" valign="top" class="${HAIR} e-kpi" style="${borderL}padding:16px 18px">
            <div class="e-ink3" style="font-family:${SANS};font-size:12.5px;color:${C.ink3}">${escHtml(k.label)}</div>
            <div class="e-ink e-kv" style="margin-top:6px;font-family:${SANS};font-size:28px;line-height:1;font-weight:600;letter-spacing:-.03em;color:${C.ink}">${escHtml(k.value)}</div>
            ${delta}
          </td>`;
        })
        .join('');
      const top = r ? `border-top:1px solid ${C.hairline};` : '';
      return `<tr><td class="${HAIR}" style="${top}padding:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table></td></tr>`;
    })
    .join('');
  return `${eyebrow(b.title)}${panel(html)}`;
}

function codeHtml(b: Extract<EmailBlock, { kind: 'code' }>): string {
  if (!b.lines.length) return '';
  return `${eyebrow(b.title)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;background:${C.terminal};border-radius:12px"><tr><td style="padding:16px 18px"><pre style="margin:0;font-family:${MONO};font-size:12px;line-height:1.65;color:${C.terminalInk};white-space:pre-wrap;word-break:break-word">${escHtml(b.lines.join('\n'))}</pre></td></tr></table>`;
}

function calloutHtml(b: Extract<EmailBlock, { kind: 'callout' }>): string {
  const t = TONE[b.tone];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="e-c-${b.tone}" style="border-collapse:separate;background:${t.soft};border:1px solid ${t.line};border-radius:12px"><tr>
    <td class="e-c-${b.tone}" style="padding:14px 18px;font-family:${SANS};font-size:14px;line-height:1.55;font-weight:500;color:${t.ink}">${escHtml(b.text)}</td>
  </tr></table>`;
}

function blockHtml(b: EmailBlock, base: string, art: EmailArt): string {
  switch (b.kind) {
    case 'facts':
      return factsHtml(b);
    case 'list':
      return listHtml(b, base, art);
    case 'kpis':
      return kpisHtml(b);
    case 'code':
      return codeHtml(b);
    case 'callout':
      return calloutHtml(b);
  }
}

// ------------------------------------------------------------------ documento

/**
 * Arma el correo completo con la estructura de la consola: la marca arriba, una "bandeja" clara que
 * envuelve el panel blanco (cabecera ilustrada de la sección, etiqueta, título, bloques y botón), la
 * razón del aviso al pie de la bandeja y la firma de roz debajo. Devuelve también el texto plano.
 */
export function renderEmailDoc(doc: EmailDoc): { subject: string; html: string; text: string } {
  const base = trimBase(doc.base);
  const art = artOf(doc.section, doc.tone);
  const settings = base ? `${base}/configuracion` : '';
  const logo = (size: number) =>
    base
      ? `<img src="${safeUrl(asset(base, 'logo.png'))}" width="${size}" height="${size}" alt="" style="display:block;border:0;width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.25)}px">`
      : `<span style="display:block;width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.25)}px;background:${C.orange}"></span>`;

  const hero = base
    ? `<tr><td class="e-bg" style="padding:0;line-height:0;font-size:0;border-radius:13px 13px 0 0;background:${C.bg}">${dualImg(
        base,
        `hero-${art}.png`,
        `hero-${art}-dark.png`,
        588,
        'width:100%;height:auto;border:0;border-radius:13px 13px 0 0',
      )}</td></tr>`
    : '';

  const blocks = doc.blocks
    .map((b) => blockHtml(b, base, art))
    .filter(Boolean)
    .map((h) => `<tr><td class="e-pad" style="padding:0 32px 24px">${h}</td></tr>`)
    .join('');

  const buttons =
    doc.cta || doc.secondary
      ? `<tr><td class="e-pad" style="padding:4px 32px 32px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${
          doc.cta
            ? `<td class="e-stack"><a href="${safeUrl(doc.cta.url)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:${C.orange};border:1px solid ${C.orangeLine};font-family:${SANS};font-size:14.5px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;white-space:nowrap;box-shadow:0 1px 2px rgba(232,74,20,.35),0 10px 22px -12px rgba(255,91,35,.75)">${escHtml(doc.cta.label)}</a></td>`
            : ''
        }${
          doc.secondary
            ? `<td class="e-stack e-btn2" style="padding-left:${doc.cta ? 18 : 0}px"><a href="${safeUrl(doc.secondary.url)}" class="e-ink" style="font-family:${SANS};font-size:14px;font-weight:600;color:${C.ink};text-decoration:underline;text-underline-offset:3px">${escHtml(doc.secondary.label)}</a></td>`
            : ''
        }</tr></table></td></tr>`
      : '';

  const preheader = doc.preheader ?? doc.lead ?? '';
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${escHtml(doc.subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
${HEAD_STYLE}
</head>
<body class="e-bg" style="margin:0;padding:0;background:${C.bg};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg}">${escHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="e-bg" style="background:${C.bg}"><tr><td align="center" class="e-outer" style="padding:36px 12px 40px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
    <tr><td style="padding:0 8px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td valign="middle" width="30">${logo(28)}</td>
        <td valign="middle" class="e-ink" style="padding-left:9px;font-family:${SANS};font-size:19px;font-weight:700;letter-spacing:-.04em;line-height:1;color:${C.ink}">roz</td>
        <td valign="middle" align="right" class="e-ink3" style="font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:${C.ink3}">${escHtml(doc.section)}</td>
      </tr></table>
    </td></tr>
    <tr><td class="e-tray" style="background:${C.tray};border:1px solid ${C.border};border-radius:18px;padding:5px;box-shadow:0 1px 2px rgba(27,27,26,.05),0 18px 40px -20px rgba(27,27,26,.22)">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="e-card" style="border-collapse:separate;background:${C.card};border:1px solid ${C.border};border-radius:14px;overflow:hidden">
            ${hero}
            <tr><td class="e-pad" style="padding:28px 32px 6px">
              ${sectionBadge(base, art, doc.kicker)}
              <h1 class="e-ink e-h1" style="margin:16px 0 0;font-family:${SANS};font-size:26px;line-height:1.2;font-weight:600;letter-spacing:-.03em;color:${C.ink}">${escHtml(doc.headline)}</h1>
              ${doc.lead ? `<p class="e-ink2" style="margin:12px 0 0;font-family:${SANS};font-size:15px;line-height:1.65;color:${C.ink2}">${escHtml(doc.lead)}</p>` : ''}
            </td></tr>
            <tr><td style="height:24px;line-height:24px;font-size:0">&nbsp;</td></tr>
            ${blocks}
            ${buttons}
          </table>
        </td></tr>
        <tr><td align="center" class="e-ink3" style="padding:12px 18px 10px;font-family:${SANS};font-size:12.5px;line-height:1.6;color:#7d7b74;text-align:center">${
          doc.reason ? escHtml(doc.reason) : 'Te escribo cuando algo de tu trabajo cambia o pide tu atención.'
        }</td></tr>
      </table>
    </td></tr>
    <tr><td align="center" style="padding:30px 16px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>
        <td valign="middle">${logo(18)}</td>
        <td valign="middle" class="e-ink" style="padding-left:7px;font-family:${SANS};font-size:13.5px;font-weight:700;letter-spacing:-.03em;line-height:1;color:${C.ink}">roz</td>
      </tr></table>
      <div class="e-ink3" style="margin-top:9px;font-family:${SANS};font-size:12px;line-height:1.7;color:${C.ink3}">El bot de tu equipo en Hyperlabs.${
        settings ? ` <a href="${safeUrl(settings)}" class="e-ink2" style="color:${C.ink2};text-decoration:underline;text-underline-offset:2px">Ajustar mis avisos</a>` : ''
      }</div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  return { subject: doc.subject, html, text: renderText(doc) };
}

/** La misma información en texto plano (clientes sin HTML, vista previa, registros). */
function renderText(doc: EmailDoc): string {
  const out: string[] = [doc.headline, ''];
  if (doc.lead) out.push(doc.lead, '');
  for (const b of doc.blocks) {
    if (b.kind === 'facts') {
      if (b.title) out.push(b.title);
      for (const r of b.rows) if (r.value || r.person) out.push(`${r.label}: ${r.person ? r.person.name : r.value}`);
    } else if (b.kind === 'list') {
      if (b.title) out.push(b.title);
      if (!b.items.length && b.empty) out.push(b.empty);
      for (const it of b.items) {
        out.push(`· ${it.code ? `${it.code}: ` : ''}${it.text}${it.chip ? ` [${it.chip.label}]` : ''}${it.meta ? ` (${it.meta})` : ''}${it.url ? ` ${it.url}` : ''}`);
      }
    } else if (b.kind === 'kpis') {
      if (b.title) out.push(b.title);
      for (const k of b.items) out.push(`${k.label}: ${k.value}${k.delta ? ` (${k.delta.text})` : ''}`);
    } else if (b.kind === 'code') {
      if (b.title) out.push(b.title);
      out.push(...b.lines);
    } else {
      out.push(b.text);
    }
    out.push('');
  }
  if (doc.cta) out.push(`${doc.cta.label}: ${doc.cta.url}`);
  if (doc.secondary) out.push(`${doc.secondary.label}: ${doc.secondary.url}`);
  if (doc.reason) out.push('', doc.reason);
  out.push('', 'Roz');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
