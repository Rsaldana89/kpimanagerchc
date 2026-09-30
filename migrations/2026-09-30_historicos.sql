-- KPI Manager CHC v1.5 - Modulo de Historicos
-- Migracion aditiva: no elimina ni modifica tablas operativas existentes.

CREATE TABLE IF NOT EXISTS kpi_historico_periodos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  anio INT NOT NULL,
  mes TINYINT NOT NULL,
  version INT NOT NULL,
  es_actual TINYINT(1) NOT NULL DEFAULT 1,
  origen VARCHAR(30) NOT NULL,
  snapshot_el DATETIME NULL,
  cerrado_el DATETIME NULL,
  creado_por INT NULL,
  archivo_origen VARCHAR(255) NULL,
  archivo_sha256 CHAR(64) NULL,
  empleados_total INT NOT NULL DEFAULT 0,
  filas_kpi_total INT NOT NULL DEFAULT 0,
  feedback_total INT NOT NULL DEFAULT 0,
  superseded_at DATETIME NULL,
  superseded_reason VARCHAR(100) NULL,
  observaciones TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_historico_periodo_version (anio, mes, version),
  KEY idx_historico_periodo_actual (anio, mes, es_actual),
  KEY idx_historico_sha (anio, mes, archivo_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kpi_historico_detalle (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  historico_periodo_id INT NOT NULL,
  orden INT NOT NULL DEFAULT 0,
  empleado_id_origen INT NULL,
  no_empleado VARCHAR(50) NULL,
  empleado_nombre VARCHAR(255) NULL,
  puesto_id_origen INT NULL,
  puesto_nombre VARCHAR(255) NULL,
  departamento_id_origen INT NULL,
  departamento_nombre VARCHAR(255) NULL,
  sucursal_id_origen INT NULL,
  sucursal_nombre VARCHAR(255) NULL,
  kpi_id_origen INT NULL,
  kpi_nombre VARCHAR(500) NULL,
  objetivo TEXT NULL,
  unidad VARCHAR(255) NULL,
  resultado TEXT NULL,
  semaforo VARCHAR(50) NULL,
  puntaje_base DECIMAL(12,4) NULL,
  peso DECIMAL(12,4) NULL,
  puntaje_ponderado DECIMAL(12,4) NULL,
  estado VARCHAR(50) NULL,
  aprobado_por_nombre VARCHAR(255) NULL,
  fecha_aprobacion DATETIME NULL,
  revision_por_nombre VARCHAR(255) NULL,
  fecha_revision DATETIME NULL,
  motivo_revision TEXT NULL,
  comentario_kpi TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_historico_detalle_periodo
    FOREIGN KEY (historico_periodo_id) REFERENCES kpi_historico_periodos(id)
    ON DELETE CASCADE,
  KEY idx_historico_detalle_periodo (historico_periodo_id),
  KEY idx_historico_detalle_empleado (historico_periodo_id, no_empleado),
  KEY idx_historico_detalle_departamento (historico_periodo_id, departamento_nombre),
  KEY idx_historico_detalle_sucursal (historico_periodo_id, sucursal_nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kpi_historico_feedback (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  historico_periodo_id INT NOT NULL,
  empleado_id_origen INT NULL,
  no_empleado VARCHAR(50) NOT NULL,
  empleado_nombre VARCHAR(255) NULL,
  fortalezas TEXT NULL,
  areas_oportunidad TEXT NULL,
  compromisos TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_historico_feedback_periodo
    FOREIGN KEY (historico_periodo_id) REFERENCES kpi_historico_periodos(id)
    ON DELETE CASCADE,
  UNIQUE KEY uniq_historico_feedback_empleado (historico_periodo_id, no_empleado),
  KEY idx_historico_feedback_empleado (historico_periodo_id, no_empleado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kpi_historico_importaciones (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  historico_periodo_id INT NULL,
  usuario_id INT NULL,
  archivo_nombre VARCHAR(255) NOT NULL,
  archivo_sha256 CHAR(64) NOT NULL,
  anio INT NULL,
  mes TINYINT NULL,
  estado VARCHAR(30) NOT NULL,
  filas_detectadas INT NOT NULL DEFAULT 0,
  empleados_detectados INT NOT NULL DEFAULT 0,
  feedback_detectado INT NOT NULL DEFAULT 0,
  advertencias TEXT NULL,
  error TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_historico_importacion_periodo
    FOREIGN KEY (historico_periodo_id) REFERENCES kpi_historico_periodos(id)
    ON DELETE SET NULL,
  KEY idx_historico_import_sha (anio, mes, archivo_sha256),
  KEY idx_historico_import_estado (estado, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
