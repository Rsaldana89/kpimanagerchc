# KPI Manager CHC v1.5 - Modulo de Historicos

## Objetivo
Se agrego un modulo independiente de historicos para conservar una fotografia inmutable de la evaluacion final de cada periodo. El historico no reconstruye periodos pasados con catalogos actuales.

## Tablas nuevas
La migracion `migrations/2026-09-30_historicos.sql` crea solamente tablas nuevas:

- `kpi_historico_periodos`: cabecera, origen, version y estado actual/superado.
- `kpi_historico_detalle`: una fila por KPI historico, con empleado/puesto/departamento/sucursal/KPI/objetivo/peso/resultado/estado congelados como datos historicos.
- `kpi_historico_feedback`: fortalezas, areas de oportunidad y compromisos por colaborador.
- `kpi_historico_importaciones`: trazabilidad de importaciones realizadas.

No se agregaron `DROP TABLE` ni cambios estructurales a tablas operativas.

## Archivos nuevos
- `routes/historicos.js`
- `services/historicosService.js`
- `services/historicosExcel.js`
- `views/admin_historicos.ejs`
- `migrations/2026-09-30_historicos.sql`
- `CAMBIOS_v1.5_HISTORICOS.md`

## Archivos existentes modificados
- `server.js`: registra las rutas del modulo.
- `views/partials/header.ejs`: agrega menu Históricos solo para admin y actualiza version visual a v1.5.
- `services/periodLocks.js`: integra el historico final al cierre y la supersesion a la reapertura mediante transacciones.
- `routes/mass_email.js`: muestra resultado del historico generado y registra auditoria.
- `package.json` / `package-lock.json`: version 1.5.0. No se agregaron dependencias.

## Integracion con el cierre oficial
`POST /admin/mass-email/close-period` sigue siendo el disparador.

1. Si no existe `kpi_periodo_empleados`, se usa el mecanismo existente `ensurePeriodSnapshot` para asegurarlo.
2. Se abre una transaccion MySQL.
3. Se construye el historico completo usando la base congelada del periodo.
4. Se insertan cabecera, detalle y retroalimentacion.
5. Se actualiza `kpi_periodo_cierres` como cerrado.
6. Se hace `COMMIT`.
7. Si algo falla, se hace `ROLLBACK` y el periodo no queda cerrado.

El cron de fin de mes no genera el historico final.

## Reapertura y versionado
Al reabrir un periodo:

- no se borra ningun historico;
- la version actual se marca `es_actual = 0`;
- se registra `superseded_reason = 'PERIODO_REABIERTO'`;
- al cerrar nuevamente se genera la siguiente version.

Las importaciones de un periodo existente requieren accion explicita de nueva version. Un SHA-256 ya importado para el mismo periodo se bloquea.

## Importacion Excel
Solo admin. Formato aceptado: `.xlsx`, maximo 15 MB y hasta 50,000 filas.

Flujo:

1. Seleccionar archivo.
2. `Analizar archivo`: el navegador envia el archivo al servidor sin guardar historicos.
3. Se muestra periodo, colaboradores, filas KPI, resultados capturados, estados, feedback, errores y advertencias.
4. `Importar historico`: se vuelve a enviar el mismo File.
5. El servidor repite todas las validaciones y, si son correctas, importa en una transaccion.

Validaciones implementadas incluyen: hoja Equipo, columnas obligatorias, periodo unico, duplicados empleado+KPI+periodo, workbook valido, contradicciones reales de feedback, pesos, estados/semaforos desconocidos y comparacion no bloqueante contra catalogos actuales.

Los valores importados de semaforo, puntaje, peso, ponderado y estado NO se recalculan. `Resultado` se conserva como texto, incluyendo valores como `Junio`.

## Sucursales virtuales
El snapshot automatico conserva la regla productiva de `SUPERVISION 1..6`: el puesto mostrado historicamente es el puesto real del empleado, pero la asignacion de KPI usa puesto efectivo 46 cuando aplica, igual que la exportacion actual.

## Consulta
Ruta principal: `/admin/historicos`.

- lista periodos y versiones;
- filtra por año/mes;
- consulta una fila por empleado;
- filtros por nombre/No. empleado, puesto, departamento y sucursal;
- detalle de KPI y retroalimentacion en solo lectura;
- versiones anteriores siguen consultables.

## Exportacion
`Exportar Excel` reconstruye `Equipo`, `Retroalimentación` y `Resumen` exclusivamente desde `kpi_historico_*`; no consulta tablas vivas para reinterpretar el periodo.

## Migracion en MySQL
Ejecutar una sola vez, antes de desplegar v1.5:

```bash
mysql -h <host> -P <puerto> -u <usuario> -p <base> < migrations/2026-09-30_historicos.sql
```

En Railway tambien puede copiarse el contenido de la migracion y ejecutarse contra la base productiva desde una consola SQL autorizada. Hacer respaldo/snapshot de la base antes, como practica operacional.

## Pruebas realizadas
### Excel reales
Conteos leidos de los archivos entregados:

| Periodo | Colaboradores | Filas Equipo |
|---|---:|---:|
| Enero 2026 | 708 | 2,919 |
| Febrero 2026 | 708 | 2,919 |
| Marzo 2026 | 708 | 2,919 |
| Abril 2026 | 681 | 2,799 |
| Mayo 2026 | 731 | 2,991 |
| Junio 2026 | 714 | 2,918 |
| Julio 2026 | 736 | 3,014 |
| Agosto 2026 | 760 | 3,108 |

Se verifico que existen resultados numericos y de texto, estados ABIERTO/APROBADO y, en varios periodos, EN REVISION.

### Codigo
Se ejecuto `node --check` sobre todos los archivos `.js` del proyecto sin errores de sintaxis.

### Limitacion de entorno
No se ejecuto una prueba de integracion contra la base MySQL productiva ni se aplico la migracion real desde este entorno. Antes de produccion debe hacerse QA en una copia/pruebas de la base para comprobar cierre, rollback inducido, reapertura y cierre v2.

## QA recomendado antes de produccion
1. Ejecutar migracion en base de pruebas.
2. Importar Enero: debe detectar 708 colaboradores y 2,919 filas.
3. Reexportar Enero y comparar contenido sustancial.
4. Intentar importar exactamente el mismo archivo: debe bloquear por SHA-256.
5. Importar una correccion como nueva version: v1 queda superada y v2 actual.
6. Cerrar un periodo de prueba: cierre e historico deben confirmarse juntos.
7. Provocar un error de snapshot/historico: el periodo debe permanecer abierto.
8. Reabrir: version actual queda almacenada pero superada.
9. Cerrar otra vez: crea version siguiente.
10. Cambiar luego puesto/sucursal/KPI/objetivo/peso en operacion y verificar que el historico no cambia.

## Confirmacion de seguridad estructural
No se sobrescribio ni rediseño ninguna tabla operativa existente. El modulo escribe los historicos exclusivamente en tablas nuevas `kpi_historico_*`; el unico cambio sobre la operacion normal es la coordinacion transaccional del cierre/reapertura ya existentes.

## Ajuste de interfaz - detalle histórico flotante

- El botón **Ver detalle** ya no recarga la página ni coloca el detalle debajo de toda la tabla de colaboradores.
- El detalle se consulta bajo demanda mediante una ruta admin de solo lectura y se presenta en un **modal flotante** de Bootstrap.
- El modal es amplio, tiene scroll propio y mantiene visible el encabezado de la tabla de KPI al desplazarse.
- Al cerrarlo, el administrador permanece exactamente en la misma posición de la lista y conserva los filtros aplicados.
- No se modificó ninguna tabla ni la lógica de generación/importación de históricos para este ajuste.
