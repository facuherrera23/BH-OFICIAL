/* ============================================================
   BIENENHAUS PROPIEDADES - Admin - Módulo: Supervisión (shim de entrada)
   ------------------------------------------------------------
   La UI completa vive en admin-supervision.js (window.adminSupervision).
   Este archivo quedó como punto de entrada estable para admin-app.js
   (tab-router → window.__BH.loadSupervision) tras retirar el panel viejo
   de ~90KB que solo se usaba como delegación. Gate de rol super_admin
   antes de delegar: la UI nueva no lo valida por sí misma (RLS protege
   los datos, esto mejora el feedback para broker/agente).
   ============================================================ */
(function () {
  'use strict';
  const { showToast, navigateTo } = window.__BH || {};

  async function loadSupervision() {
    if (window.currentProfile && window.currentProfile.role !== 'super_admin') {
      showToast('Acceso denegado: solo Super Admin', 'error');
      navigateTo('tab-dashboard');
      return;
    }
    if (window.adminSupervision) {
      window.adminSupervision.load();
      return;
    }
    showToast('Módulo de supervisión no disponible', 'error');
  }

  /* Stub forward-compatible: la vista de anomalías se reintroduce en la UI
     nueva (adminSupervision.loadAnomalies); hasta entonces avisa en consola. */
  function loadAnomaliesTable() {
    if (window.adminSupervision && typeof window.adminSupervision.loadAnomalies === 'function') {
      window.adminSupervision.loadAnomalies();
      return;
    }
    console.warn('[sup] loadAnomaliesTable: la vista de anomalías todavía no está implementada en la UI nueva');
  }

  window.__BH = window.__BH || {};
  window.__BH.loadSupervision = loadSupervision;
  window.__BH.loadAnomaliesTable = loadAnomaliesTable;
  window.adminApp = window.adminApp || {};
  window.adminApp.loadSupervision = loadSupervision;
  window.adminApp.loadAnomaliesTable = loadAnomaliesTable;
  if (!Object.prototype.hasOwnProperty.call(window, 'loadSupervision')) Object.defineProperty(window, 'loadSupervision', { get: () => loadSupervision, set: (v) => { loadSupervision = v; }, configurable: true });
  if (!Object.prototype.hasOwnProperty.call(window, 'loadAnomaliesTable')) Object.defineProperty(window, 'loadAnomaliesTable', { get: () => loadAnomaliesTable, set: (v) => { loadAnomaliesTable = v; }, configurable: true });
})();
