// Tour en video en las fichas HTML (generador scripts/generate-ficha.mjs).
// El video sale de social_posts (platform=youtube, status=published) y se
// embebe con youtube-nocookie, click-to-load (el iframe solo se crea al
// abrir el lightbox) + JSON-LD VideoObject + CSP frame-src.
//
// El test genera una ficha de muestra con el MISMO generador de producción
// (tests/helpers/ficha-sample.js): no toca red ni escribe en fichas/.
const { test, expect } = require('@playwright/test');
const { buildSample } = require('./helpers/ficha-sample');

test.describe('Ficha: tour en video', () => {
  test('con video: embed click-to-load + lightbox + JSON-LD VideoObject', () => {
    const { withVideo } = buildSample();

    // Poster + botón play (el iframe NO se inserta en el HTML inicial)
    expect(withVideo).toContain('id="ytFrame"');
    expect(withVideo).toContain('data-yt="dQw4w9WgXcQ"');
    expect(withVideo).toContain('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(withVideo).toContain('Tour en video');

    // El iframe del video se carga al abrir el lightbox (click-to-load)
    expect(withVideo).toContain('id="lbVid"');
    expect(withVideo).toContain('id="lbVidFrame"');
    expect(withVideo).toContain("vidFrame.src = 'https://www.youtube-nocookie.com/embed/'");
    // Cerrar el dialog corta la reproducción (src vacío)
    expect(withVideo).toContain("vidDlg.addEventListener('close'");
    // Sin iframe embebido en el markup inicial
    expect(withVideo).not.toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');

    // JSON-LD VideoObject (rich result de Google)
    const ldBlocks = [...withVideo.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const videoLd = ldBlocks
      .map((m) => JSON.parse(m[1].replace(/\\u003c/g, '<')))
      .find((obj) => obj['@type'] === 'VideoObject');
    expect(videoLd).toBeTruthy();
    expect(videoLd.embedUrl).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(videoLd.contentUrl).toContain('youtube.com/watch?v=dQw4w9WgXcQ');
    expect(videoLd.uploadDate).toBe('2026-10-20T10:00:00Z');

    // CSP: el iframe de YouTube tiene que estar permitido (si no, el video no se ve)
    const csp = withVideo.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    expect(csp).toContain('frame-src');
    expect(csp).toContain('https://www.youtube-nocookie.com');

    // Todos los JSON-LD siguen siendo JSON válido
    for (const m of ldBlocks) {
      expect(() => JSON.parse(m[1].replace(/\\u003c/g, '<'))).not.toThrow();
    }
  });

  test('sin video: la ficha no tiene embed, dialog ni VideoObject', () => {
    const { withoutVideo } = buildSample();
    expect(withoutVideo).not.toContain('id="ytFrame"');
    expect(withoutVideo).not.toContain('id="lbVid"');
    expect(withoutVideo).not.toContain('VideoObject');
    // Pero la ficha sigue siendo válida (JSON-LD RealEstateListing + CSP)
    const ldBlocks = [...withoutVideo.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const parsed = ldBlocks.map((m) => JSON.parse(m[1].replace(/\\u003c/g, '<')));
    expect(parsed.some((o) => o['@type'] === 'RealEstateListing')).toBeTruthy();
  });

  test('el JS inline de la ficha sigue siendo JS válido', () => {
    const { withVideo } = buildSample();
    const vm = require('vm');
    const inline = [...withVideo.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)];
    expect(inline.length).toBeGreaterThan(0);
    for (const m of inline) {
      expect(() => new vm.Script(m[1])).not.toThrow();
    }
  });
});
