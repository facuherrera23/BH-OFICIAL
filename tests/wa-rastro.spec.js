// RASTRO DE WHATSAPP EN EL CRM (2026-11-26).
//
// El botón wa.me de la ficha del lead era el ÚNICO canal sin registro en el
// timeline (la plantilla, la campaña de propiedades y la encuesta sí
// registraban) → el CRM no sabía que hubo contacto real: el "sin contacto
// hace N días" mentía y el seguimiento se perdía.
//
// Contrato: log fire-and-forget (el chat se abre igual aunque falle el
// insert), con la propiedad vinculada en el texto, sin onclick inline y sin
// bloquear el envío (el listener NO preventDefault).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const crmSrc = read('assets/js/admin-crm.js');

test.describe('Rastro de WhatsApp en el CRM', () => {
  test('el botón wa.me de la ficha registra la actividad', () => {
    expect(crmSrc).toContain("title: 'WhatsApp abierto desde la ficha'");
    expect(crmSrc).toContain("var waAnchor = panel.querySelector('.crm-contact-btn--wa');");
    // Con la propiedad vinculada en el texto (si hay).
    expect(crmSrc).toContain("(propTitle ? ' · ' + propTitle : '')");
    // Fire-and-forget: el insert falla en silencio, el chat ya se abrió.
    expect(crmSrc).toMatch(/\.then\(function \(\) \{ \}, function \(\) \{ \/\* el envío ya salió \*\/ \}\);/);
    // Sin onclick inline (la CSP no tiene unsafe-inline).
    expect(crmSrc).not.toMatch(/onclick="[^"]*WhatsApp/);
  });

  test('los otros canales siguen registrando (y el envío no se bloquea)', () => {
    // Plantilla de WhatsApp (28/11): la apertura va ANTES de cualquier await
    // para que el popup-blocker no se coma el chat; el log queda fire-and-forget.
    expect(crmSrc).toContain("title: 'WhatsApp enviado (plantilla: ' + tpl.label + ')'");
    const plantilla = crmSrc.slice(crmSrc.indexOf("var useBtn = panel.querySelector('#crmTemplateUse')"), crmSrc.indexOf("var assignBtn = panel.querySelector('#crmAssignMe')"));
    expect(plantilla.indexOf("window.open('about:blank', '_blank')")).toBeLessThan(plantilla.indexOf('popup.location.replace(url)'));
    expect(plantilla.indexOf('popup.location.replace(url)')).toBeLessThan(plantilla.indexOf(".from('lead_activities').insert"));
    expect(plantilla).not.toMatch(/await db\(\)\.from\('lead_activities'\)/);
    // Y el anchor NO lleva preventDefault: el link de WhatsApp funciona igual.
    const bloque = crmSrc.slice(crmSrc.indexOf('var waAnchor = panel.querySelector'), crmSrc.indexOf('var propLink = firstProp'));
    expect(bloque).not.toContain('preventDefault');
  });

  test('los canales que ya registraban no se duplican', () => {
    // Campaña de propiedades (admin-propiedades): su log propio existe.
    expect(read('assets/js/admin-propiedades.js')).toMatch(/title: 'WhatsApp enviado \(campaña|lead_activities'\)\.insert/);
    // La bandeja registra el suyo (feature 1).
    expect(crmSrc).toContain("title: 'WhatsApp enviado (desde Mi bandeja)'");
    // La tarjeta de siguiente acción también (feature 6).
    expect(crmSrc).toContain("title: 'WhatsApp enviado (siguiente acción)'");
  });
});
