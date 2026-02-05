-- Script de actualización para KPIs ponderados
-- Este script agrega la columna `peso` a la tabla puesto_kpis
-- y auto distribuye los pesos existentes de forma que la suma por puesto sea 100.

-- Agregar columna peso al modelo de asignación de KPIs por puesto.
ALTER TABLE puesto_kpis
  ADD COLUMN peso DECIMAL(5,2) NOT NULL DEFAULT 0;

-- Auto distribuir pesos para los registros existentes.
-- Para cada puesto, se calcula el número de KPIs asignados (N).
-- Se asigna inicialmente a cada KPI un peso igual a ROUND(100 / N, 2).
UPDATE puesto_kpis pk
JOIN (
  SELECT puesto_id, COUNT(*) AS total
  FROM puesto_kpis
  GROUP BY puesto_id
) t ON pk.puesto_id = t.puesto_id
SET pk.peso = ROUND(100 / t.total, 2);

-- Ajustar el último registro de cada puesto para que la suma cierre exactamente en 100.
-- Se calcula la diferencia entre 100 y la suma de los pesos iniciales y se suma al último KPI.
UPDATE puesto_kpis pk
JOIN (
  SELECT puesto_id, (100 - SUM(peso)) AS diff, MAX(id) AS last_pk_id
  FROM puesto_kpis
  GROUP BY puesto_id
) t ON pk.id = t.last_pk_id
SET pk.peso = pk.peso + t.diff;

-- Crear tabla para registrar envíos de correos de resultados de KPIs
-- Esta tabla almacena cuándo se envió un correo a cada empleado para un
-- determinado año y mes.  Utiliza una clave única compuesta por
-- (empleado_id, anio, mes) para evitar envíos duplicados.  El campo
-- enviado_el almacena la fecha y hora del último envío.
CREATE TABLE IF NOT EXISTS kpi_emails_sent (
  id INT AUTO_INCREMENT PRIMARY KEY,
  empleado_id INT NOT NULL,
  anio INT NOT NULL,
  mes INT NOT NULL,
  enviado_el DATETIME NOT NULL,
  UNIQUE KEY uniq_empleado_periodo (empleado_id, anio, mes),
  FOREIGN KEY (empleado_id) REFERENCES empleados (id)
    ON DELETE CASCADE
);

-- Crear tabla de configuración de envío masivo de KPIs
-- Esta tabla permite configurar de forma dinámica los parámetros que
-- controlan el programador de envíos automáticos.  Almacena el día
-- de inicio (start_day), la hora de ejecución diaria (send_time), el
-- límite de correos por ejecución (batch_limit) y un indicador
-- resend_flag para habilitar el reenvío cuando no queden pendientes.
-- Si existe más de un registro, se tomará el último actualizado.
CREATE TABLE IF NOT EXISTS kpi_batch_config (
  id INT PRIMARY KEY,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  start_day INT NOT NULL DEFAULT 11,
  send_time VARCHAR(5) NOT NULL DEFAULT '20:00',
  batch_limit INT NOT NULL DEFAULT 150,
  resend_sent TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kpi_batch_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  period_year INT NOT NULL,
  period_month INT NOT NULL,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  mode VARCHAR(20) NOT NULL DEFAULT 'scheduler',
  total_targets INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  is_running TINYINT(1) NOT NULL DEFAULT 0,
  last_message VARCHAR(255) NULL,
  last_error VARCHAR(255) NULL
);