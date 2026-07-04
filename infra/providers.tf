terraform {
  required_version = ">= 1.5"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "azurerm" {
  features {}

  # Subscription is taken from the ARM_SUBSCRIPTION_ID environment variable
  # (required by azurerm 4.x). See infra/README.md.

  # --- Local emulation with Floci (optional) ---
  # The azurerm provider discovers endpoints over HTTPS, so Floci must run
  # with FLOCI_AZ_TLS_ENABLED=true and its self-signed certificate trusted
  # (available at http://localhost:4577/_floci/tls-cert). Then uncomment:
  # metadata_host = "localhost:4577"
}
