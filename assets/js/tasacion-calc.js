/* ============================================================
   BIENENHAUS PROPIEDADES - Tasacion (ACM): calculo compartido
   Unica fuente de coeficientes (PESOS/NIVELES/RUBROS) y del
   calculo de valor final; usado por tasacion.html y admin.html
   para que ambos computen EXACTAMENTE lo mismo.
   ============================================================ */
(function () {
  'use strict';

  const PESOS = {
    CASA:   {label:'Casa',    vars:[['Calidad de ubicación',0.30],['Cantidad de habitaciones',0.20],['Estado de mantenimiento',0.20],['Antigüedad',0.15],['Comodidades',0.10],['Estacionamiento',0.05]]},
    DEPTO:  {label:'Depto',   vars:[['Calidad de ubicación (barrio)',0.30],['Cantidad de habitaciones',0.20],['Ubicación piso',0.15],['Antigüedad',0.15],['Comodidades (edificio)',0.12],['Ubicación planta',0.08]]},
    LOTE:   {label:'Lote',    vars:[['Calidad de ubicación',0.35],['Superficie',0.25],['Servicios',0.20],['Acceso',0.10],['Forma',0.06],['Orientación',0.04]]},
    GALPON: {label:'Galpón',  vars:[['Calidad de ubicación',0.25],['Superficie y altura libre',0.25],['Acceso',0.20],['Instalaciones',0.15],['Estado / antigüedad',0.10],['Oficinas y servicios anexos',0.05]]},
    OFICINA:{label:'Oficina', vars:[['Calidad de ubicación',0.30],['Superficie y layout',0.20],['Ubicación piso / vista',0.15],['Comodidades del edificio',0.15],['Antigüedad / estado',0.12],['Estacionamiento',0.08]]},
    LOCAL:  {label:'Local',   vars:[['Calidad de ubicación',0.35],['Frente / vidriera',0.20],['Superficie y forma',0.15],['Instalaciones',0.12],['Estado de mantenimiento',0.10],['Estacionamiento / carga y descarga',0.08]]},
    OTRO:   {label:'Otro',    vars:[['Calidad de ubicación',0.30],['Superficie',0.15],['Servicios',0.15],['Acceso',0.15],['Instalaciones',0.15],['Estado de mantenimiento',0.10]]},
  };
  const SLOT_ORDER = [3,2,5,0,4,1];

  const NIVELES = {'Mucho Mejor':-0.75, 'Mejor':-0.3, 'Igual':0, 'Peor':0.3, 'Mucho Peor':0.75};
  const NIVELES_LIST = Object.keys(NIVELES);

  const RUBROS = {
    'Electricidad':        {'Óptimo / Impecable (Listo para Habitar)':0,   'Sencilla (Cosmética / Menor)':0.010, 'Moderada (Parcial / Funcional)':0.03, 'Grave (Deterioro Estructural)':0.065,'A Nuevo (Rediseño Total)':0.10},
    'Agua Sanitaria':      {'Óptimo / Impecable (Listo para Habitar)':0,   'Sencilla (Cosmética / Menor)':0.0075,'Moderada (Parcial / Funcional)':0.03, 'Grave (Deterioro Estructural)':0.07, 'A Nuevo (Rediseño Total)':0.11},
    'Cloacas y Desagües':  {'Óptimo / Impecable (Listo para Habitar)':0,   'Sencilla (Cosmética / Menor)':0.0075,'Moderada (Parcial / Funcional)':0.03, 'Grave (Deterioro Estructural)':0.08, 'A Nuevo (Rediseño Total)':0.115},
    'Gas Natural':         {'Óptimo / Impecable (Listo para Habitar)':0,   'Sencilla (Cosmética / Menor)':0.0075,'Moderada (Parcial / Funcional)':0.03, 'Grave (Deterioro Estructural)':0.09, 'A Nuevo (Rediseño Total)':0.125},
    'Techos y Cubiertas':  {'Óptimo / Impecable (Listo para Habitar)':0,   'Sencilla (Cosmética / Menor)':0.015, 'Moderada (Parcial / Funcional)':0.045,'Grave (Deterioro Estructural)':0.115,'A Nuevo (Rediseño Total)':0.20},
    'Internet / Redes':    {'Óptimo / Impecable (Listo para Habitar)':0,   'Sencilla (Cosmética / Menor)':0.0035,'Moderada (Parcial / Funcional)':0.01, 'Grave (Deterioro Estructural)':0.03, 'A Nuevo (Rediseño Total)':0.045},
  };
  const RUBRO_NIVELES = ['Óptimo / Impecable (Listo para Habitar)','Sencilla (Cosmética / Menor)','Moderada (Parcial / Funcional)','Grave (Deterioro Estructural)','A Nuevo (Rediseño Total)'];
  const SERVICIOS_MAP = [
    {key:'electricidad', label:'Electricidad', rubro:'Electricidad'},
    {key:'gas',           label:'Gas',            rubro:'Gas Natural'},
    {key:'internet',      label:'Internet',       rubro:'Internet / Redes'},
    {key:'agua',          label:'Agua',           rubro:'Agua Sanitaria'},
    {key:'cloaca',        label:'Cloaca',         rubro:'Cloacas y Desagües'},
    {key:'techos',        label:'Techos y Desagües', rubro:'Techos y Cubiertas'},
  ];

  function coefCondiciones(tipo, chars) {
    const vars = (PESOS[tipo] || PESOS.CASA).vars;
    let product = 1;
    (chars || []).forEach((nivel, i) => {
      const idx = SLOT_ORDER[i];
      const peso = vars[idx] ? vars[idx][1] : 0;
      const ajuste = NIVELES[nivel] || 0;
      product *= (1 + peso * ajuste);
    });
    return product;
  }

  function coefDepreciacion(servicios) {
    let sum = 0, n = 0;
    SERVICIOS_MAP.forEach(s => {
      const val = (servicios || {})[s.key] || '';
      const pct = (val && RUBROS[s.rubro][val] !== undefined) ? RUBROS[s.rubro][val] : 0;
      sum += pct; n++;
    });
    return n ? 1 - (sum / n) : 1;
  }

  function compute(data) {
    if (!data || typeof data !== 'object') return null;
    const fields = data.fields || {};
    const tipo = data.tipo || fields.f_tipo || 'CASA';
    const precios = [];
    const coefs = [];
    (data.comparables || []).forEach(comp => {
      const precio = parseFloat(comp.precio) || 0;
      const supCub = parseFloat(comp.supCubierta) || 0;
      const supTer = parseFloat(comp.supTerreno) || 0;
      const base = supCub > 0 ? supCub : supTer;
      if (precio > 0 && base > 0) {
        precios.push(precio / base);
        coefs.push(coefCondiciones(tipo, comp.chars));
      }
    });
    const precioPromedio = precios.length ? precios.reduce((a, b) => a + b, 0) / precios.length : 0;
    const coefPromedio = coefs.length ? coefs.reduce((a, b) => a + b, 0) / coefs.length : 1;
    const precioCubiertaM2 = precioPromedio * coefPromedio * coefDepreciacion(data.servicios);
    const terrM2 = parseFloat(fields.f_supTerreno) || 0;
    const terrPrecio = parseFloat((data.valuacion || {}).v_terrenoPrecio) || 0;
    const terrTotal = terrM2 * terrPrecio;
    const cubM2 = parseFloat(fields.f_supConstruida) || 0;
    const cubTotal = cubM2 * precioCubiertaM2;
    const valorFinal = terrTotal + cubTotal;
    return {
      valorFinal: valorFinal > 0 ? Math.round(valorFinal) : null,
      terrTotal, cubTotal, precioPromedio, precioCubiertaM2
    };
  }

  window.BH_TasacionCalc = { PESOS, SLOT_ORDER, NIVELES, NIVELES_LIST, RUBROS, RUBRO_NIVELES, SERVICIOS_MAP, coefCondiciones, coefDepreciacion, compute };
})();
