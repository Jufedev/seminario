output "job_id" {
  description = "ID of the red-point detector job"
  value       = databricks_job.detector.id
}

output "job_url" {
  description = "Databricks UI page of the job (runs, logs, driver stdout)"
  value       = "${var.workspace_url}/#job/${databricks_job.detector.id}"
}

output "detector_running" {
  description = "Whether the detector job is currently unpaused"
  value       = var.detector_running
}

output "archive_path" {
  description = "ADLS path the detector archives to (empty when archiving is off)"
  value       = local.archive_path
}
