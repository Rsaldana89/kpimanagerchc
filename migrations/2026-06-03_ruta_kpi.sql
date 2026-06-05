-- Migración para ampliar la tabla empleado_supervision_ruta con nuevos campos
-- relacionados con la asignación manual de rutas KPI.
--
-- Este script se puede ejecutar manualmente en la base de datos MySQL de
-- producción.  Utiliza la sintaxis IF NOT EXISTS para evitar errores
-- cuando las columnas o claves ya estén presentes.  Si su versión de
-- MySQL no soporta IF NOT EXISTS en ADD COLUMN o ADD KEY, será
-- necesario verificar manualmente antes de aplicar los cambios.

ALTER TABLE empleado_supervision_ruta
  ADD COLUMN IF NOT EXISTS rol_en_ruta ENUM('supervisor','colaborador') NOT NULL DEFAULT 'colaborador' AFTER ruta_id,
  ADD COLUMN IF NOT EXISTS hereda_kpis TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS hereda_calificacion_supervisor TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS asignado_por INT NULL,
  ADD COLUMN IF NOT EXISTS asignado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  MODIFY COLUMN activo TINYINT(1) NOT NULL DEFAULT 1,
  ADD KEY IF NOT EXISTS idx_esr_rol (rol_en_ruta);