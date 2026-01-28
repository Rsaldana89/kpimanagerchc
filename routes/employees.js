const express = require('express');
const router = express.Router();
const { pool, incidenciasPool } = require('../db');
const isAuth = require('../middleware/isAuth');
const { requireRole } = require('../middleware/roles');
const mysql = require('mysql2');

// Escape seguro para generar INSERTs en respaldo SQL
const sqlEscape = (v) => mysql.escape(v);

// Normaliza strings para comparaciones (trim + UPPER)
function normUpper(v) {
  return String(v || '').trim().toUpperCase();
}

// Cache simple de ids de departamentos por nombre (en UPPER)
const deptIdCache = new Map();
async function getDepartamentoIdByNombreUpper(nombreUpper) {
  const key = normUpper(nombreUpper);
  if (!key) return null;
  if (deptIdCache.has(key)) return deptIdCache.get(key);
  const [rows] = await pool.execute('SELECT id FROM departamentos WHERE UPPER(nombre) = ? LIMIT 1', [key]);
  const id = rows.length ? rows[0].id : null;
  deptIdCache.set(key, id);
  return id;
}

// Asegura que exista un departamento con ese nombre (case-insensitive) y regresa su id.
// Se usa para BAJA durante importaciones para no depender de una migración previa.
async function ensureDepartamentoIdByNombreUpper(nombreUpper) {
  const key = normUpper(nombreUpper);
  if (!key) return null;
  let id = await getDepartamentoIdByNombreUpper(key);
  if (id) return id;
  try {
    // Intentar crearlo (si ya existe, puede fallar por UNIQUE; lo ignoramos)
    await pool.execute('INSERT INTO departamentos (nombre) VALUES (?)', [key]);
  } catch (e) {
    // ignore
  }
  // Re-consultar
  deptIdCache.delete(key);
  id = await getDepartamentoIdByNombreUpper(key);
  return id;
}

/*
 * Página de listado de empleados.  Muestra todos los registros de la
 * tabla empleados junto con información de puesto, departamento y
 * sucursal.  Desde aquí se accede al formulario de edición y a la
 * importación desde incidencias.
 */
router.get('/', isAuth, requireRole(['admin','manager']), async (req, res) => {
  try {
    // Paginación y búsqueda
    const perPage = 100;
    const currentPage = parseInt(req.query.page, 10) > 0 ? parseInt(req.query.page, 10) : 1;
    const offset = (currentPage - 1) * perPage;

    // Cadena de búsqueda. Busca por nombre, puesto, departamento o No. empleado.
    const search = req.query.q ? req.query.q.trim() : '';

    // Mostrar BAJA sólo bajo demanda.
    const showBajas = String(req.query.showBajas || '') === '1';

    // Filtro opcional por departamento (id).
    const deptFilter = req.query.dept ? String(req.query.dept).trim() : '';

    const whereParts = [];
    const params = [];

    if (search) {
      // Armar condiciones de búsqueda usando LIKE
      const likeTerm = `%${search}%`;
      whereParts.push(`(e.nombre LIKE ? OR p.nombre LIKE ? OR d.nombre LIKE ? OR e.incidencia_id LIKE ?)`);
      params.push(likeTerm, likeTerm, likeTerm, likeTerm);
    }

    if (!showBajas) {
      // Excluir el departamento "BAJA" por default
      whereParts.push(`d.nombre <> 'BAJA'`);
    }

    if (deptFilter) {
      whereParts.push(`e.departamento_id = ?`);
      params.push(deptFilter);
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    // Contar total para la paginación (con filtro si aplica)
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total
       FROM empleados e
       LEFT JOIN puestos p ON e.puesto_id = p.id
       LEFT JOIN departamentos d ON e.departamento_id = d.id
       ${whereClause}`,
      params
    );
    const total = countRows[0] ? countRows[0].total : 0;
    const totalPages = Math.ceil(total / perPage) || 1;

    // Validar limit y offset (no parametrizar en prepared statement)
    const limit = Number.isInteger(perPage) ? perPage : 100;
    const off = Number.isInteger(offset) && offset >= 0 ? offset : 0;

    // Consulta principal: incluir nombre del jefe (puesto al que responde)
    const [rows] = await pool.execute(
      `SELECT e.id, e.incidencia_id, e.nombre, e.correo, e.username, e.login_enabled,
              p.nombre AS puesto_nombre, p.id AS puesto_id,
              d.nombre AS departamento_nombre,
              s.nombre AS sucursal_nombre,
              p2.nombre AS jefe_nombre
       FROM empleados e
       LEFT JOIN puestos p ON e.puesto_id = p.id
       LEFT JOIN departamentos d ON e.departamento_id = d.id
       LEFT JOIN sucursales s ON e.sucursal_id = s.id
       LEFT JOIN puestos p2 ON p.responde_a_id = p2.id
       ${whereClause}
       ORDER BY e.nombre
       LIMIT ${limit} OFFSET ${off}`,
      params
    );

    // Obtener lista de puestos para el formulario de edición
    const [puestos] = await pool.execute(
      `SELECT p.id, p.nombre, d.nombre AS departamento_nombre FROM puestos p JOIN departamentos d ON p.departamento_id = d.id ORDER BY d.nombre, p.nombre`
    );
    // Obtener sucursales para mostrar en select (no editable en form de empleado salvo operaciones)
    const [sucs] = await pool.execute(
      `SELECT s.id, s.nombre FROM sucursales s ORDER BY s.nombre`
    );

    // Lista de departamentos para el filtro
    const [departamentos] = await pool.execute('SELECT id, nombre FROM departamentos ORDER BY nombre');

    // Codificar la cadena de búsqueda para los enlaces de paginación
    const searchEncoded = search ? encodeURIComponent(search) : '';
    const userRole = (req.session.user && req.session.user.role) || '';
    res.render('personal', {
      title: 'Personal',
      empleados: rows,
      puestos,
      sucursales: sucs,
      departamentos,
      currentPage,
      totalPages,
      perPage,
      offset,
      search,
      searchEncoded,
      showBajas,
      deptFilter,
      userRole,
      isAdmin: userRole === 'admin'
    });
  } catch (err) {
    console.error('Error al listar empleados:', err);
    req.flash('error', 'No se pudo cargar el listado de personal');
    return res.redirect('/dashboard');
  }
});

// Info ligera de un puesto (para actualizar UI en Personal al cambiar el puesto)
router.get('/puesto-info/:puestoId', isAuth, requireRole(['admin','manager']), async (req, res) => {
  const puestoId = parseInt(String(req.params.puestoId || ''), 10);
  if (!Number.isFinite(puestoId)) return res.status(400).json({ ok: false, error: 'Puesto no válido' });
  try {
    const [rows] = await pool.execute(
      `SELECT p.id,
              p.nombre AS puesto_nombre,
              d.nombre AS departamento_nombre,
              pj.nombre AS responde_a_puesto_nombre
       FROM puestos p
       LEFT JOIN departamentos d ON p.departamento_id = d.id
       LEFT JOIN puestos pj ON p.responde_a_id = pj.id
       WHERE p.id = ?
       LIMIT 1`,
      [puestoId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Puesto no encontrado' });
    const r = rows[0];
    return res.json({
      ok: true,
      puesto: {
        id: r.id,
        puesto_nombre: r.puesto_nombre || '',
        departamento_nombre: r.departamento_nombre || '',
        responde_a_puesto_nombre: r.responde_a_puesto_nombre || '',
        is_operaciones: String(r.departamento_nombre || '').toUpperCase() === 'OPERACIONES'
      }
    });
  } catch (err) {
    console.error('Error al consultar puesto-info:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo cargar la información del puesto' });
  }
});

/*
 * Ruta POST /personal/edit/:id
 * Actualiza los datos de un empleado.  Recibe nombre, correo,
 * puesto_id, username, password y login_enabled.  Al cambiar el
 * puesto, se actualiza automáticamente el departamento al asociado
 * con dicho puesto.  Si el nuevo departamento es OPERACIONES, se
 * permite seleccionar una sucursal existente; de lo contrario se
 * establece a NULL.
 */
router.post('/edit/:id', isAuth, requireRole(['admin']), async (req, res) => {
  const { id } = req.params;
  // IMPORTANT: usamos nombres de campo distintos a "username" para evitar autofill del navegador
  const { nombre, correo, puesto_id, login_username, password, login_enabled, sucursal_id, auto_generate_login, reset_login_password } = req.body;
  const wantsJson =
    req.xhr ||
    String(req.headers.accept || '').includes('application/json') ||
    String(req.headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest';
  try {
    const puestoIdNum = (puesto_id !== undefined && puesto_id !== null && String(puesto_id).trim() !== '')
      ? parseInt(String(puesto_id), 10)
      : NaN;
    if (!Number.isFinite(puestoIdNum)) {
      if (wantsJson) return res.status(400).json({ ok: false, error: 'Puesto no válido' });
      req.flash('error', 'Puesto no válido');
      return res.redirect('/personal');
    }

    // Obtener datos actuales del empleado (para preservar username/password cuando no se mandan)
    const [currentRows] = await pool.execute(
      'SELECT incidencia_id, username, password, login_enabled FROM empleados WHERE id = ? LIMIT 1',
      [id]
    );
    if (currentRows.length === 0) {
      if (wantsJson) return res.status(404).json({ ok: false, error: 'Empleado no encontrado' });
      req.flash('error', 'Empleado no encontrado');
      return res.redirect('/personal');
    }
    const currentEmp = currentRows[0];

    // Obtener departamento asociado al puesto elegido
    const [puestoRows] = await pool.execute('SELECT departamento_id FROM puestos WHERE id = ?', [puestoIdNum]);
    if (puestoRows.length === 0) {
      if (wantsJson) return res.status(400).json({ ok: false, error: 'Puesto no válido' });
      req.flash('error', 'Puesto no válido');
      return res.redirect('/personal');
    }
    const deptoId = puestoRows[0].departamento_id;
    // Si el departamento es OPERACIONES (buscar por nombre) y sucursal_id existe, mantenerla
    let sucId = null;
    if (deptoId) {
      // Consultar nombre del departamento
      const [depRows] = await pool.execute('SELECT nombre FROM departamentos WHERE id = ?', [deptoId]);
      if (depRows.length && depRows[0].nombre === 'OPERACIONES') {
        sucId = sucursal_id && sucursal_id !== '' ? parseInt(sucursal_id, 10) : null;
      }
    }

    // --- Login: generación automática de credenciales ---
    // Política (modo fácil / texto plano):
    // - username por defecto: No. empleado (incidencia_id)
    // - password por defecto: CHC-<No. empleado>
    // El usuario/contraseña pueden ser editados manualmente desde la pantalla de Personal.
    // Sólo se expone la contraseña recién generada (o reseteada) en la respuesta JSON.
    // login_enabled llega como '1' (checked) o puede venir vacío/undefined.
    // No usar coerción booleana directa porque '0' es truthy.
    const enablingLogin = String(login_enabled || '') === '1';
    const wantsAuto = enablingLogin && String(auto_generate_login || '') === '1';
    const wantsResetPwd = enablingLogin && String(reset_login_password || '') === '1';

    const empNoRaw = (currentEmp.incidencia_id !== null && currentEmp.incidencia_id !== undefined)
      ? String(currentEmp.incidencia_id).trim()
      : '';
    const generatedUsername = empNoRaw || String(id);
    const DEFAULT_PASSWORD_PREFIX = process.env.DEFAULT_PASSWORD_PREFIX || 'CHC-';
    const generatedPassword = `${DEFAULT_PASSWORD_PREFIX}${generatedUsername}`;

    // username final
    let finalUsername = null;
    if (enablingLogin) {
      const userTyped = (login_username && String(login_username).trim() !== '') ? String(login_username).trim() : '';
      if (userTyped) finalUsername = userTyped;
      else if (wantsAuto) finalUsername = generatedUsername;
      else if (currentEmp.username && String(currentEmp.username).trim() !== '') finalUsername = String(currentEmp.username).trim();
      else finalUsername = generatedUsername;
    }

    // password param para SQL ('' = conservar)
    let passwordParam = '';
    const typedPassword = (password && String(password).trim() !== '') ? String(password).trim() : '';
    let generatedCreds = null;
    if (enablingLogin) {
      if (typedPassword) {
        passwordParam = typedPassword;
      } else {
        // Generar si se solicitó auto o si se está reseteando.
        if (wantsResetPwd || wantsAuto || !currentEmp.password) {
          passwordParam = generatedPassword;
          generatedCreds = { username: finalUsername, password: generatedPassword };
        } else {
          passwordParam = '';
        }
      }
    }

    // Actualizar registro del empleado
    // Para la contraseña se utiliza COALESCE(NULLIF(?, ''), password) para conservar la existente si el campo viene vacío.
    await pool.execute(
      `UPDATE empleados
       SET nombre = ?, correo = ?, puesto_id = ?, departamento_id = ?, sucursal_id = ?, username = ?, password = COALESCE(NULLIF(?, ''), password), login_enabled = ?
       WHERE id = ?`,
      [
        nombre,
        correo || null,
        puestoIdNum,
        deptoId || null,
        sucId,
        enablingLogin ? finalUsername : null,
        passwordParam,
        enablingLogin ? 1 : 0,
        id
      ]
    );
    // Responder JSON cuando se edita inline (fetch/AJAX) para evitar recargar la página.
    if (wantsJson) {
      // Regresar datos mínimos para refrescar la fila.
      const [info] = await pool.execute(
        `SELECT e.id,
                e.nombre,
                e.incidencia_id,
                e.correo,
                e.username,
                e.login_enabled,
                e.sucursal_id,
                d.nombre AS departamento_nombre,
                p.nombre AS puesto_nombre,
                pj.nombre AS jefe_nombre
         FROM empleados e
         LEFT JOIN departamentos d ON e.departamento_id = d.id
         LEFT JOIN puestos p ON e.puesto_id = p.id
         LEFT JOIN puestos pj ON p.responde_a_id = pj.id
         WHERE e.id = ?
         LIMIT 1`,
        [id]
      );
      return res.json({ ok: true, employee: info[0] || null, generatedCreds });
    }

    req.flash('success', 'Datos del empleado actualizados');
    return res.redirect('/personal');
  } catch (err) {
    console.error('Error al actualizar empleado:', err);
    if (wantsJson) {
      return res.status(500).json({ ok: false, error: 'No se pudo actualizar al empleado' });
    }
    req.flash('error', 'No se pudo actualizar al empleado');
    return res.redirect('/personal');
  }
});

/*
 * Ruta POST /personal/import
 * Ejecuta la importación de personal desde la base de datos de
 * incidencias.  Se conecta al pool remoto definido en db.js,
 * recupera los registros y los inserta o actualiza en la tabla de
 * empleados.  Si el puesto no existe en nuestra base, asigna el
 * primer puesto disponible por id.  Si el departamento en la
 * base de incidencias corresponde a una sucursal, se asigna
 * automáticamente al departamento OPERACIONES y se relaciona con
 * dicha sucursal.
 */
router.post('/import', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    // Consulta a la base de incidencias.  Ajustar el nombre de la tabla y columnas según sea necesario.
    const [remotos] = await incidenciasPool.execute(
      `SELECT employee_number AS codigo,
              full_name AS nombre,
              puesto AS puesto,
              department_name AS departamento
       FROM personal`
    );
    let importados = 0;
    for (const emp of remotos) {
      const codigo = emp.codigo;
      const nombre = emp.nombre;
      const puestoNombre = emp.puesto;
      const departamentoOrigen = emp.departamento;
      const depOrigenUpper = normUpper(departamentoOrigen);
      // Buscar si el empleado ya existe
      const [existRows] = await pool.execute('SELECT id FROM empleados WHERE incidencia_id = ?', [codigo]);
      // Determinar el puesto local correspondiente
      let [puestoRows] = await pool.execute(
        'SELECT id, departamento_id FROM puestos WHERE nombre = ? ORDER BY id LIMIT 1',
        [puestoNombre]
      );
      let puestoId = null;
      let departamentoId = null;
      if (puestoRows.length > 0) {
        // Encontramos el puesto exacto
        puestoId = puestoRows[0].id;
        departamentoId = puestoRows[0].departamento_id;
      } else {
        // Si no se encuentra el puesto, intentar usar el puesto "OTRO" como comodín
        const [otroPuestoRows] = await pool.execute(
          'SELECT id, departamento_id FROM puestos WHERE nombre = "OTRO" ORDER BY id LIMIT 1'
        );
        if (otroPuestoRows.length > 0) {
          puestoId = otroPuestoRows[0].id;
          departamentoId = otroPuestoRows[0].departamento_id;
        } else {
          // En última instancia, asignar el primer puesto existente
          const [anyPuesto] = await pool.execute('SELECT id, departamento_id FROM puestos ORDER BY id LIMIT 1');
          puestoId = anyPuesto[0].id;
          departamentoId = anyPuesto[0].departamento_id;
        }
      }
      // Si viene de BAJA, forzar departamento BAJA (sin sucursal) y deshabilitar login.
      // En incidencias a veces viene como "Baja", "Baja " o "Área Baja"; detectamos por inclusión.
      const esBaja = depOrigenUpper.includes('BAJA');
      let sucursalId = null;
      if (esBaja) {
        const bajaId = await ensureDepartamentoIdByNombreUpper('BAJA');
        if (bajaId) departamentoId = bajaId;
      } else {
        // Verificar si el departamento origen corresponde a una sucursal
        let [sucRows] = await pool.execute('SELECT id FROM sucursales WHERE nombre = ?', [departamentoOrigen]);
        if (sucRows.length > 0) {
          sucursalId = sucRows[0].id;
          // Forzar departamento OPERACIONES para sucursales
          const [depOps] = await pool.execute('SELECT id FROM departamentos WHERE nombre = "OPERACIONES"');
          if (depOps.length > 0) {
            departamentoId = depOps[0].id;
          }
        }
      }
      if (existRows.length > 0) {
        // Actualizar nombre, puesto y departamento existentes
        if (esBaja) {
          await pool.execute(
            `UPDATE empleados
             SET nombre = ?, puesto_id = ?, departamento_id = ?, sucursal_id = NULL, login_enabled = 0
             WHERE incidencia_id = ?`,
            [nombre, puestoId, departamentoId, codigo]
          );
        } else {
          await pool.execute(
            `UPDATE empleados SET nombre = ?, puesto_id = ?, departamento_id = ?, sucursal_id = ? WHERE incidencia_id = ?`,
            [nombre, puestoId, departamentoId, sucursalId, codigo]
          );
        }
      } else {
        // Insertar nuevo empleado
        await pool.execute(
          `INSERT INTO empleados (incidencia_id, nombre, puesto_id, departamento_id, sucursal_id, login_enabled)
           VALUES (?, ?, ?, ?, ?, 0)`,
          [codigo, nombre, puestoId, departamentoId, sucursalId]
        );
      }
      importados++;
    }
    req.flash('success', `Se importaron/actualizaron ${importados} empleados`);
    return res.redirect('/personal');
  } catch (err) {
    console.error('Error al importar desde incidencias:', err);
    req.flash('error', 'No fue posible importar desde la base de incidencias');
    return res.redirect('/personal');
  }
});

/*
 * Ruta POST /personal/import-nuevos
 * Importa únicamente empleados que no existan en nuestra base.  Compara
 * por incidencia_id (employee_number) y crea registros nuevos con el
 * nombre y puesto extraídos de la base de incidencias.  Si el puesto
 * no existe en nuestra tabla, se asigna el primer puesto por id.  Si
 * el departamento remoto coincide con una sucursal conocida, se asigna
 * el departamento OPERACIONES y se relaciona con la sucursal.
 */
router.post('/import-nuevos', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    const [remotos] = await incidenciasPool.execute(
      `SELECT employee_number AS codigo,
              full_name AS nombre,
              puesto AS puesto,
              department_name AS departamento,
              email AS correo
       FROM personal`
    );
    let nuevos = 0;
    for (const emp of remotos) {
      const codigo = emp.codigo;
      const nombre = emp.nombre;
      const puestoNombre = emp.puesto;
      const departamentoOrigen = emp.departamento;
      const correo = emp.correo;
      const depOrigenUpper = normUpper(departamentoOrigen);
      // Verificar si ya existe
      const [existRows] = await pool.execute('SELECT id FROM empleados WHERE incidencia_id = ?', [codigo]);
      if (existRows.length > 0) {
        continue; // no insertar si existe
      }
      // Determinar puesto y departamento locales
      let [puestoRows] = await pool.execute(
        'SELECT id, departamento_id FROM puestos WHERE nombre = ? ORDER BY id LIMIT 1',
        [puestoNombre]
      );
      let puestoId = null;
      let departamentoId = null;
      if (puestoRows.length > 0) {
        puestoId = puestoRows[0].id;
        departamentoId = puestoRows[0].departamento_id;
      } else {
        // Intentar usar el puesto "OTRO" como comodín para posiciones desconocidas
        const [otroPuestoRows] = await pool.execute(
          'SELECT id, departamento_id FROM puestos WHERE nombre = "OTRO" ORDER BY id LIMIT 1'
        );
        if (otroPuestoRows.length > 0) {
          puestoId = otroPuestoRows[0].id;
          departamentoId = otroPuestoRows[0].departamento_id;
        } else {
          const [anyPuesto] = await pool.execute('SELECT id, departamento_id FROM puestos ORDER BY id LIMIT 1');
          puestoId = anyPuesto[0].id;
          departamentoId = anyPuesto[0].departamento_id;
        }
      }
      // Si viene de BAJA, forzar departamento BAJA (sin sucursal)
      const esBaja = depOrigenUpper.includes('BAJA');
      let sucursalId = null;
      if (esBaja) {
        const bajaId = await ensureDepartamentoIdByNombreUpper('BAJA');
        if (bajaId) departamentoId = bajaId;
      } else {
        // Determinar si el departamento origen corresponde a sucursal
        let [sucRows] = await pool.execute('SELECT id FROM sucursales WHERE nombre = ?', [departamentoOrigen]);
        if (sucRows.length > 0) {
          sucursalId = sucRows[0].id;
          // Forzar departamento OPERACIONES si existe
          const [depOps] = await pool.execute('SELECT id FROM departamentos WHERE nombre = "OPERACIONES"');
          if (depOps.length > 0) {
            departamentoId = depOps[0].id;
          }
        }
      }
      // Insertar nuevo empleado con login deshabilitado
      await pool.execute(
        `INSERT INTO empleados (incidencia_id, nombre, correo, puesto_id, departamento_id, sucursal_id, login_enabled)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [codigo, nombre, correo || null, puestoId, departamentoId, esBaja ? null : sucursalId]
      );
      nuevos++;
    }
    req.flash('success', `Se importaron ${nuevos} nuevos empleados`);
    return res.redirect('/personal');
  } catch (err) {
    console.error('Error al importar nuevos desde incidencias:', err);
    req.flash('error', 'No fue posible importar nuevos empleados');
    return res.redirect('/personal');
  }
});

/*
 * Ruta POST /personal/import-puestos
 * Sincroniza desde incidencias:
 *  - Correo: siempre se actualiza para empleados existentes.
 *  - Puesto/Departamento/Sucursal: SOLO se actualiza si el nombre del puesto
 *    remoto es diferente al puesto actual del empleado (por nombre).
 *    Esto evita re-asignar departamento cuando existen puestos duplicados por nombre
 *    y el usuario cambió manualmente el departamento en KPIs.
 */
router.post('/import-puestos', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    const [remotos] = await incidenciasPool.execute(
      `SELECT employee_number AS codigo,
              puesto AS puesto,
              department_name AS departamento,
              email AS correo
       FROM personal`
    );
    let correosActualizados = 0;
    let puestosActualizados = 0;
    let sucursalesActualizadas = 0;
    for (const emp of remotos) {
      const codigo = emp.codigo;
      const puestoNombre = emp.puesto;
      const departamentoOrigen = emp.departamento;
      const correo = emp.correo;
      const depOrigenUpper = normUpper(departamentoOrigen);
      // Buscar empleado existente + su puesto actual (por nombre)
      const [existRows] = await pool.execute(
        `SELECT e.id, e.puesto_id, e.departamento_id, e.sucursal_id, e.correo,
                p.nombre AS puesto_actual_nombre
         FROM empleados e
         LEFT JOIN puestos p ON e.puesto_id = p.id
         WHERE e.incidencia_id = ?
         LIMIT 1`,
        [codigo]
      );
      if (existRows.length === 0) {
        continue; // no actualizar si no existe
      }

      const actual = existRows[0];
      const puestoActualUpper = normUpper(actual.puesto_actual_nombre);
      const puestoRemotoUpper = normUpper(puestoNombre);
      const esBaja = depOrigenUpper.includes('BAJA');

      // ¿En incidencias el "department_name" es una sucursal?
      // (Si es sucursal, se debe mantener sincronizado sucursal_id incluso cuando el puesto sea el mismo.)
      let remoteSucursalId = null;
      let remoteIsSucursal = false;
      if (!esBaja && departamentoOrigen) {
        const [sucRowsRemote] = await pool.execute('SELECT id FROM sucursales WHERE nombre = ?', [departamentoOrigen]);
        if (sucRowsRemote.length > 0) {
          remoteIsSucursal = true;
          remoteSucursalId = sucRowsRemote[0].id;
        }
      }

      // 1) Siempre actualizar correo (si viene con valor)
      if (correo !== undefined && correo !== null && String(correo).trim() !== '') {
        const [rEmail] = await pool.execute(
          `UPDATE empleados SET correo = ? WHERE incidencia_id = ?`,
          [String(correo).trim(), codigo]
        );
        if (rEmail && typeof rEmail.affectedRows === 'number' && rEmail.affectedRows > 0) {
          correosActualizados++;
        }
      }

      // 2) Si viene como BAJA, mover a BAJA y deshabilitar login (sin tocar puesto)
      if (esBaja) {
        const bajaId = await ensureDepartamentoIdByNombreUpper('BAJA');
        if (bajaId) {
          await pool.execute(
            `UPDATE empleados
             SET departamento_id = ?, sucursal_id = NULL, login_enabled = 0
             WHERE incidencia_id = ?`,
            [bajaId, codigo]
          );
        }
        continue;
      }

      // 3) Si el puesto (por nombre) es el mismo, NO tocar puesto/departamento.
      //    EXCEPCIÓN: si en incidencias viene como Sucursal, sí sincronizamos sucursal_id.
      //    (Evita re-asignaciones de departamento por duplicados de nombre, sin perder cambios de sucursal.)
      if (puestoActualUpper && puestoRemotoUpper && puestoActualUpper === puestoRemotoUpper) {
        if (remoteIsSucursal && remoteSucursalId && String(actual.sucursal_id || '') !== String(remoteSucursalId)) {
          await pool.execute(
            'UPDATE empleados SET sucursal_id = ? WHERE incidencia_id = ?',
            [remoteSucursalId, codigo]
          );
          sucursalesActualizadas++;
        }
        continue;
      }

      // Determinar puesto y departamento locales
      let [puestoRows] = await pool.execute(
        'SELECT id, departamento_id FROM puestos WHERE nombre = ? ORDER BY id LIMIT 1',
        [puestoNombre]
      );
      let puestoId = null;
      let departamentoId = null;
      if (puestoRows.length > 0) {
        puestoId = puestoRows[0].id;
        departamentoId = puestoRows[0].departamento_id;
      } else {
        // Si el puesto no existe, utilizar el puesto "OTRO" como comodín
        const [otroPuestoRows] = await pool.execute(
          'SELECT id, departamento_id FROM puestos WHERE nombre = "OTRO" ORDER BY id LIMIT 1'
        );
        if (otroPuestoRows.length > 0) {
          puestoId = otroPuestoRows[0].id;
          departamentoId = otroPuestoRows[0].departamento_id;
        } else {
          const [anyPuesto] = await pool.execute('SELECT id, departamento_id FROM puestos ORDER BY id LIMIT 1');
          puestoId = anyPuesto[0].id;
          departamentoId = anyPuesto[0].departamento_id;
        }
      }
      let sucursalId = remoteIsSucursal ? remoteSucursalId : null;

      // Si es sucursal, forzar departamento OPERACIONES (cuando sí se está actualizando el puesto)
      if (remoteIsSucursal) {
        const [depOps] = await pool.execute('SELECT id FROM departamentos WHERE nombre = "OPERACIONES"');
        if (depOps.length > 0) {
          departamentoId = depOps[0].id;
        }
      }

      await pool.execute(
        `UPDATE empleados
         SET puesto_id = ?, departamento_id = ?, sucursal_id = ?
         WHERE incidencia_id = ?`,
        [puestoId, departamentoId, sucursalId, codigo]
      );
      puestosActualizados++;
    }
    req.flash('success', `Correos actualizados: ${correosActualizados}. Puestos/dep actualizados: ${puestosActualizados}. Sucursales (puesto igual) actualizadas: ${sucursalesActualizadas}.`);
    return res.redirect('/personal');
  } catch (err) {
    console.error('Error al actualizar puestos desde incidencias:', err);
    req.flash('error', 'No fue posible actualizar puesto/correo desde incidencias');
    return res.redirect('/personal');
  }
});

/*
 * Ruta POST /personal/import-bajas
 * Sincroniza únicamente el estatus de BAJA desde incidencias.
 * Si en la fuente el department_name contiene "BAJA" (ej. "Baja", "Área Baja"),
 * el empleado se mueve al departamento BAJA, se limpia sucursal y se deshabilita login.
 * No modifica puesto ni nombre.
 */
router.post('/import-bajas', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    const bajaId = await ensureDepartamentoIdByNombreUpper('BAJA');
    if (!bajaId) {
      req.flash('error', 'No fue posible asegurar el departamento BAJA');
      return res.redirect('/personal');
    }

    const [remotos] = await incidenciasPool.execute(
      `SELECT employee_number AS codigo, department_name AS departamento FROM personal`
    );

    // Filtrar solo los que vienen en BAJA (tolerante a variaciones de texto)
    const bajas = remotos
      .filter(r => normUpper(r.departamento).includes('BAJA'))
      .map(r => r.codigo)
      .filter(v => v !== null && v !== undefined);

    if (bajas.length === 0) {
      req.flash('success', 'No se detectaron empleados en BAJA en incidencias');
      return res.redirect('/personal');
    }

    // Actualizar en lotes para evitar queries enormes
    const chunkSize = 500;
    let actualizados = 0;
    for (let i = 0; i < bajas.length; i += chunkSize) {
      const chunk = bajas.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const [result] = await pool.execute(
        `UPDATE empleados
         SET departamento_id = ?, sucursal_id = NULL, login_enabled = 0
         WHERE incidencia_id IN (${placeholders})`,
        [bajaId, ...chunk]
      );
      // result.affectedRows cuenta cuántos cambiaron realmente
      actualizados += (result && typeof result.affectedRows === 'number') ? result.affectedRows : 0;
    }

    req.flash('success', `Se actualizaron ${actualizados} empleados a BAJA`);
    return res.redirect('/personal?showBajas=1');
  } catch (err) {
    console.error('Error al actualizar BAJAS desde incidencias:', err);
    req.flash('error', 'No fue posible actualizar BAJAS');
    return res.redirect('/personal');
  }
});

/**
 * Respaldo completo de la base de datos (SQL).
 * GET /personal/db-backup
 *
 * Nota: se genera un dump en formato .sql (estructura + datos) sin depender
 * de binarios externos como mysqldump, para que funcione igual en Railway.
 */
router.get('/db-backup', isAuth, requireRole(['admin']), async (req, res) => {
  try {
    const ts = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}-${pad2(ts.getMonth() + 1)}-${pad2(ts.getDate())}_${pad2(ts.getHours())}${pad2(ts.getMinutes())}${pad2(ts.getSeconds())}`;
    const filename = `kpi_backup_${stamp}.sql`;

    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const write = (s) => res.write(s);
    write(`-- CHC KPI Manager - Respaldo completo\n`);
    write(`-- Generado: ${ts.toISOString()}\n\n`);
    write(`SET NAMES utf8mb4;\n`);
    write(`SET FOREIGN_KEY_CHECKS=0;\n\n`);

    const [tablesRows] = await pool.query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
    if (!tablesRows || tablesRows.length === 0) {
      write(`-- No se encontraron tablas para respaldar.\n`);
      write(`SET FOREIGN_KEY_CHECKS=1;\n`);
      return res.end();
    }

    const tableNameCol = Object.keys(tablesRows[0]).find(k => k.toLowerCase().startsWith('tables_in'));
    const tables = tablesRows.map(r => r[tableNameCol]).filter(Boolean);

    const CHUNK = 500;
    for (const table of tables) {
      // Estructura
      const [createRows] = await pool.query(`SHOW CREATE TABLE \`${table}\``);
      const createSql = createRows && createRows[0] ? (createRows[0]['Create Table'] || createRows[0]['Create View']) : null;
      write(`\n-- ----------------------------\n`);
      write(`-- Tabla: ${table}\n`);
      write(`-- ----------------------------\n`);
      write(`DROP TABLE IF EXISTS \`${table}\`;\n`);
      if (createSql) {
        write(`${createSql};\n`);
      }

      // Datos
      const [countRows] = await pool.query(`SELECT COUNT(*) AS c FROM \`${table}\``);
      const total = countRows && countRows[0] ? Number(countRows[0].c || 0) : 0;
      if (!total) continue;

      let offset = 0;
      while (offset < total) {
        const [rows] = await pool.query(`SELECT * FROM \`${table}\` LIMIT ${CHUNK} OFFSET ${offset}`);
        if (!rows || rows.length === 0) break;

        const cols = Object.keys(rows[0]);
        const colList = cols.map(c => `\`${c}\``).join(',');
        const valuesSql = rows.map(r => {
          const vals = cols.map(c => {
            const v = r[c];
            return v === null || v === undefined ? 'NULL' : sqlEscape(v);
          }).join(',');
          return `(${vals})`;
        }).join(',\n');

        write(`INSERT INTO \`${table}\` (${colList}) VALUES\n${valuesSql};\n`);
        offset += rows.length;
      }
    }

    write(`\nSET FOREIGN_KEY_CHECKS=1;\n`);
    return res.end();
  } catch (err) {
    console.error('Error generando respaldo SQL:', err);
    // Si ya se empezaron a mandar headers/bytes, solo cerrar.
    try {
      if (!res.headersSent) {
        res.status(500).send('No se pudo generar el respaldo');
      } else {
        res.end();
      }
    } catch {
      // ignore
    }
  }
});

module.exports = router;