terraform {
  required_version = ">= 1.5"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}

  # Subscription is taken from the ARM_SUBSCRIPTION_ID environment variable
  # (required by azurerm 4.x). See infra/README.md.
}
