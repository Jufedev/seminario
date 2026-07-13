terraform {
  required_version = ">= 1.5"

  required_providers {
    databricks = {
      source  = "databricks/databricks"
      version = "~> 1.50"
    }
  }
}

# Authenticates with the Azure CLI credentials of the current user (az login),
# the same identity that created the workspace. Both attributes come from the
# first stage (infra/) — see its outputs. They are inputs, not resources, which
# is exactly why the detector lives in a separate root module: Terraform cannot
# configure a provider from a resource created in the same apply.
provider "databricks" {
  host                        = var.workspace_url
  azure_workspace_resource_id = var.workspace_id
}
