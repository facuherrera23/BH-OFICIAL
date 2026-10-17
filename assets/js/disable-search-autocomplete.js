// Agregar autocomplete="off" a TODOS los inputs de búsqueda, incluidos los dinámicos
// Esto evita que el browser sugiera el email del usuario logueado al escribir
(function disableSearchAutocomplete() {
  function apply() {
    document.querySelectorAll('input[type="search"], input[id*="Search"], input[id*="search"], input[id*="Filter"], input[placeholder*="Buscar"]').forEach(function(input) {
      if (!input.hasAttribute('autocomplete')) {
        input.setAttribute('autocomplete', 'off');
      }
    });
  }
  // Aplicar al cargar
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
  // Y reaplicar cuando se agregan nodos dinámicamente (modales, paneles, etc.)
  var observer = new MutationObserver(function(mutations) {
    for (var m of mutations) {
      for (var node of m.addedNodes) {
        if (node.nodeType === 1) {
          if (node.matches && node.matches('input[type="search"], input[id*="Search"], input[id*="search"]')) {
            node.setAttribute('autocomplete', 'off');
          }
          if (node.querySelectorAll) {
            node.querySelectorAll('input[type="search"], input[id*="Search"], input[id*="search"]').forEach(function(inp) {
              inp.setAttribute('autocomplete', 'off');
            });
          }
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
