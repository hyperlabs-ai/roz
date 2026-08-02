// Ops guarda la descripción de las tareas como HTML (su editor es TipTap); roz la muestra con
// react-markdown, que NO habilita HTML crudo a propósito — el `spec` puede venir de PRs y commits
// auto-documentados, así que renderizar HTML ahí sería un XSS. El resultado era que una descripción
// escrita en Ops se leía literalmente como "<p>Jajajaj</p>".
//
// La salida se convierte a Markdown en vez de habilitar HTML. Se parsea con DOMParser y se recorre
// el ÁRBOL: nunca se inyecta el HTML en el documento, así que no se ejecuta nada. Cubre lo que
// TipTap produce (párrafos, énfasis, encabezados, listas, enlaces, imágenes, citas, código) y las
// imágenes pegadas dentro del texto quedan como `![](url)`, que react-markdown sí pinta — que es
// como llegan las capturas que se pegan en la descripción en Ops.

const HTML_HINT = /<\/?(p|div|br|h[1-6]|ul|ol|li|strong|b|em|i|u|s|a|img|blockquote|pre|code|table)\b/i;

/** ¿El texto viene como HTML? Si no, se deja intacto: en roz también hay markdown nativo. */
export function looksLikeHtml(text: string): boolean {
  return HTML_HINT.test(text);
}

function escapeMd(s: string): string {
  // Solo lo que rompería el markdown resultante; no se toca el resto para no ensuciar el texto.
  return s.replace(/([*_`[\]])/g, '\\$1');
}

function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeMd(node.textContent ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as HTMLElement;
  const kids = Array.from(el.childNodes).map(inline).join('');

  switch (el.tagName.toLowerCase()) {
    case 'strong': case 'b': return kids.trim() ? `**${kids}**` : '';
    case 'em': case 'i': return kids.trim() ? `*${kids}*` : '';
    case 's': case 'del': return kids.trim() ? `~~${kids}~~` : '';
    case 'code': return kids.trim() ? `\`${el.textContent ?? ''}\`` : '';
    case 'br': return '  \n';
    case 'a': {
      const href = el.getAttribute('href');
      return href ? `[${kids || href}](${href})` : kids;
    }
    case 'img': {
      const src = el.getAttribute('src');
      if (!src) return '';
      return `![${el.getAttribute('alt') ?? ''}](${src})`;
    }
    default: return kids;
  }
}

function block(el: Element, depth = 0): string {
  const tag = el.tagName.toLowerCase();
  const kids = Array.from(el.childNodes);
  const text = () => kids.map(inline).join('').trim();

  switch (tag) {
    case 'h1': return `# ${text()}`;
    case 'h2': return `## ${text()}`;
    case 'h3': return `### ${text()}`;
    case 'h4': case 'h5': case 'h6': return `#### ${text()}`;
    case 'blockquote':
      return Array.from(el.children).map((c) => block(c, depth)).join('\n\n')
        .split('\n').map((l) => `> ${l}`).join('\n');
    case 'pre':
      return `\`\`\`\n${el.textContent ?? ''}\n\`\`\``;
    case 'ul': case 'ol': {
      const ordered = tag === 'ol';
      return Array.from(el.children)
        .filter((li) => li.tagName.toLowerCase() === 'li')
        .map((li, i) => {
          const marker = ordered ? `${i + 1}.` : '-';
          // Un <li> puede traer bloques anidados (sublistas): se sangran dos espacios por nivel.
          const nested = Array.from(li.children).filter((c) => ['ul', 'ol'].includes(c.tagName.toLowerCase()));
          const own = Array.from(li.childNodes)
            .filter((n) => !(n.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes((n as Element).tagName.toLowerCase())))
            .map(inline).join('').trim();
          const sub = nested.map((n) => block(n, depth + 1)).join('\n');
          return `${'  '.repeat(depth)}${marker} ${own}${sub ? `\n${sub}` : ''}`;
        })
        .join('\n');
    }
    case 'hr': return '---';
    case 'table': {
      // TipTap rara vez las genera, pero si llegan se degrada a texto por filas.
      return Array.from(el.querySelectorAll('tr'))
        .map((tr) => Array.from(tr.children).map((td) => inline(td).trim()).join(' | '))
        .join('\n');
    }
    default: {
      const t = text();
      return t;
    }
  }
}

/**
 * Markdown de lo que hay en el portapapeles, o null si no venía con formato.
 *
 * Copiar una respuesta de Claude o ChatGPT deja HTML rico en el portapapeles además del texto
 * plano. Pegar el texto plano pierde encabezados, listas y bloques de código — justo la estructura
 * por la que uno pega la conversación. Se reutiliza el mismo parseo del árbol que el HTML de Ops:
 * nunca se inyecta el HTML en el documento, así que tampoco hay riesgo de XSS por lo pegado.
 */
export function markdownFromPaste(e: { clipboardData: DataTransfer | null }): string | null {
  const html = e.clipboardData?.getData('text/html');
  if (!html || !looksLikeHtml(html)) return null;
  const md = htmlToMarkdown(html).trim();
  return md || null;
}

/**
 * HTML (de TipTap) → Markdown. Si el texto no parece HTML se devuelve sin tocar, así una
 * descripción escrita en roz en markdown sigue funcionando igual.
 */
export function htmlToMarkdown(text: string | null | undefined): string {
  if (!text) return '';
  if (!looksLikeHtml(text)) return text;
  if (typeof DOMParser === 'undefined') return text; // SSR / entorno sin DOM

  const doc = new DOMParser().parseFromString(text, 'text/html');
  const out: string[] = [];
  for (const child of Array.from(doc.body.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = (child.textContent ?? '').trim();
      if (t) out.push(escapeMd(t));
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const b = block(child as Element).trim();
      if (b) out.push(b);
    }
  }
  return out.join('\n\n');
}
