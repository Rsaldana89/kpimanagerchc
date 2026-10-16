# CHC KPI Manager 1.5 - Exportación de puestos y KPIs a Excel

## Función
- En la pantalla **Puestos** (`/puestos`) aparece **Exportar puestos a Excel** a la derecha del título, **solo para Admin**.
- Endpoint protegido en servidor: `GET /puestos/export-excel`, con sesión y rol `admin`. Los roles `manager` y `user` no tienen permiso.
- La exportación consulta la base actual cada vez que se hace clic. Es **solo lectura**: no modifica puestos, KPIs, pesos, evaluaciones ni resultados históricos.
- No necesita migraciones ni paquetes nuevos: reutiliza `exceljs` del proyecto.
- Registra auditoría `PUESTOS_EXPORT` en `logkpimanager` (si esta tabla está disponible).

## Archivo generado
`CHC_Puestos_y_KPIs_AAAA-MM-DD.xlsx`, con dos hojas:

1. **Resumen de puestos**: numeración por departamento, ID del puesto, departamento, puesto, superior jerárquico, rol, KPIs asignados, suma de pesos y estado. Se resaltan estados `Completo`, `Sin KPIs` y `Revisar pesos`.
2. **KPIs por puesto**: una fila por asignación (ID/nombre del KPI, objetivo, unidad, periodicidad y peso). Los puestos sin KPI aparecen con una fila de aviso y sin ID/peso de indicador: no se contabilizan como asignaciones reales.

Ambas hojas tienen títulos corporativos, métricas, filtros por columna, encabezados fijos y tablas de Excel ordenadas por departamento y puesto, siguiendo el agrupamiento visual de la pantalla Puestos. Todos los campos con peso se muestran como porcentajes de 0 a 100 sin cambiar sus valores originales.

## Consulta de lectura
Se usan `puestos`, `departamentos`, `puesto_kpis` y `kpis`, con `LEFT JOIN` hacia asignaciones y catálogo de KPIs para preservar puestos sin KPI. Solo se ejecuta **una consulta SQL** por descarga y se construyen las dos hojas a partir del mismo conjunto de resultados.

## Validación con los CSV recibidos (16/10/2026)
- 114 puestos en 17 departamentos.
- 106 puestos con KPIs: todos suman 100 % de peso.
- 8 puestos sin indicadores: quedan visibles y señalados en las dos hojas.
- 397 asignaciones reales correspondientes a 284 KPIs distintos.
- 405 filas en la hoja detalle (397 asignaciones + 8 avisos sin KPI).
- Los 114 totales, relaciones de jefatura, roles y pesos se contrastaron contra el CSV de resumen sin diferencias.
- Pruebas de rol simuladas: Admin descarga; Manager y User no pueden descargar.
- Se generó y verificó una vista previa `.xlsx` desde los CSV exportados.

## Instalación
1. Respaldar la instalación existente y su configuración.
2. Actualizar el código de la aplicación con los archivos del ZIP.
3. Conservar las variables de entorno de la instalación actual (Railway o `.env`).
4. Instalar dependencias si es una instalación nueva (`npm ci`) y reiniciar la aplicación.
5. Iniciar sesión con un usuario Admin, entrar a **Puestos**, pulsar **Exportar puestos a Excel** y verificar las dos hojas.

## Archivos nuevos o cambiados
- `services/puestosExcel.js` (nuevo): transformación de filas y formato de Excel.
- `routes/positions.js`: nueva ruta Admin de exportación y auditoría.
- `views/puestos.ejs`: botón exclusivo para Admin en la cabecera.

No se alteraron las consultas de evaluación, los historiales ni el módulo ya existente de exportación del catálogo de KPIs.

**Alcance de las pruebas**: la estructura del reporte, conciliación de filas y control de roles se comprobaron con datos de los CSV y mocks locales. La conexión a MySQL productivo y la descarga en la instalación real deben verificarse después del despliegue.
