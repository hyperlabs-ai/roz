import { describe, it, expect } from 'vitest';
import {
  decodeEntities, extractUrls, isPrivateAddress, parseOpenGraph, safeFetchHtml, tiktokId, tweetText, vimeoId, youtubeId,
} from '../src/chat/unfurl.js';

// Previews de links del chat. Lo que más importa: (1) que encuentre el link correcto en texto real
// (markdown, paréntesis, puntuación), (2) que la tarjeta salga bien de HTML desordenado, y (3) que
// el servidor NUNCA visite una dirección interna aunque alguien pegue un link a ella (SSRF).

describe('extractUrls', () => {
  it('saca links del texto sin la puntuación de alrededor', () => {
    expect(extractUrls('mira https://roz.dev/a. y (también https://x.com/b), ¿ok?')).toEqual(['https://roz.dev/a', 'https://x.com/b']);
  });

  it('conserva los paréntesis que son parte de la URL y quita los del markdown', () => {
    expect(extractUrls('ver https://es.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://es.wikipedia.org/wiki/Foo_(bar)']);
    expect(extractUrls('[el doc](https://docs.roz.dev/guia)')).toEqual(['https://docs.roz.dev/guia']);
  });

  it('ignora lo que está en código, repetidos y más de 3', () => {
    expect(extractUrls('`https://a.com` y\n```\nhttps://b.com\n```\nhttps://c.com')).toEqual(['https://c.com']);
    expect(extractUrls('https://a.com https://a.com https://b.com https://c.com https://d.com')).toEqual([
      'https://a.com', 'https://b.com', 'https://c.com',
    ]);
  });

  it('solo http(s)', () => {
    expect(extractUrls('ftp://a.com javascript:alert(1) mailto:a@b.com')).toEqual([]);
  });
});

describe('youtubeId / vimeoId', () => {
  it('reconoce todas las formas de un link de YouTube', () => {
    const id = 'dQw4w9WgXcQ';
    for (const url of [
      `https://www.youtube.com/watch?v=${id}&t=42s`,
      `https://youtu.be/${id}?si=abc`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://music.youtube.com/watch?v=${id}`,
    ]) {
      expect(youtubeId(url), url).toBe(id);
    }
    expect(youtubeId('https://www.youtube.com/@canal')).toBeNull();
    expect(youtubeId('https://evil.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  it('Vimeo por id numérico', () => {
    expect(vimeoId('https://vimeo.com/76979871')).toBe('76979871');
    expect(vimeoId('https://vimeo.com/channels/staff')).toBeNull();
  });
});

describe('parseOpenGraph', () => {
  const html = `<!doctype html><html><head>
    <meta charset="utf-8">
    <title>Respaldo &amp; título</title>
    <meta property="og:title" content="Lanzamos roz 2.0 &mdash; ahora con chat">
    <meta name="description" content="Descripción &quot;normal&quot;">
    <meta content="La descripción OG" property="og:description" />
    <meta property="og:image" content="/img/portada.png">
    <meta property="og:site_name" content="Blog de Hyper">
    <link rel="icon" href="/favicon-32.png">
  </head><body><meta property="og:title" content="no cuenta, está en body"></body></html>`;

  it('prefiere Open Graph, decodifica entidades y resuelve URLs relativas', () => {
    const p = parseOpenGraph(html, 'https://blog.hyper.mx/posts/roz?x=1')!;
    expect(p.title).toBe('Lanzamos roz 2.0 — ahora con chat');
    expect(p.description).toBe('La descripción OG');
    expect(p.image).toBe('https://blog.hyper.mx/img/portada.png');
    expect(p.icon).toBe('https://blog.hyper.mx/favicon-32.png');
    expect(p.siteName).toBe('Blog de Hyper');
  });

  it('sin OG cae a <title> y al dominio; sin nada devuelve null', () => {
    const p = parseOpenGraph('<head><title>Solo título</title></head>', 'https://www.ejemplo.com/a')!;
    expect(p.title).toBe('Solo título');
    expect(p.siteName).toBe('ejemplo.com');
    expect(p.icon).toBe('https://www.ejemplo.com/favicon.ico');
    expect(parseOpenGraph('<head></head><body>hola</body>', 'https://a.com')).toBeNull();
  });

  it('descarta imágenes con protocolos raros', () => {
    const p = parseOpenGraph('<head><title>x</title><meta property="og:image" content="javascript:alert(1)"></head>', 'https://a.com')!;
    expect(p.image).toBeNull();
  });
});

describe('texto de oEmbed', () => {
  it('decodifica entidades con nombre y numéricas', () => {
    expect(decodeEntities('a &amp; b &#241; &#x00e9; &aacute; &bogus;')).toBe('a & b ñ é á &bogus;');
  });

  it('saca el texto del post de X del blockquote', () => {
    const html = '<blockquote class="twitter-tweet"><p lang="es" dir="ltr">Hola <a href="https://t.co/x">equipo</a><br>línea 2</p>&mdash; Ana (@ana) <a href="#">1 nov</a></blockquote>';
    expect(tweetText(html)).toBe('Hola equipo\nlínea 2');
  });
});

describe('guarda SSRF', () => {
  it('reconoce direcciones privadas, loopback, link-local y metadata de la nube', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '142.250.72.14', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('no visita hosts internos, puertos raros ni URLs con credenciales', async () => {
    await expect(safeFetchHtml('http://127.0.0.1/admin')).rejects.toThrow();
    await expect(safeFetchHtml('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
    await expect(safeFetchHtml('http://[::1]:80/')).rejects.toThrow();
    await expect(safeFetchHtml('http://localhost/')).rejects.toThrow();
    await expect(safeFetchHtml('https://ejemplo.com:8443/')).rejects.toThrow();
    await expect(safeFetchHtml('https://user:pass@ejemplo.com/')).rejects.toThrow();
  });
});

describe('tiktokId', () => {
  it('del reproductor del oEmbed (también links cortos) o de la URL', () => {
    expect(tiktokId('https://vm.tiktok.com/ZMabc/', '<iframe src="https://www.tiktok.com/player/v1/6718335390845095173?x=1">')).toBe('6718335390845095173');
    expect(tiktokId('https://www.tiktok.com/@scout2015/video/6718335390845095173')).toBe('6718335390845095173');
    expect(tiktokId('https://www.tiktok.com/@scout2015')).toBeNull();
  });
});
