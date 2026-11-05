// Layout de la columna "Acciones" de Propiedades (2026-11-04).
// Con 15 iconos en una sola línea la columna medía 310px y la tabla sumaba
// 1126px de columnas fijas: el título de la propiedad quedaba aplastado y
// había que scrollear en horizontal. Ahora son 2 filas y la columna bajó a
// 210px. Este test mide el render REAL (admin.css + fontawesome del repo)
// con el caso máximo de botones: nada se desborda, son 2 filas exactas y el
// título recupera el ancho.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const propsSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin-propiedades.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'admin.css'), 'utf8');

/* Caso MÁXIMO: ML actualizar + quitar, RELA sincronizar + despublicar,
   La Voz, YouTube, campaña, encuestas (fila 1 = 8) + WhatsApp, 2 carteles,
   duplicar, ZIP, editar y eliminar (fila 2 = 7) = 15 botones. */
const MAX_CASE = `
  <table class="luxury-table props-table" style="width:1200px">
    <colgroup>
      <col class="col-check" /><col class="col-code" /><col class="col-prop" /><col class="col-surf" />
      <col class="col-rooms" /><col class="col-price" /><col class="col-op" /><col class="col-owner" />
      <col class="col-state" /><col class="col-act" />
    </colgroup>
    <tbody>
      <tr>
        <td><input type="checkbox" /></td>
        <td>ML-1234</td>
        <td><div class="props-prop"><img class="props-thumb" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" /><div class="props-prop-body"><span class="props-title">Casa en Palermo</span><span class="props-loc">Palermo · Av. Libertador 1234</span></div></div></td>
        <td class="props-num">180 m²</td><td class="props-num">4</td><td class="props-price">USD 220.000</td>
        <td>—</td><td><span class="props-owner">Dueño</span></td><td><div class="props-state"><span class="props-badge">Publicada</span></div></td>
        <td data-col-actions>
          <div class="props-actions props-actions--split">
            <div class="props-actions-row">
              <button class="btn-action"><i class="fas fa-arrows-rotate"></i></button>
              <button class="btn-action danger"><i class="fas fa-link-slash"></i></button>
              <button class="btn-action"><i class="fas fa-arrows-rotate"></i></button>
              <button class="btn-action danger"><i class="fas fa-cloud-arrow-down"></i></button>
              <button class="btn-action"><i class="fas fa-newspaper"></i></button>
              <button class="btn-action"><i class="fab fa-youtube"></i></button>
              <button class="btn-action"><i class="fas fa-bullhorn"></i></button>
              <button class="btn-action"><i class="fas fa-clipboard-list"></i></button>
            </div>
            <div class="props-actions-row">
              <button class="btn-action"><i class="fab fa-whatsapp"></i></button>
              <button class="btn-action"><i class="fas fa-sign-hanging"></i></button>
              <button class="btn-action"><i class="fas fa-house-circle-check"></i></button>
              <button class="btn-action"><i class="fas fa-copy"></i></button>
              <button class="btn-action"><i class="fas fa-file-zipper"></i></button>
              <button class="btn-action"><i class="fas fa-pen"></i></button>
              <button class="btn-action danger"><i class="fas fa-trash"></i></button>
            </div>
          </div>
        </td>
      </tr>
    </tbody>
  </table>`;

test.describe('Propiedades: layout de la columna Acciones', () => {
  test('el markup agrupa las acciones en 2 filas semánticas', () => {
    expect(propsSrc).toContain('class="props-actions props-actions--split"');
    expect(propsSrc).toContain('class="props-actions-row"');
    // Fila 1 = publicación/canales: ML, RELA, La Voz, video, campaña, encuestas.
    const iSplit = propsSrc.indexOf('props-actions--split');
    const row1Start = propsSrc.indexOf('props-actions-row', iSplit);
    const row2Start = propsSrc.indexOf('props-actions-row', row1Start + 10);
    const row1 = propsSrc.slice(row1Start, row2Start);
    expect(row1).toContain('${mlButtons}');
    expect(row1).toContain('${relaButtons}');
    expect(row1).toContain('data-lavoz-action="prepare"');
    expect(row1).toContain('data-prop-video');
    expect(row1).toContain('data-prop-act="campaign"');
    // Fila 2 = contacto/operación.
    const row2 = propsSrc.slice(row2Start, propsSrc.indexOf('</td>', row2Start));
    expect(row2).toContain('data-wa-share');
    expect(row2).toContain('data-qr-tasacion');
    expect(row2).toContain('data-qr-propiedad');
    expect(row2).toContain('data-prop-act="edit"');
    expect(row2).toContain('data-prop-act="delete"');
    // La vista papelera conserva su fila simple (2 botones).
    expect(propsSrc).toMatch(/<div class="props-actions">\s*\$\{zipBtn\}/);
  });

  test('el CSS: columna de 240px + reglas de las 2 filas', () => {
    expect(cssSrc).toMatch(/\.props-table col\.col-act\s*\{\s*width:\s*240px;\s*\}/);
    expect(cssSrc).toContain('.props-actions--split');
    expect(cssSrc).toContain('.props-actions--split .props-actions-row');
    // Los botones del split son 24x24 (el base es 30x30): 8 por fila entran
    // en los 216px útiles. Si esto se rompe, las filas envuelven a 3 líneas.
    expect(cssSrc).toMatch(/\.props-actions--split \.btn-action\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/);
    // La columna NO puede volver a 310px (era lo que apretaba la tabla).
    expect(cssSrc).not.toMatch(/\.props-table col\.col-act\s*\{\s*width:\s*3\d\dpx/);
  });

  test('render real: 2 filas exactas, sin desborde, y el título recupera ancho', async ({ page }) => {
    /* admin.html carga el admin.css y el fontawesome REALES del repo. */
    await page.goto('/admin.html');
    await page.evaluate((html) => {
      document.body.innerHTML = '<div style="padding:12px">' + html + '</div>';
    }, MAX_CASE);
    await page.waitForTimeout(150);

    const m = await page.evaluate(() => {
      const table = document.querySelector('.props-table');
      const cell = table.querySelector('td[data-col-actions]');
      const rows = Array.from(cell.querySelectorAll('.props-actions-row'));
      const titleCell = table.querySelector('td:nth-child(3)');
      const col = table.querySelector('col.col-act');
      return {
        colWidth: parseFloat(getComputedStyle(col).width),
        cellClient: cell.clientWidth,
        cellScroll: cell.scrollWidth,
        rowCount: rows.length,
        rowHeights: rows.map((r) => {
          const btn = r.querySelector('.btn-action');
          const btnH = btn ? btn.getBoundingClientRect().height : 0;
          const rowH = r.getBoundingClientRect().height;
          /* Si la fila envuelve a 2 líneas, su alto duplica el del botón. */
          return btnH ? Math.round((rowH / btnH) * 100) / 100 : 0;
        }),
        titleWidth: titleCell.getBoundingClientRect().width,
        buttons: cell.querySelectorAll('.btn-action').length,
      };
    });

    expect(m.buttons).toBe(15);
    expect(m.rowCount).toBe(2);
    // La columna mide lo que pedimos…
    expect(m.colWidth).toBe(240);
    // …y NADA se desborda (ni la celda ni las filas).
    expect(m.cellScroll).toBeLessThanOrEqual(m.cellClient + 1);
    for (const ratio of m.rowHeights) {
      expect(ratio).toBeLessThanOrEqual(1.6); // una sola línea de botones
    }
    // El premio: el título de la propiedad vuelve a tener ancho usable
    // (con la columna de 310px quedaban ~74px en una tabla de 1200px).
    expect(m.titleWidth).toBeGreaterThan(135);
  });
});
