# KPI Manager CHC v1.4 — Jerarquía tolerante a puestos vacantes

## Objetivo

Evitar que la cadena jerárquica desaparezca cuando un puesto intermedio no tiene personal asignado.

Ejemplo soportado:

- Gerente de Planta
  - Supervisor de Tortillas (vacante)
    - Auxiliares de Producción de Tortillas

El Gerente de Planta puede desplegar el puesto vacante y continuar hasta los auxiliares sin cambiar temporalmente el organigrama.

## Cambios realizados

- El árbol de KPIs ahora se construye por puestos y conserva los puestos intermedios vacantes.
- Los puestos vacantes se muestran con un indicador amarillo **Puesto vacante / Sin personal asignado**.
- Se agregó carga bajo demanda para continuar el árbol desde un puesto sin empleado.
- Se agregó la ruta `GET /dashboard/subtree/puesto/:puestoId`.
- El jefe superior puede capturar y aprobar KPIs de subordinados cuando todos los puestos intermedios están vacantes.
- Si existe una persona activa en un puesto intermedio, el sistema no permite saltarse a ese jefe.
- Las personas con departamento `BAJA` no cuentan como ocupantes del puesto.
- Se conserva la lógica especial de rutas de supervisión y los filtros por ruta.

## Base de datos

No requiere cambios ni scripts SQL.

## Pruebas recomendadas

1. Gerente → Supervisor ocupado → Auxiliar: el gerente no debe saltarse al supervisor operativo, salvo permisos globales de admin/manager ya existentes.
2. Gerente → Supervisor vacante → Auxiliar: debe aparecer la tarjeta del puesto vacante y permitir desplegar al auxiliar.
3. Dos puestos vacantes consecutivos: debe ser posible desplegar ambos niveles.
4. Al asignar una persona al puesto vacante y recargar, debe desaparecer la tarjeta de vacante y aparecer la tarjeta del empleado.
5. Un empleado en departamento BAJA no debe impedir que el puesto se considere vacante.
6. En rutas de supervisión, la carga debe seguir respetando la ruta KPI resuelta.

## Archivos principales modificados

- `routes/dashboard.js`
- `views/dashboard.ejs`
- `views/partials/sub_kpi_level.ejs`
- `views/partials/sub_puesto_vacante.ejs` (nuevo)
- `public/css/styles.css`
- `views/partials/header.ejs`
- `package.json`
- `package-lock.json`
