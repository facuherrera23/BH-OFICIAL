// Helper de monitoreo de consola para tests.
// Solo los mensajes de tipo 'error' y los pageerror se consideran fallos.
// Los warnings (p.ej. los 2 GoTrueClient 'Multiple GoTrueClient instances') NO fallan,
// y los errores permitidos (p.ej. 406 esperado por token TEST) se ignoran por regex.
function trackConsoleErrors(page, allowedPatterns = []) {
  const errors = [];
  const pageErrors = [];

  const onConsole = (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  };
  const onPageError = (err) => pageErrors.push(String(err));

  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  return {
    errors,
    pageErrors,
    assertClean() {
      const unexpected = errors.filter(
        (text) => !allowedPatterns.some((re) => re.test(text))
      );
      const problems = [
        ...pageErrors.map((e) => `PAGEERROR: ${e}`),
        ...unexpected.map((e) => `CONSOLE ERROR: ${e}`),
      ];
      if (problems.length > 0) {
        throw new Error(`Errores inesperados de consola (${problems.length}):\n${problems.join('\n')}`);
      }
    },
    detach() {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    },
  };
}

module.exports = { trackConsoleErrors };