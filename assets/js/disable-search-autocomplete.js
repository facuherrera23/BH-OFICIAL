/* Anti-autofill de Chrome en campos de búsqueda (fix definitivo 2026-10-21).
 *
 * BUG (meses): al entrar a "Leads & CRM" el buscador se prellenaba con el email
 * de inicio de sesión. Causa: Chrome IGNORA autocomplete="off" para credenciales
 * y sus heurísticas cazan cualquier campo "parecido a usuario" — el placeholder
 * "Buscar nombre, email o teléfono..." las dispara. El script viejo solo ponía
 * autocomplete="off" (inútil contra Chrome).
 *
 * Fix en 2 capas (junto con los tokens del login en el HTML):
 *  1) readonly hasta la primera interacción: Chrome NUNCA autocompleta campos
 *     readonly. Se libera en pointerdown/focus (captura) — el usuario clickea
 *     y tipea normal, cero diferencia de UX. El foco programático (Ctrl+K)
 *     también libera vía el listener de focus.
 *  2) autocomplete="off" se mantiene para Firefox/Safari, que sí lo respetan.
 *
 * El login ahora lleva autocomplete="username"/"current-password", así Chrome
 * ancla las credenciales al campo correcto y deja de cazar en el resto de la página.
 */
(function disableSearchAutocomplete() {
  var GUARD_ATTR = 'data-bh-autofill-guard';

  function guard(input) {
    if (!input || input.hasAttribute(GUARD_ATTR)) return;
    input.setAttribute(GUARD_ATTR, '1');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('readonly', 'readonly');

    function unlock() {
      input.removeAttribute('readonly');
      input.removeEventListener('pointerdown', unlock, true);
      input.removeEventListener('focus', unlock, true);
    }
    /* captura: se dispara antes que cualquier otro handler y antes del tipeo */
    input.addEventListener('pointerdown', unlock, true);
    input.addEventListener('focus', unlock, true);

    /* si el campo ya tiene foco al blindarse (re-render con foco / Ctrl+K), liberar ya */
    if (document.activeElement === input) input.removeAttribute('readonly');
  }

  function matchesSearchInput(el) {
    if (!el || !el.matches) return false;
    return el.matches(
      'input[type="search"], input[id*="Search"], input[id*="search"], input[id*="Filter"], input[placeholder*="Buscar"]'
    );
  }

  function apply(root) {
    var scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll(
      'input[type="search"], input[id*="Search"], input[id*="search"], input[id*="Filter"], input[placeholder*="Buscar"]'
    ).forEach(guard);
  }

  /* Aplicar apenas el script corre (está al final del body: los inputs ya existen)
     y re-aplicar en DOMContentLoaded por si algo re-crea el DOM antes del guard. */
  apply(document);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { apply(document); });
  }

  /* Modales y paneles que se agregan dinámicamente también quedan blindados. */
  var observer = new MutationObserver(function (mutations) {
    for (var m of mutations) {
      for (var node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (matchesSearchInput(node)) guard(node);
        if (node.querySelectorAll) apply(node);
      }
    }
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
})();
