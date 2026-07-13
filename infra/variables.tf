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
  description = "Monthly ceiling in USD. Reaching 100% of it fires the kill-switch: the VM is deallocated and the Databricks jobs are paused (nothing is deleted)."
  type        = number
  default     = 40

  validation {
    condition     = var.budget_amount > 0
    error_message = "budget_amount must be greater than 0."
  }
}

variable "budget_alert_amount" {
  description = "Spend in USD at which the first warning email is sent (no action taken)."
  type        = number
  default     = 10

  validation {
    condition     = var.budget_alert_amount > 0
    error_message = "budget_alert_amount must be greater than 0."
  }
}

variable "budget_contact_emails" {
  description = "Emails notified at every budget threshold"
  type        = list(string)
}

variable "killswitch_webhook_expiry" {
  description = "Expiry of the webhook the budget action group calls (RFC3339). After this date the kill-switch stops firing — re-apply to renew."
  type        = string
  default     = "2027-07-01T00:00:00Z"
}

variable "vm_size" {
  description = "Size of the VM hosting the metaverse frontend and backend"
  type        = string
  default     = "Standard_B2s"
}

variable "vm_admin_username" {
  description = "Admin username for the app VM"
  type        = string
  default     = "azureuser"
}

variable "vm_ssh_public_key" {
  description = "SSH public key for the app VM admin user"
  type        = string
}

variable "repo_url" {
  description = "Git URL cloned by cloud-init to deploy the metaverse app (must be reachable without credentials)"
  type        = string
  default     = "https://github.com/Jufedev/seminario.git"
}

variable "app_port" {
  description = "WebSocket port exposed by the metaverse backend"
  type        = number
  default     = 8080
}

variable "budget_start_date" {
  description = "Budget period start (first day of current month, RFC3339)"
  type        = string
  default     = "2026-07-01T00:00:00Z"
}
