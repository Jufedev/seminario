# Budget kill-switch — invoked by the budget action group when spend hits 100%.
#
# Stops everything that bills per hour and leaves everything else intact:
#   1. Deallocates the app VM (a merely "stopped" VM keeps billing; deallocated does not).
#   2. Scales the detector Container App to min_replicas = 0, which is the same switch
#      `make detector-stop` uses: zero replicas means no container and $0/hour.
#
# Nothing is deleted. Bringing the demo back is `make detector-start` + vm-start.
#
# WHY the raw ARM REST API instead of `Update-AzContainerApp`: an Azure Automation Account
# ships with Az.Accounts, Az.Compute, Az.Resources and friends — but NOT with Az.App. Using
# the cmdlet would mean importing that module into the Automation Account (an extra resource,
# a slow import, and a dependency chain that breaks quietly). The REST call needs nothing but
# a token from Az.Accounts, which is always there. It is also exactly the idiom the v1 runbook
# already used to reach the Databricks Jobs API.
#
# WHY a PATCH with only the scale block: the Container Apps PATCH is a JSON Merge Patch
# (RFC 7386), so nested objects merge instead of replacing. Sending just
# properties.template.scale.minReplicas leaves the containers, the image, the secrets and the
# env untouched — this must not be able to mangle the app it is trying to save.

$ErrorActionPreference = 'Continue'

Disable-AzContextAutosave -Scope Process | Out-Null
Connect-AzAccount -Identity | Out-Null

$vmRg          = Get-AutomationVariable -Name 'VmResourceGroup'
$vmName        = Get-AutomationVariable -Name 'VmName'
$detectorAppId = Get-AutomationVariable -Name 'DetectorAppId'

Write-Output "KILL-SWITCH: budget threshold reached. Shutting down billable compute."

# --- 1. The VM ------------------------------------------------------------
Write-Output "Deallocating VM $vmName ($vmRg)..."
Stop-AzVM -ResourceGroupName $vmRg -Name $vmName -Force
Write-Output "VM deallocated."

# --- 2. The detector container --------------------------------------------
# Az.Accounts >= 5 returns the token as a SecureString; older versions return a plain
# string. The Automation Account's module version is not ours to pin, so handle both.
$tokenResponse = Get-AzAccessToken -ResourceUrl 'https://management.azure.com/'
if ($tokenResponse.Token -is [System.Security.SecureString]) {
    $token = [System.Net.NetworkCredential]::new('', $tokenResponse.Token).Password
} else {
    $token = $tokenResponse.Token
}

$headers = @{ Authorization = "Bearer $token" }
$uri     = "https://management.azure.com$detectorAppId" + "?api-version=2024-03-01"
$body    = @{ properties = @{ template = @{ scale = @{ minReplicas = 0 } } } } | ConvertTo-Json -Depth 5

Write-Output "Scaling the detector container to 0 replicas ($detectorAppId)..."
$updated = Invoke-RestMethod -Uri $uri -Headers $headers -Method Patch `
    -Body $body -ContentType 'application/json'
Write-Output "Detector min_replicas is now $($updated.properties.template.scale.minReplicas)."

Write-Output "KILL-SWITCH: done. Per-hour cost is now ~0. Nothing was deleted."
