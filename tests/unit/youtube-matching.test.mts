// Tests unitarios del emparejamiento de videos de YouTube (lógica pura).
// Corre con: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emparejarGlobal,
  esMismoVideo,
  estadoPublicado,
  mejorCoincidencia,
  type SyncVideo,
} from '../../supabase/functions/_shared/youtube-matching.ts';

const TITULO = 'CASA EN VENTA –  Barrio Crisol Sud (Córdoba Capital)';

function video(id: string, publicado: string, title = TITULO): SyncVideo {
  return {
    id,
    snippet: { title, publishedAt: publicado },
    status: { privacyStatus: 'public', uploadStatus: 'processed' },
  };
}

test('tres shorts con el MISMO título se vinculan 1:1, sin repetir videos', () => {
  const publicaciones = [
    '2026-10-28T02:47:01+00:00',
    '2026-10-28T02:47:38+00:00',
    '2026-10-28T02:48:28+00:00',
  ];
  const vids = publicaciones.map((p, i) => video(`vid-${i}`, p));
  const posts = publicaciones.map((p, i) => ({
    id: `post-${i}`, title: TITULO,
    created_at: new Date(new Date(p).getTime() - 5000).toISOString(),
  }));
  const pares = emparejarGlobal(posts, vids);
  assert.equal(pares.size, 3);
  assert.deepEqual(new Set([...pares.values()].map((p) => p.postId)),
    new Set(['post-0', 'post-1', 'post-2']));
});

test('el emparejamiento es óptimo: un greedy por distancia dejaría un huérfano afuera', () => {
  const posts = [
    { id: 'a', title: TITULO, created_at: '2026-01-01T00:00:00Z' },
    { id: 'b', title: TITULO, created_at: '2026-01-01T00:00:10Z' },
  ];
  /* x está a 5s de ambos; y está a 25s de 'a' y a 35s de 'b' (fuera de
     la ventana). El greedy toma a-x primero y ya no puede casar 'b'. */
  const vids = [
    video('x', '2026-01-01T00:00:05Z'),
    video('y', '2025-12-31T23:35:00Z'),
  ];
  const pares = emparejarGlobal(posts, vids);
  assert.equal(pares.size, 2);
  assert.equal(pares.get('x')?.postId, 'b');
  assert.equal(pares.get('y')?.postId, 'a');
});

test('la fecha de programación es un ancla válida (±30 min)', () => {
  const v = video('prog', '2026-01-02T15:00:30Z');
  const creado = '2026-01-01T10:00:00Z';
  const programado = '2026-01-02T15:00:00Z';
  assert.equal(esMismoVideo(TITULO, creado, v), false);
  assert.equal(esMismoVideo(TITULO, creado, v, programado), true);
  assert.equal(mejorCoincidencia(TITULO, creado, [v], new Set(), programado)?.id, 'prog');
});

test('un video ya vinculado no se roba para otra fila', () => {
  const v = video('ya-usado', '2026-01-01T00:01:00Z');
  assert.equal(mejorCoincidencia(TITULO, '2026-01-01T00:00:30Z', [v], new Set(['ya-usado'])), null);
});

test('estadoPublicado nunca promueve borradores ni videos no públicos', () => {
  assert.equal(estadoPublicado('processed', 'public', { draft: true }), 'draft');
  assert.equal(estadoPublicado('processed', 'private', null), 'publishing');
  assert.equal(estadoPublicado('processed', 'unlisted', null), 'publishing');
  assert.equal(estadoPublicado('uploading', 'public', null), 'publishing');
  assert.equal(estadoPublicado('processed', 'public', null), 'published');
});
