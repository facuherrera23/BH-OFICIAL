// Guard estático: las RPC de "mi día" no pueden suplantar a otro perfil.
// `cierre_de_dia`, `mi_dia` y `mi_dia_agenda` son SECURITY DEFINER: sin
// este guard cualquier authenticated podía mandar el UUID de otra persona.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20261128000017_rpc_scope_guard.sql'), 'utf8',
);
const crm = fs.readFileSync(path.join(ROOT, 'assets/js/admin-crm.js'), 'utf8');
const digest = fs.readFileSync(path.join(ROOT, 'supabase/functions/agent-daily-digest/index.ts'), 'utf8');

test.describe('alcance por usuario de las RPC de operación diaria', () => {
  test('la migración cambia las TRES funciones que aceptan p_user_id', () => {
    expect(migration).toContain("ARRAY['cierre_de_dia', 'mi_dia', 'mi_dia_agenda']");
    expect(migration).toContain("'-- BH-SCOPE-GUARD'");
    expect(migration).toContain("p_user_id <> auth.uid()");
    expect(migration).toContain("<> ''service_role''");
    expect(migration).toContain("ERRCODE = ''42501''");
    /* Idempotente y con verificación dentro de la propia migración. */
    expect(migration).toContain('CONTINUE; -- ya aplicado');
    expect(migration).toContain('Guard de alcance ausente');
    /* No altera ACLs: los grants vigentes (authenticated / service_role)
       siguen como estaban. */
    expect(migration).not.toMatch(/REVOKE|GRANT /i);
  });

  test('el panel NO manda p_user_id (usa su propia sesión)', () => {
    expect(crm).toContain(".rpc('mi_dia', soloPropio ? { p_solo_propio: true } : {})");
    expect(crm).toContain(".rpc('mi_dia', {})");
    expect(crm).toContain(".rpc('cierre_de_dia', { p_solo_propio: !!soloPropio })");
    expect(crm).not.toMatch(/\.rpc\('(mi_dia|cierre_de_dia)',[^)]*p_user_id/);
  });

  test('el cron con service_role SÍ puede pasar el perfil objetivo', () => {
    expect(digest).toContain("rpc('mi_dia', {");
    expect(digest).toContain('p_user_id: perfil.id');
    expect(digest).toContain("rpc('mi_dia_agenda', {");
  });
});
