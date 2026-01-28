const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const isAuth = require('../middleware/isAuth');

/*
 * Construye un árbol de puestos basado en la relación responde_a.
 * Recibe una lista de objetos {id, nombre, responde_a_id}.  Devuelve
 * un array de nodos raíz, cada uno con su lista de hijos.  Esta
 * función es puramente de utilidad para estructurar los datos
 * necesarias en la vista de organigrama.
 */
function buildPositionTree(positions) {
  // Crear un mapa de puestos por id. Incluye nombre y departamento
  const posMap = new Map();
  positions.forEach(p => {
    posMap.set(p.id, {
      id: p.id,
      nombre: p.nombre,
      departamento: p.departamento_nombre || null,
      children: []
    });
  });
  let roots = [];
  positions.forEach(p => {
    const node = posMap.get(p.id);
    if (p.responde_a_id && posMap.has(p.responde_a_id)) {
      posMap.get(p.responde_a_id).children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

// Genera un color HSL estable (pastel) basado en un string (departamento)
function deptToColor(deptName) {
  const s = String(deptName || 'SIN_DEPARTAMENTO').toUpperCase();
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  // Pastel legible.
  // Nota: usamos la sintaxis con comas para máxima compatibilidad.
  return `hsl(${hue}, 55%, 55%)`;
}

// Genera HTML de lista para el organigrama a partir de un árbol de posiciones
function buildOrgHtml(nodes, depth = 0) {
  let html = '';
  nodes.forEach(node => {
    const hasChildren = node.children && node.children.length;
    const deptColor = deptToColor(node.departamento);
    const deptSafe = (node.departamento || '').replace(/"/g, '&quot;');
    html += `<li class="org-node" data-node-id="${node.id}" data-depth="${depth}" data-dept="${deptSafe}" data-has-children="${hasChildren ? 1 : 0}" data-children-count="${hasChildren ? node.children.length : 0}">`;
    // Tarjeta de puesto
    html += `<div class="org-card" style="--dept-color:${deptColor};">`;
    if (hasChildren) {
      html += `<button type="button" class="org-toggle" title="Colapsar/expandir">−</button>`;
    }
    html += '<strong>' + node.nombre + '</strong>';
    if (node.departamento) {
      html += '<div class="org-meta">' + node.departamento + '</div>';
    }
    html += '</div>';
    // Hijos
    if (node.children && node.children.length) {
      html += '<ul>' + buildOrgHtml(node.children, depth + 1) + '</ul>';
    }
    html += '</li>';
  });
  return html;
}

/*
 * GET /organigrama
 * Construye y muestra el organigrama de la compañía.  Se utiliza la
 * tabla puestos para crear el árbol.  Por simplicidad se muestra
 * solo el nombre de los puestos.
 */
router.get('/', isAuth, async (req, res) => {
  try {
    // Cargar puestos junto con su departamento y la columna responde_a
    const [puestos] = await pool.execute(
      'SELECT p.id, p.nombre, p.responde_a_id, d.nombre AS departamento_nombre FROM puestos p JOIN departamentos d ON p.departamento_id = d.id'
    );
    const tree = buildPositionTree(puestos);
    // Generar HTML del organigrama para evitar problemas de include
    const treeHtml = '<ul class="org-list">' + buildOrgHtml(tree) + '</ul>';
    res.render('organigrama', {
      title: 'Organigrama',
      treeHtml
    });
  } catch (err) {
    console.error('Error al cargar organigrama:', err);
    req.flash('error', 'No se pudo generar el organigrama');
    return res.redirect('/dashboard');
  }
});

module.exports = router;