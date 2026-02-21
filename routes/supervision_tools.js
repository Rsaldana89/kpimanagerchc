const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const isAuth = require('../middleware/isAuth');
const { requireRole } = require('../middleware/roles');
const multer = require('multer');
const upload = multer();
const dashboardRoutes = require('./dashboard');
const ExcelJS = require('exceljs');
const { scoreKpi } = require('../services/kpiScoring');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Devuelve el año y mes predeterminados (periodo anterior al mes actual)
/**
 * Calcula el periodo por defecto para la pantalla de rutas.  Durante los
 * primeros 25 días del mes se muestra el mes anterior; a partir del
 * día 26 se cambia al mes actual.  Esto mantiene sincronizado el
 * periodo con el usado en el dashboard de KPIs.  Devuelve el
 * año y el mes (1-12).
 *
 * @returns {{year:number, month:number}} Objeto con el periodo por defecto.
 */
function getDefaultPeriod() {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1; // 1..12
  // Hasta el día 25 inclusive se utiliza el mes anterior
  if (now.getDate() <= 25) {
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }
  return { year, month };
}

// Normaliza strings para comparaciones (similar a normUpper en empleados.js)
function normUpperLocal(v) {
  return String(v || '')
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

// Leer valor de celda y convertir a string trim
function cleanCellString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.text) return String(v.text).trim();
  return String(v).trim();
}

// Convierte nombre de mes (string o número) a número de mes (1..12)
function parseMesToNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    const n = Number(v);
    return (n >= 1 && n <= 12) ? n : null;
  }
  const s = String(v).trim().toUpperCase();
  if (!s) return null;
  const m = Number(s);
  if (Number.isFinite(m) && m >= 1 && m <= 12) return m;
  // Nombres en español (Enero, Febrero, etc.)
  const months = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
  const idx = months.findIndex(name => name.startsWith(s));
  return (idx >= 0) ? (idx + 1) : null;
}

/**
 * Construye un libro de Excel simplificado para exportar las rutas de supervisión.
 * Genera una hoja "Equipo" con las columnas: No. Empleado, Sucursal, Nombre, Puesto,
 * KPI, Objetivo y Calificación. También agrega una fila de instrucciones y una
 * hoja adicional "INSTRUCCIONES" con pasos de captura. La columna de calificación
 * queda desbloqueada y validada para aceptar sólo números. El periodo se incluye
 * en la instrucción.
 *
 * @param {Object} params - Objeto con las propiedades employees (array de empleados), year y month.
 * @returns {Promise<Workbook>} Una instancia de ExcelJS.Workbook con el formato preparado.
 */
async function buildSimpleRoutesWorkbook({ employees, year, month }) {
  // Crear workbook y hoja principal
  const wb = new ExcelJS.Workbook();
  wb.creator = 'KPI Manager CHC';
  wb.created = new Date();
  const ws = wb.addWorksheet('Equipo');
  // Definir columnas en el orden solicitado.  Añadimos una columna "Ruta"
  // que indica la ruta de supervisión a la que pertenece cada empleado.
  ws.columns = [
    { header: 'No. Empleado', key: 'incidencia_id' },
    { header: 'Ruta', key: 'ruta' },
    { header: 'Sucursal', key: 'sucursal' },
    { header: 'Nombre', key: 'nombre' },
    { header: 'Puesto', key: 'puesto' },
    { header: 'KPI', key: 'kpi' },
    { header: 'Objetivo', key: 'objetivo' },
    { header: 'Calificación', key: 'calificacion' },
  ];
  // Si no hay empleados se devuelve el libro vacío con encabezados
  if (!employees || !employees.length) {
    return wb;
  }
  // Obtener lista única de puestos para recuperar sus KPIs
  const puestoIds = [...new Set(employees.map(e => Number(e.puesto_id)).filter(Boolean))];
  const kpisByPuesto = new Map();
  if (puestoIds.length) {
    const placeholders = puestoIds.map(() => '?').join(',');
    const [pkRows] = await pool.execute(
      `SELECT pk.puesto_id, k.id AS kpi_id, k.nombre AS kpi_nombre, k.objetivo
       FROM puesto_kpis pk
       JOIN kpis k ON pk.kpi_id = k.id
       WHERE pk.puesto_id IN (${placeholders})
       ORDER BY pk.puesto_id, k.nombre`,
      puestoIds
    );
    pkRows.forEach(r => {
      const list = kpisByPuesto.get(Number(r.puesto_id)) || [];
      list.push({ kpi_id: Number(r.kpi_id), kpi_nombre: r.kpi_nombre || '', objetivo: r.objetivo || '' });
      kpisByPuesto.set(Number(r.puesto_id), list);
    });
  }
  // Obtener resultados existentes para los empleados en el periodo seleccionado
  const empIds = employees.map(e => Number(e.id)).filter(Boolean);
  const resultsMap = new Map();
  if (empIds.length) {
    const empPlace = empIds.map(() => '?').join(',');
    const [resRows] = await pool.execute(
      `SELECT empleado_id, kpi_id, valor FROM kpi_resultados
       WHERE empleado_id IN (${empPlace}) AND anio = ? AND mes = ?`,
      [...empIds, year, month]
    );
    resRows.forEach(r => {
      resultsMap.set(`${Number(r.empleado_id)}|${Number(r.kpi_id)}`, r.valor);
    });
  }
  // Construir filas para cada empleado y sus KPIs
  employees.forEach(emp => {
    const kpis = kpisByPuesto.get(Number(emp.puesto_id)) || [];
    kpis.forEach(k => {
      const existing = resultsMap.get(`${Number(emp.id)}|${Number(k.kpi_id)}`);
      const valor = (existing !== undefined && existing !== null) ? existing : '';
      const row = ws.addRow({
        incidencia_id: emp.incidencia_id || '',
        // Ruta informativa: usa ruta_label si está definida; de lo contrario,
        // convierte ruta_id a cadena.  Si no hay ruta asignada, queda vacía.
        ruta: (emp.ruta_label !== undefined ? emp.ruta_label : (emp.ruta_id !== undefined ? String(emp.ruta_id) : '')),
        sucursal: emp.sucursal_nombre || '',
        nombre: emp.nombre || '',
        puesto: emp.puesto_nombre || '',
        kpi: k.kpi_nombre || '',
        objetivo: k.objetivo || '',
        calificacion: valor
      });
      // Bloquear todas las celdas por defecto
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.protection = { locked: true };
      });
      // Desbloquear la celda de calificación (última columna).  Ahora es la
      // octava columna debido a la inclusión de la columna "Ruta".
      const calCell = row.getCell(8);
      calCell.protection = { locked: false };
      // Validación: solo números decimales, rango amplio; permitir vacío
      calCell.dataValidation = {
        type: 'decimal',
        operator: 'between',
        allowBlank: true,
        formulae: [-999999999, 999999999],
        showErrorMessage: true,
        errorTitle: 'Valor inválido',
        error: 'Ingrese un valor numérico.'
      };
    });
  });
  // Insertar fila de instrucciones arriba
  const periodoStr = `${String(month).padStart(2, '0')}/${year}`;
  const instruccion = `Capture únicamente valores NUMÉRICOS en la columna \"Calificación\". No modifique las demás columnas. Periodo: ${periodoStr}.`;
  ws.spliceRows(1, 0, []);
  ws.mergeCells(1, 1, 1, ws.columnCount);
  const instrCell = ws.getCell('A1');
  instrCell.value = instruccion;
  instrCell.font = { bold: true, size: 12 };
  instrCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  instrCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2CC' } };
  ws.getRow(1).height = 35;
  // Formato del encabezado (ahora en fila 2)
  const headerRow = ws.getRow(2);
  headerRow.font = { bold: true };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'D9D9D9' } };
  // Auto filtro sobre el encabezado
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: ws.columnCount } };
  // Ajustar anchos de columnas para legibilidad. Se incluye la columna "Ruta".
  const widths = [15, 12, 20, 25, 20, 30, 15, 15];
  widths.forEach((w, idx) => {
    ws.getColumn(idx + 1).width = w;
  });
  // Congelar las dos primeras filas (instrucción y encabezado)
  ws.views = [{ state: 'frozen', ySplit: 2 }];
  // Modificar celdas de calificación: color verde claro y mensaje de ayuda
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= 2) return;
    const calCell = row.getCell(8);
    if (calCell) {
      const dv = calCell.dataValidation || {};
      dv.showInputMessage = true;
      dv.promptTitle = 'Capture calificación';
      dv.prompt = 'Capture un número (puede ser decimal).';
      calCell.dataValidation = dv;
      calCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'CCFFCC' } };
    }
  });
  // Crear hoja de instrucciones adicional
  const sheetInstr = wb.addWorksheet('INSTRUCCIONES');
  sheetInstr.addRow(['Instrucciones para capturar las calificaciones']);
  sheetInstr.getRow(1).font = { bold: true, size: 14 };
  sheetInstr.getRow(1).alignment = { horizontal: 'left' };
  sheetInstr.addRow([]);
  sheetInstr.addRow(['1. No cambie los nombres, KPIs ni la estructura del archivo.']);
  sheetInstr.addRow(['2. Solo escriba valores numéricos en la columna "Calificación".']);
  sheetInstr.addRow(['3. No agregue ni elimine filas.']);
  sheetInstr.addRow(['4. Guarde el archivo y cárguelo de nuevo en la plataforma.']);
  sheetInstr.getColumn(1).width = 100;
  // Proteger la hoja principal: todas las celdas bloqueadas excepto calificaciones
  await ws.protect('CHC', { selectLockedCells: true, selectUnlockedCells: true });
  return wb;
}

// -----------------------------------------------------------------------------
// Página de administración de supervisión
// -----------------------------------------------------------------------------

/**
 * Renderiza la página principal de administración de rutas y exportación/importación.
 * Sólo accesible para administradores.
 */
router.get('/admin/supervision', isAuth, requireRole(['admin']), async (req, res) => {
  // Calcular periodo seleccionado (por defecto mes anterior)
  let year = parseInt(req.query.anio, 10);
  let month = parseInt(req.query.mes, 10);
  // Permitir que el periodo se herede de la sesión si no viene en query.
  // Esto facilita que al navegar a la pantalla de rutas sin parámetros
  // (por ejemplo desde la navegación), se utilice el mismo periodo que el
  // usuario tenía en el dashboard.
  if ((!year || isNaN(year)) && req.session && req.session.selectedYear) {
    year = parseInt(req.session.selectedYear, 10);
  }
  if ((!month || isNaN(month) || month < 1 || month > 12) && req.session && req.session.selectedMonth) {
    month = parseInt(req.session.selectedMonth, 10);
  }
  const def = getDefaultPeriod();
  if (!year || isNaN(year)) year = def.year;
  if (!month || isNaN(month) || month < 1 || month > 12) month = def.month;
  return res.render('supervision_tools', {
    selectedYear: year,
    selectedMonth: month,
    user: req.session.user || {}
  });
});

/**
 * Exporta los resultados de todas las rutas combinadas en un solo archivo Excel.
 * Incluye únicamente empleados asignados a alguna ruta de supervisión.
 * GET /admin/supervision/export?anio=YYYY&mes=MM&showBajas=0|1
 */
router.get('/admin/supervision/export', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    let year = parseInt(req.query.anio, 10);
    let month = parseInt(req.query.mes, 10);
    const def = getDefaultPeriod();
    if (!year || isNaN(year)) year = def.year;
    if (!month || isNaN(month) || month < 1 || month > 12) month = def.month;
    const includeBajas = String(req.query.showBajas || '') === '1';

    // Seleccionar todos los empleados asignados a una ruta (virtual o real)
    const whereBajas = includeBajas ? '' : "AND (d.nombre IS NULL OR UPPER(d.nombre) <> 'BAJA')";
    const [emps] = await pool.execute(
      `SELECT e.id, e.incidencia_id, e.nombre,
              e.puesto_id,
              p.nombre AS puesto_nombre,
              d.nombre AS departamento_nombre,
              s.nombre AS sucursal_nombre,
              COALESCE(sv.id, sr.ruta_id) AS ruta_id
       FROM empleados e
       LEFT JOIN puestos p ON e.puesto_id = p.id
       LEFT JOIN departamentos d ON e.departamento_id = d.id
       LEFT JOIN sucursales s ON e.sucursal_id = s.id
       LEFT JOIN supervision_rutas sv ON sv.nombre = s.nombre
       LEFT JOIN sucursal_supervision_ruta sr ON sr.sucursal_id = s.id AND sr.activo = 1
       WHERE COALESCE(sv.id, sr.ruta_id) IS NOT NULL
         AND e.puesto_id NOT IN (45, 46)
       ${whereBajas}
       ORDER BY COALESCE(sv.id, sr.ruta_id), s.nombre, e.incidencia_id`
    );
    if (!emps || !emps.length) {
      return res.status(404).send('No hay empleados asignados a rutas para exportar');
    }
    // Ordenar los empleados según ruta_id, sucursal y número de empleado
    const employeesSorted = [...emps].sort((a, b) => {
      const ra = a.ruta_id || 0;
      const rb = b.ruta_id || 0;
      if (ra !== rb) return ra - rb;
      const sa = String(a.sucursal_nombre || '').toUpperCase();
      const sb = String(b.sucursal_nombre || '').toUpperCase();
      if (sa !== sb) return sa.localeCompare(sb, 'es');
      const ina = String(a.incidencia_id || '').toUpperCase();
      const inb = String(b.incidencia_id || '').toUpperCase();
      return ina.localeCompare(inb, 'es');
    });
    // Antes de construir el libro, asignar una etiqueta de ruta para cada empleado.  Esto se
    // utilizará en la columna "Ruta" del Excel.  Si no existe ruta_id se deja vacío.
    employeesSorted.forEach(emp => {
      emp.ruta_label = (emp.ruta_id !== null && emp.ruta_id !== undefined) ? String(emp.ruta_id) : '';
    });
    // Construir un Excel simplificado utilizando buildSimpleRoutesWorkbook
    const wb = await buildSimpleRoutesWorkbook({ employees: employeesSorted, year, month });
    if (!wb) {
      return res.status(500).send('No se pudieron generar los datos');
    }
    const fileName = `KPIs_Rutas_${year}-${String(month).padStart(2, '0')}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const buffer = await wb.xlsx.writeBuffer();
    return res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('Error al exportar todas las rutas:', err);
    return res.status(500).send('No se pudo exportar las rutas');
  }
});

/**
 * Exporta los resultados de una sola ruta (por id) en un archivo Excel.
 * GET /admin/supervision/export/:rutaId?anio=YYYY&mes=MM&showBajas=0|1
 */
router.get('/admin/supervision/export/:rutaId', isAuth, requireRole(['admin']), async (req, res) => {
  const rutaId = parseInt(req.params.rutaId, 10);
  if (!rutaId || isNaN(rutaId)) {
    return res.status(400).send('Ruta inválida');
  }
  try {
    let year = parseInt(req.query.anio, 10);
    let month = parseInt(req.query.mes, 10);
    const def = getDefaultPeriod();
    if (!year || isNaN(year)) year = def.year;
    if (!month || isNaN(month) || month < 1 || month > 12) month = def.month;
    const includeBajas = String(req.query.showBajas || '') === '1';

    const whereBajas = includeBajas ? '' : "AND (d.nombre IS NULL OR UPPER(d.nombre) <> 'BAJA')";
    const [emps] = await pool.execute(
      `SELECT e.id, e.incidencia_id, e.nombre,
              e.puesto_id,
              p.nombre AS puesto_nombre,
              d.nombre AS departamento_nombre,
              s.nombre AS sucursal_nombre,
              COALESCE(sv.id, sr.ruta_id) AS ruta_id
       FROM empleados e
       LEFT JOIN puestos p ON e.puesto_id = p.id
       LEFT JOIN departamentos d ON e.departamento_id = d.id
       LEFT JOIN sucursales s ON e.sucursal_id = s.id
       LEFT JOIN supervision_rutas sv ON sv.nombre = s.nombre
       LEFT JOIN sucursal_supervision_ruta sr ON sr.sucursal_id = s.id AND sr.activo = 1
       WHERE COALESCE(sv.id, sr.ruta_id) = ?
         AND e.puesto_id NOT IN (45, 46)
       ${whereBajas}
       ORDER BY s.nombre, e.incidencia_id`,
      [rutaId]
    );
    if (!emps || !emps.length) {
      return res.status(404).send('No hay empleados para la ruta solicitada');
    }
    const employeesSorted = [...emps];
    // Asignar etiqueta de ruta para cada empleado (todos tendrán la misma)
    employeesSorted.forEach(emp => {
      emp.ruta_label = (emp.ruta_id !== null && emp.ruta_id !== undefined) ? String(emp.ruta_id) : '';
    });
    // Construir un Excel simplificado para la ruta específica
    const wb = await buildSimpleRoutesWorkbook({ employees: employeesSorted, year, month });
    if (!wb) {
      return res.status(500).send('No se pudieron generar los datos');
    }
    const fileName = `KPIs_Ruta${rutaId}_${year}-${String(month).padStart(2, '0')}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const buffer = await wb.xlsx.writeBuffer();
    return res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('Error al exportar ruta específica:', err);
    return res.status(500).send('No se pudo exportar la ruta');
  }
});

/**
 * Importa calificaciones y retroalimentación para todos los empleados desde Excel.
 * Sólo accesible para administradores.  Similar a dashboard/import/route pero
 * sin restricción de ruta; se actualizan todas las coincidencias por periodo.
 * POST /supervision/admin/import
 */
router.post('/admin/supervision/import', isAuth, requireRole(['admin']), upload.single('file'), async (req, res) => {
  const user = req.session.user;
  try {
    let year = parseInt(req.body.anio || req.query.anio, 10);
    let month = parseInt(req.body.mes || req.query.mes, 10);
    const def = getDefaultPeriod();
    const selectedYear = (Number.isFinite(year) && year > 2000) ? year : def.year;
    const selectedMonth = (Number.isFinite(month) && month >= 1 && month <= 12) ? month : def.month;

    if (!req.file || !req.file.buffer) {
      req.flash('error', 'No se recibió el archivo Excel (.xlsx).');
      return res.redirect(`/admin/supervision?anio=${selectedYear}&mes=${selectedMonth}`);
    }
    // Cargar workbook
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const wsEquipo = wb.getWorksheet('Equipo') || wb.worksheets[0];
    const wsRetro = wb.getWorksheet('Retroalimentación');
    if (!wsEquipo) {
      req.flash('error', 'El archivo no contiene la hoja "Equipo".');
      return res.redirect(`/admin/supervision?anio=${selectedYear}&mes=${selectedMonth}`);
    }
    // Mapear encabezados -> columna.  La primera fila de la hoja "Equipo" es una
    // fila de instrucciones insertada al exportar, por lo que los encabezados
    // reales se encuentran en la fila 2.  No obstante, buscamos de forma
    // dinámica las columnas principales (No. Empleado, KPI y Calificación)
    // escaneando las primeras 5 filas por si los encabezados no están en la fila 2.
    let headerRow = wsEquipo.getRow(1);
    let headerMap = {};
    // Buscar en las primeras 5 filas (incluyendo 1) la fila que contiene al
    // menos las palabras "NO. EMPLEADO" o "KPI".  Si no se encuentran, se
    // asume que la fila 2 contiene los encabezados.
    for (let r = 1; r <= Math.min(wsEquipo.rowCount, 5); r++) {
      const row = wsEquipo.getRow(r);
      let found = false;
      row.eachCell((cell) => {
        const key = cleanCellString(cell.value).toUpperCase();
        if (key === 'NO. EMPLEADO' || key === 'NO EMPLEADO' || key === 'KPI') {
          found = true;
        }
      });
      if (found) {
        headerRow = row;
        break;
      }
    }
    headerMap = {};
    headerRow.eachCell((cell, colNumber) => {
      const key = cleanCellString(cell.value).toUpperCase();
      if (key) headerMap[key] = colNumber;
    });
    // Columnas requeridas en el formato simplificado
    const colEmpNo = headerMap['NO. EMPLEADO'] || headerMap['NO EMPLEADO'] || headerMap['NO. EMPLEADO '] || headerMap['NO EMPLEADO '];
    const colKpi = headerMap['KPI'];
    // La columna de calificación puede tener acentos o espacios
    const colCalif = headerMap['CALIFICACION'] || headerMap['CALIFICACIÓN'] || headerMap['CALIFICACION '] || headerMap['CALIFICACIÓN '];
    if (!colEmpNo || !colKpi || !colCalif) {
      req.flash('error', 'La hoja "Equipo" no tiene las columnas mínimas esperadas (No. Empleado, KPI, Calificación).');
      return res.redirect(`/admin/supervision?anio=${selectedYear}&mes=${selectedMonth}`);
    }
    // Colectar filas a procesar y conjuntos de empleados/kpis
    const rowsToProcess = [];
    const empNoSet = new Set();
    const kpiNameSet = new Set();
    const startRow = headerRow.number + 1;
    for (let r = startRow; r <= wsEquipo.rowCount; r++) {
      const row = wsEquipo.getRow(r);
      const empNo = cleanCellString(row.getCell(colEmpNo).value);
      const kpiName = cleanCellString(row.getCell(colKpi).value);
      const valorRaw = row.getCell(colCalif).value;
      const valorStr = cleanCellString(valorRaw);
      if (!empNo || !kpiName) continue;
      if (valorStr === '') continue;
      rowsToProcess.push({ empNo, kpiName, valorStr, comentarioStr: '' });
      empNoSet.add(empNo);
      kpiNameSet.add(kpiName);
    }
    if (!rowsToProcess.length && (!wsRetro || wsRetro.rowCount <= 1)) {
      req.flash('error', 'No se encontraron calificaciones para importar en la hoja "Equipo".');
      return res.redirect(`/admin/supervision?anio=${selectedYear}&mes=${selectedMonth}`);
    }
    // Cargar empleados existentes por No. empleado
    const empNos = Array.from(empNoSet);
    let empRows = [];
    if (empNos.length) {
      const empNoPlace = empNos.map(() => '?').join(',');
      const [eRows] = await pool.execute(
        `SELECT e.id, e.incidencia_id, e.nombre, e.puesto_id
         FROM empleados e
         WHERE e.incidencia_id IN (${empNoPlace})
           AND e.puesto_id NOT IN (45, 46)`,
        empNos
      );
      empRows = eRows;
    }
    const empByNo = new Map();
    empRows.forEach(e => empByNo.set(String(e.incidencia_id), e));
    // Cargar KPIs por nombre
    const kpiNames = Array.from(kpiNameSet);
    let kpiRows = [];
    if (kpiNames.length) {
      const kpiPlace = kpiNames.map(() => '?').join(',');
      const [kRows] = await pool.execute(
        `SELECT * FROM kpis WHERE nombre IN (${kpiPlace})`,
        kpiNames
      );
      kpiRows = kRows;
    }
    const kpiByName = new Map();
    kpiRows.forEach(k => kpiByName.set(String(k.nombre), k));
    // Pre-cargar locks existentes para el periodo
    const employeeIds = Array.from(new Set(empRows.map(e => Number(e.id)))).filter(Boolean);
    const kpiIds = Array.from(new Set(kpiRows.map(k => Number(k.id)))).filter(Boolean);
    const lockMap = new Map();
    if (employeeIds.length && kpiIds.length) {
      const empIdPlace = employeeIds.map(() => '?').join(',');
      const kpiIdPlace = kpiIds.map(() => '?').join(',');
      const [lockRows] = await pool.execute(
        `SELECT empleado_id, kpi_id, visto_bueno, visto_por
         FROM kpi_resultados
         WHERE empleado_id IN (${empIdPlace})
           AND kpi_id IN (${kpiIdPlace})
           AND anio = ? AND mes = ?`,
        [...employeeIds, ...kpiIds, selectedYear, selectedMonth]
      );
      lockRows.forEach(r => {
        lockMap.set(`${r.empleado_id}|${r.kpi_id}`, {
          visto_bueno: Number(r.visto_bueno) === 1,
          visto_por: r.visto_por !== null ? Number(r.visto_por) : null
        });
      });
    }
    // Procesar en transacción
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      let updated = 0;
      let inserted = 0;
      let skipped = 0;
      let lockedSkipped = 0;
      let notFound = 0;
      for (const r of rowsToProcess) {
        const emp = empByNo.get(String(r.empNo));
        const kpi = kpiByName.get(String(r.kpiName));
        if (!emp || !kpi) {
          notFound++;
          continue;
        }
        const lockKey = `${emp.id}|${kpi.id}`;
        const lockInfo = lockMap.get(lockKey);
        const isLocked = lockInfo ? !!lockInfo.visto_bueno : false;
        // Para administradores, siempre se permite editar bloqueados
        const canEditLocked = true;
        if (isLocked && !canEditLocked) {
          lockedSkipped++;
          continue;
        }
        const changes = {};
        const hasValor = r.valorStr !== '';
        const hasComentario = r.comentarioStr !== '';
        if (!hasValor && !hasComentario) {
          skipped++;
          continue;
        }
        if (hasValor) {
          const asNum = Number(String(r.valorStr).replace(',', '.'));
          const finalValor = Number.isFinite(asNum) ? asNum : null;
          changes.valor = finalValor;
          if (finalValor !== null) {
            const score = scoreKpi(kpi, finalValor);
            changes.color = score.color;
          }
        }
        if (hasComentario) {
          changes.comentario = r.comentarioStr;
        }
        // Upsert resultado
        const [existsRows] = await conn.execute(
          'SELECT id FROM kpi_resultados WHERE empleado_id = ? AND kpi_id = ? AND anio = ? AND mes = ? LIMIT 1',
          [emp.id, kpi.id, selectedYear, selectedMonth]
        );
        if (existsRows.length) {
          // Actualizar registro existente: valor, color, comentario y marcarlo como calificado y aprobado
          const idRes = existsRows[0].id;
          const fields = [];
          const vals = [];
          if (Object.prototype.hasOwnProperty.call(changes, 'valor')) { fields.push('valor = ?'); vals.push(changes.valor); }
          if (Object.prototype.hasOwnProperty.call(changes, 'color')) { fields.push('color = ?'); vals.push(changes.color); }
          if (Object.prototype.hasOwnProperty.call(changes, 'comentario')) { fields.push('comentario = ?'); vals.push(changes.comentario); }
          // Marcar como aprobado
          fields.push('visto_bueno = 1');
          fields.push('visto_por = ?'); vals.push(user.id);
          // Registrar fecha de aprobación si la columna existe.  También limpiar revisión.
          fields.push('visto_fecha = NOW()');
          fields.push('revision_por = NULL');
          fields.push('revision_fecha = NULL');
          fields.push('revision_motivo = NULL');
          await conn.execute(`UPDATE kpi_resultados SET ${fields.join(', ')} WHERE id = ?`, [...vals, idRes]);
          updated++;
        } else {
          // Insertar nuevo registro con valor y color y marcarlo como calificado y aprobado
          const insertVals = {
            empleado_id: emp.id,
            kpi_id: kpi.id,
            anio: selectedYear,
            mes: selectedMonth,
            valor: Object.prototype.hasOwnProperty.call(changes, 'valor') ? changes.valor : null,
            color: Object.prototype.hasOwnProperty.call(changes, 'color') ? changes.color : null,
            comentario: Object.prototype.hasOwnProperty.call(changes, 'comentario') ? changes.comentario : null
          };
          await conn.execute(
            `INSERT INTO kpi_resultados (empleado_id, kpi_id, anio, mes, valor, color, comentario, visto_bueno, visto_por, visto_fecha, revision_por, revision_fecha, revision_motivo)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), NULL, NULL, NULL)`,
            [insertVals.empleado_id, insertVals.kpi_id, insertVals.anio, insertVals.mes, insertVals.valor, insertVals.color, insertVals.comentario, user.id]
          );
          inserted++;
        }
      }
      // Retroalimentación
      let retroUpdated = 0;
      if (wsRetro && wsRetro.rowCount > 1) {
        const retroHeader = wsRetro.getRow(1);
        const retroMap = {};
        retroHeader.eachCell((cell, colNumber) => {
          const key = cleanCellString(cell.value).toUpperCase();
          if (key) retroMap[key] = colNumber;
        });
        const rEmpNo = retroMap['NO. EMPLEADO'] || retroMap['NO EMPLEADO'];
        const rYear = retroMap['AÑO'];
        const rMonth = retroMap['MES'];
        const rFort = retroMap['FORTALEZAS'] || retroMap['FORTALEZAS Y'];
        const rOpor = retroMap['ÁREAS DE OPORTUNIDAD'] || retroMap['AREAS DE OPORTUNIDAD'];
        const rComp = retroMap['COMPROMISOS'];
        for (let rr = 2; rr <= wsRetro.rowCount; rr++) {
          const row = wsRetro.getRow(rr);
          const empNo = rEmpNo ? cleanCellString(row.getCell(rEmpNo).value) : '';
          const rowYear = rYear ? parseInt(cleanCellString(row.getCell(rYear).value), 10) : NaN;
          const rowMonth = rMonth ? parseMesToNumber(row.getCell(rMonth).value) : null;
          if (!empNo || !rowYear || !rowMonth) continue;
          if (rowYear !== selectedYear || rowMonth !== selectedMonth) continue;
          const emp = empByNo.get(String(empNo));
          if (!emp) continue;
          const fortalezas = rFort ? cleanCellString(row.getCell(rFort).value) : '';
          const oportunidades = rOpor ? cleanCellString(row.getCell(rOpor).value) : '';
          const compromisos = rComp ? cleanCellString(row.getCell(rComp).value) : '';
          if (!fortalezas && !oportunidades && !compromisos) continue;
          await conn.execute(
            `INSERT INTO retroalimentacion (empleado_id, anio, mes, fortalezas, oportunidades, compromisos)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               fortalezas = VALUES(fortalezas),
               oportunidades = VALUES(oportunidades),
               compromisos = VALUES(compromisos),
               actualizado_en = CURRENT_TIMESTAMP`,
            [emp.id, selectedYear, selectedMonth, fortalezas, oportunidades, compromisos]
          );
          retroUpdated++;
        }
      }
      await conn.commit();
      req.flash('success', `Importación completada. Actualizados: ${updated}, nuevos: ${inserted}, retroalimentación: ${retroUpdated}, no encontrados: ${notFound}.`);
      return res.redirect(`/admin/supervision?anio=${selectedYear}&mes=${selectedMonth}`);
    } catch (e) {
      await conn.rollback();
      console.error('Error al importar calificaciones:', e);
      req.flash('error', 'No se pudo completar la importación de calificaciones.');
      return res.redirect(`/admin/supervision?anio=${selectedYear}&mes=${selectedMonth}`);
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('Error en importación admin supervisión:', err);
    req.flash('error', 'Ocurrió un error al procesar la importación.');
    return res.redirect('/admin/supervision');
  }
});

module.exports = router;