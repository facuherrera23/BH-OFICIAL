// ============================================================
// youtube-matching — emparejamiento y estado de videos de YouTube
// ------------------------------------------------------------
// Lógica PURA compartida por social-youtube-studio y
// social-publish-youtube. Se mantiene fuera de las Edge Functions
// para poder probarla con `npm run test:unit` sin red ni Supabase.
//
// Contrato del incidente Shorts 27/10/2026:
//   · 1 post huérfano ↔ 1 video real del canal (nunca dos posts al
//     mismo video, nunca un video ya vinculado);
//   · el emparejamiento es de MÍNIMA distancia total (no voraz por
//     orden de filas);
//   · un borrador o un video no público NUNCA se promueve a
//     `published` automáticamente.
// ============================================================

export type SyncVideo = {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    categoryId?: string;
    tags?: string[];
  };
  status?: { privacyStatus?: string; uploadStatus?: string; publishAt?: string };
};

export type PostEmparejable = {
  id: string;
  title: string;
  created_at: string;
  publish_at?: string | null;
};

const VENTANA_MS = 30 * 60 * 1000;

export function normTitle(s: string): string {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function diffMs(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime());
}

/**
 * Título normalizado + fecha dentro de la ventana real de procesamiento.
 * `publish_at` (programación nativa de YouTube) es un ancla alternativa:
 * el upload se inicia antes de la hora elegida y `snippet.publishedAt`
 * refleja la programación, no el created_at del post.
 */
export function esMismoVideo(
  postTitle: string,
  postCreatedAt: string,
  v: SyncVideo,
  publishAt = '',
): boolean {
  const pub = String(v.snippet?.publishedAt ?? '');
  if (!pub || normTitle(postTitle) !== normTitle(String(v.snippet?.title ?? ''))) return false;
  if (diffMs(pub, postCreatedAt) <= VENTANA_MS) return true;
  return !!publishAt && diffMs(pub, publishAt) <= VENTANA_MS;
}

type Arista = { to: number; rev: number; cap: number; cost: number };

/**
 * Emparejamiento mínimo-costo (flujo de costo mínimo sobre un grafo
 * bipartito). Devuelve videoId → { postId, diff }. `vedados` son los
 * videos ya vinculados a OTRA fila del CRM.
 */
export function emparejarGlobal(
  posts: PostEmparejable[],
  vids: SyncVideo[],
  vedados: Set<string> = new Set(),
): Map<string, { postId: string; diff: number }> {
  const candidatos: Array<{ post: number; vid: number; diff: number }> = [];
  const vidsValidos = vids
    .map((v, idx) => ({ v, idx, id: String(v.id ?? '') }))
    .filter((x) => !!x.id && !vedados.has(x.id));

  for (let p = 0; p < posts.length; p++) {
    const post = posts[p];
    for (const { v, idx, id } of vidsValidos) {
      if (!esMismoVideo(post.title, post.created_at, v, String(post.publish_at ?? ''))) continue;
      const pub = String(v.snippet?.publishedAt ?? '');
      const diff = Math.min(
        diffMs(pub, post.created_at),
        post.publish_at ? diffMs(pub, String(post.publish_at)) : Infinity,
      );
      candidatos.push({ post: p, vid: idx, diff });
    }
  }
  if (!candidatos.length) return new Map();

  const source = 0;
  const nPosts = posts.length;
  const vidNode = (i: number) => 1 + nPosts + i;
  const sink = 1 + nPosts + vidsValidos.length;
  const n = sink + 1;
  const grafo: Arista[][] = Array.from({ length: n }, () => []);

  const add = (u: number, v: number, cap: number, cost: number) => {
    const fwd: Arista = { to: v, rev: grafo[v].length, cap, cost };
    const rev: Arista = { to: u, rev: grafo[u].length, cap: 0, cost: -cost };
    grafo[u].push(fwd);
    grafo[v].push(rev);
  };

  for (let p = 0; p < nPosts; p++) add(source, 1 + p, 1, 0);
  for (let i = 0; i < vidsValidos.length; i++) add(vidNode(i), sink, 1, 0);
  for (const c of candidatos) add(1 + c.post, vidNode(c.vid), 1, c.diff);

  /* SPFA: shortest augmenting path. Todos los costos forward son ≥ 0;
     los residuos negativos sólo se usan para reasignar un match previo. */
  while (true) {
    const dist = new Array<number>(n).fill(Infinity);
    const prevV = new Array<number>(n).fill(-1);
    const prevE = new Array<number>(n).fill(-1);
    const enCola = new Array<boolean>(n).fill(false);
    const cola: number[] = [source];
    dist[source] = 0;
    enCola[source] = true;
    while (cola.length) {
      const u = cola.shift() as number;
      enCola[u] = false;
      for (let i = 0; i < grafo[u].length; i++) {
        const e = grafo[u][i];
        if (e.cap <= 0 || dist[u] + e.cost >= dist[e.to]) continue;
        dist[e.to] = dist[u] + e.cost;
        prevV[e.to] = u;
        prevE[e.to] = i;
        if (!enCola[e.to]) { enCola[e.to] = true; cola.push(e.to); }
      }
    }
    if (dist[sink] === Infinity) break;
    let flujo = Infinity;
    for (let v = sink; v !== source; v = prevV[v]) {
      flujo = Math.min(flujo, grafo[prevV[v]][prevE[v]].cap);
    }
    for (let v = sink; v !== source; v = prevV[v]) {
      const e = grafo[prevV[v]][prevE[v]];
      e.cap -= flujo;
      grafo[v][e.rev].cap += flujo;
    }
  }

  const resultado = new Map<string, { postId: string; diff: number }>();
  for (let p = 0; p < nPosts; p++) {
    for (const e of grafo[1 + p]) {
      if (e.cost < 0 || e.cap !== 0) continue; // arista forward usada
      const idx = e.to - vidNode(0);
      if (idx < 0 || idx >= vidsValidos.length) continue;
      if (resultado.has(vidsValidos[idx].id)) continue;
      resultado.set(vidsValidos[idx].id, { postId: posts[p].id, diff: e.cost });
    }
  }
  return resultado;
}

/** Una sola fila: el video más cercano, sin repetir videos vedados. */
export function mejorCoincidencia(
  postTitle: string,
  postCreatedAt: string,
  vids: SyncVideo[],
  vedados: Set<string> = new Set(),
  publishAt = '',
): SyncVideo | null {
  const mapa = emparejarGlobal(
    [{ id: 'unico', title: postTitle, created_at: postCreatedAt, publish_at: publishAt }],
    vids,
    vedados,
  );
  for (const v of vids) {
    if (mapa.has(String(v.id ?? ''))) return v;
  }
  return null;
}

/** El estado del CRM NUNCA adelanta un borrador ni un video no público. */
export function estadoPublicado(
  uploadStatus: string,
  privacy: string,
  content: Record<string, unknown> | null,
): 'published' | 'publishing' | 'draft' {
  if (String(uploadStatus) !== 'processed') return 'publishing';
  if (content?.draft === true) return 'draft';
  if (String(privacy || '').toLowerCase() !== 'public') return 'publishing';
  return 'published';
}
