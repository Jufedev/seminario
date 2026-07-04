variable "project_name" {
  description = "Short name used as prefix for all resources (lowercase, no spaces)"
  type        = string
  default     = "metaverso"
}

variable "location" {
  description = "Azure region for all resources"
  type        = string
  default     = "eastus2"
}

variable "budget_amount" {
  description = "Monthly budget in USD for the resource group alert"
  type        = number
  default     = 50
}

variable "budget_contact_emails" {
  description = "Emails notified when the budget threshold is reached"
  type        = list(string)
}

variable "budget_start_date" {
  description = "Budget period start (first day of current month, RFC3339)"
  type        = string
  default     = "2026-07-01T00:00:00Z"
}
