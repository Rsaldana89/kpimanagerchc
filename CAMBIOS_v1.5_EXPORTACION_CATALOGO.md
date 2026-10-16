# Nueva función: exportación Excel del catálogo de KPIs

## Qué cambia

- En `/kpis`, arriba de la lista **KPIs existentes**, aparece **Exportar catálogo a Excel** solo para usuarios `admin`.
- La descarga se genera desde `GET /kpis/export-excel`. La ruta exige sesión activa y rol `admin`: los demás usuarios no pueden acceder mediante URL directa.
- Exporta desde la base de datos actual, no desde un CSV cargado manualmente. Respeta el departamento y la búsqueda aplicados en pantalla. Sin filtros exporta **todos** los KPIs existentes, incluso los agregados posteriormente.
- El archivo `.xlsx` utiliza ExcelJS, ya incluido en el proyecto: no hace falta instalar librerías adicionales ni hacer cambios de base de datos.
- Formato semejante al resumen histórico (tabla Excel con filtros y filas alternadas), encabezado corporativo vino, textos con acentos, columna de semáforo por color, anchos de columnas, ajuste de texto e inmovilización de encabezados.

## Hojas del archivo

1. **Catálogo de KPIs**: columnas legibles, objetivos, departamentos, tipo y sentido de calificación, rangos/criterios semáforo y umbrales.
2. **Configuración vigente**: datos generales y parámetros actuales de `kpis`, incluido el nombre de departamento, sin los rangos ni textos antiguos.

**Criterios actuales**: el sistema calcula las calificaciones a partir de `threshold_yellow` / `threshold_green` o de `criterion_red` / `criterion_yellow` / `criterion_green`. Los nueve campos de rangos/textos anteriores no se incluyen en ninguna hoja. Cuando faltan umbrales/criterios, se indica expresamente que falta configuración. Este Excel es un catálogo de configuración, no el resultado de un periodo mensual.

La exportación es de solo lectura; no modifica los KPIs ni sus calificaciones. Registra la descarga en `logkpimanager` cuando esté disponible. Las demás rutas, aprobaciones e históricos no fueron modificados.

## Comprobación

- Iniciar el proyecto de la manera habitual.
- Como administrador, entrar a `KPIs`, dejar `Todos` y buscar en blanco, presionar `Exportar catálogo a Excel`.
- Abrir el archivo en Excel; confirmar que tenga dos hojas, acentos, filtros y la cantidad esperada de KPIs. Seleccionar un departamento o buscar y repetir.
- Entrar como `manager`: el botón no debe aparecer y la URL `/kpis/export-excel` debe rechazar la solicitud por permisos.

## Ajuste solicitado (16 de octubre de 2026)

- Eliminada la línea explicativa bajo el encabezado de las dos hojas; la tabla comienza en la fila 5.
- Eliminadas de ambas hojas las columnas `rojo_min`, `rojo_max`, `amarillo_min`, `amarillo_max`, `verde_min`, `verde_max`, `rojo_txt`, `amarillo_txt`, `verde_txt`.
- Sin recuperación de rangos/textos históricos en los semáforos cuando faltan parámetros actuales: se indica que falta configuración.
- Conservar la tabla original, las aprobaciones, reportes, permisos de descarga y datos de MySQL sin cambios.
