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
