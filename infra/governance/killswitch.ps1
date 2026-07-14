# Budget kill-switch — invoked by the budget action group when spend hits 100%.
#
# Stops everything that bills per hour and leaves everything else intact:
#   1. Deallocates the app VM (a merely "stopped" VM keeps billing; deallocated does not).
#   2. Scales the detector Container App to min_replicas = 0, which is the same switch
#      `make detector-stop` uses: zero replicas means no container and $0/hour.
#
# Nothing is deleted. Bringing the demo back is `make detector-start` + vm-start.
#
# HOW IT FINDS ITS TARGETS — and why it is done THIS way:
#
# It is told WHERE to look (two resource groups) and discovers WHAT is there at run time.
# Both groups belong to THIS module: governance creates them, and they outlive every demo.
# So naming them is not a hard-coded dependency on the workload — it is this module reading
# its own property. What it is never told is the VM's name or the detector's resource id:
# those belong to the workload, which is destroyed and recreated on every cycle, and pinning
# them would put the guard's lifetime back inside the lifetime of the thing it guards.
#
# The obvious alternative — a subscription-wide `Get-AzResource -Tag` — is a TRAP, and the
# trap is quiet. That call is `GET /subscriptions/{id}/resources`, a SUBSCRIPTION-scope read
# that needs `Microsoft.Resources/subscriptions/resources/read`. This identity holds four
# actions, assigned at two RESOURCE GROUPS and nowhere else. The query would come back empty
# for a permissions reason that looks EXACTLY like "the workload is not deployed" — so the
# runbook would report success, cut nothing, and let the bill keep running on the one day it
# was supposed to save you. Listing one resource type inside one group needs only that type's
# `read` action, which is precisely what the role grants.
#
# A LOOKUP THAT FAILS MUST BE LOUD. Finding zero resources in a group that exists is a
# success (the workload is torn down; nothing bills; there is nothing to cut). A lookup that
# THROWS is a different animal entirely, and it exits non-zero so the job shows as Failed
# instead of quietly reporting that it had nothing to do.
#
# WHY the raw ARM REST API instead of `Update-AzContainerApp`: an Azure Automation Account
# ships with Az.Accounts, Az.Compute, Az.Resources and friends — but NOT with Az.App. Using
# the cmdlet would mean importing that module into the Automation Account (an extra resource,
# a slow import, and a dependency chain that breaks quietly). The REST call needs nothing but
# a token from Az.Accounts, which is always there.
#
# WHY a PATCH with only the scale block: the Container Apps PATCH is a JSON Merge Patch
# (RFC 7386), so nested objects merge instead of replacing. Sending just
# properties.template.scale.minReplicas leaves the containers, the image, the secrets and the
# env untouched — this must not be able to mangle the app it is trying to save.

$ErrorActionPreference = 'Stop'

$subscriptionId = Get-AutomationVariable -Name 'SubscriptionId'
$vmRg           = Get-AutomationVariable -Name 'VmResourceGroup'
$detectorRg     = Get-AutomationVariable -Name 'DetectorResourceGroup'

Disable-AzContextAutosave -Scope Process | Out-Null
Connect-AzAccount -Identity -Subscription $subscriptionId | Out-Null

Write-Output "KILL-SWITCH: budget threshold reached. Shutting down billable compute."

$failed = $false

# --- 1. The VMs -----------------------------------------------------------
# Written for a set, not for "the VM whose name I memorised": what the guard has to cut is
# every VM in the app group, whatever it happens to be called this cycle.
$vms = @()
try {
    $vms = @(Get-AzVM -ResourceGroupName $vmRg)
    Write-Output "Found $($vms.Count) VM(s) in $vmRg."
} catch {
    $failed = $true
    Write-Error "Could not list VMs in ${vmRg}: $($_.Exception.Message)"
}

foreach ($vm in $vms) {
    try {
        Write-Output "Deallocating VM $($vm.Name) ($vmRg)..."
        Stop-AzVM -ResourceGroupName $vmRg -Name $vm.Name -Force | Out-Null
        Write-Output "VM $($vm.Name) deallocated."
    } catch {
        $failed = $true
        Write-Error "Could not deallocate $($vm.Name): $($_.Exception.Message)"
    }
}

# --- 2. The detector container ---------------------------------------------
$apiVersion = '2024-03-01'
$listUri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$detectorRg" `
    + "/providers/Microsoft.App/containerApps?api-version=$apiVersion"

# Az.Accounts >= 5 returns the token as a SecureString; older versions return a plain string.
# The Automation Account's module version is not ours to pin, so handle both.
$tokenResponse = Get-AzAccessToken -ResourceUrl 'https://management.azure.com/'
if ($tokenResponse.Token -is [System.Security.SecureString]) {
    $token = [System.Net.NetworkCredential]::new('', $tokenResponse.Token).Password
} else {
    $token = $tokenResponse.Token
}
$headers = @{ Authorization = "Bearer $token" }

$apps = @()
try {
    $apps = @((Invoke-RestMethod -Uri $listUri -Headers $headers -Method Get).value)
    Write-Output "Found $($apps.Count) Container App(s) in $detectorRg."
} catch {
    $failed = $true
    Write-Error "Could not list Container Apps in ${detectorRg}: $($_.Exception.Message)"
}

$body = @{ properties = @{ template = @{ scale = @{ minReplicas = 0 } } } } | ConvertTo-Json -Depth 5

foreach ($app in $apps) {
    try {
        $uri = "https://management.azure.com$($app.id)" + "?api-version=$apiVersion"
        Write-Output "Scaling $($app.name) to 0 replicas..."
        $updated = Invoke-RestMethod -Uri $uri -Headers $headers -Method Patch `
            -Body $body -ContentType 'application/json'
        Write-Output "$($app.name) min_replicas is now $($updated.properties.template.scale.minReplicas)."
    } catch {
        $failed = $true
        Write-Error "Could not scale $($app.name) to zero: $($_.Exception.Message)"
    }
}

# --- Outcome ---------------------------------------------------------------
if ($failed) {
    # Exit non-zero so the Automation job shows as Failed. A cost guard that could not do its
    # job must not look like one that had nothing to do.
    throw "KILL-SWITCH: one or more steps FAILED. Per-hour cost may still be running — check the errors above and stop the compute by hand (make detector-stop; ./scripts/deploy-azure.sh vm-stop)."
}

if ($vms.Count -eq 0 -and $apps.Count -eq 0) {
    Write-Output "KILL-SWITCH: the workload is not deployed. Nothing bills per hour, so there is nothing to stop."
    exit 0
}

Write-Output "KILL-SWITCH: done. Per-hour cost is now ~0. Nothing was deleted."
