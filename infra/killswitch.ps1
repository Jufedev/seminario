# Budget kill-switch — invoked by the budget action group when spend hits 100%.
#
# Stops everything that bills per hour and leaves everything else intact:
#   1. Deallocates the app VM (a merely "stopped" VM keeps billing; deallocated does not).
#   2. Pauses every Databricks job, which terminates its job cluster.
#   3. Terminates any interactive cluster somebody left running by hand.
#
# Nothing is deleted. Redeploying the demo is `make detector-start` + vm-start.
#
# Pausing (not just cancelling) is the point: the detector is a CONTINUOUS job, so
# Databricks restarts a cancelled run by itself and the cluster — and the bill — comes
# straight back. Pause first, then cancel what is still in flight.

$ErrorActionPreference = 'Continue'

Disable-AzContextAutosave -Scope Process | Out-Null
Connect-AzAccount -Identity | Out-Null

$vmRg   = Get-AutomationVariable -Name 'VmResourceGroup'
$vmName = Get-AutomationVariable -Name 'VmName'
$dbxUrl = Get-AutomationVariable -Name 'DatabricksUrl'

Write-Output "KILL-SWITCH: budget threshold reached. Shutting down billable compute."

# --- 1. The VM ------------------------------------------------------------
Write-Output "Deallocating VM $vmName ($vmRg)..."
Stop-AzVM -ResourceGroupName $vmRg -Name $vmName -Force
Write-Output "VM deallocated."

# --- 2. Databricks --------------------------------------------------------
# The managed identity is Contributor on the workspace's resource group, which makes
# it a workspace admin in Azure Databricks. This is the AAD app id of Azure Databricks.
$token = (Get-AzAccessToken -ResourceUrl '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d').Token
$headers = @{ Authorization = "Bearer $token" }

$jobs = Invoke-RestMethod -Uri "$dbxUrl/api/2.1/jobs/list?limit=25" -Headers $headers -Method Get
foreach ($job in $jobs.jobs) {
    $body = @{
        job_id       = $job.job_id
        new_settings = @{ continuous = @{ pause_status = 'PAUSED' } }
    } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Uri "$dbxUrl/api/2.1/jobs/update" -Headers $headers -Method Post `
        -Body $body -ContentType 'application/json'
    Write-Output "Paused job $($job.job_id) ($($job.settings.name))."
}

$runs = Invoke-RestMethod -Uri "$dbxUrl/api/2.1/jobs/runs/list?active_only=true" -Headers $headers -Method Get
foreach ($run in $runs.runs) {
    $body = @{ run_id = $run.run_id } | ConvertTo-Json
    Invoke-RestMethod -Uri "$dbxUrl/api/2.1/jobs/runs/cancel" -Headers $headers -Method Post `
        -Body $body -ContentType 'application/json'
    Write-Output "Cancelled run $($run.run_id)."
}

# --- 3. Stray interactive clusters ---------------------------------------
$clusters = Invoke-RestMethod -Uri "$dbxUrl/api/2.0/clusters/list" -Headers $headers -Method Get
foreach ($cluster in $clusters.clusters) {
    if ($cluster.state -in @('RUNNING', 'PENDING', 'RESIZING')) {
        $body = @{ cluster_id = $cluster.cluster_id } | ConvertTo-Json
        # "delete" in the Clusters API means TERMINATE, not destroy.
        Invoke-RestMethod -Uri "$dbxUrl/api/2.0/clusters/delete" -Headers $headers -Method Post `
            -Body $body -ContentType 'application/json'
        Write-Output "Terminated cluster $($cluster.cluster_id)."
    }
}

Write-Output "KILL-SWITCH: done. Per-hour cost is now ~0. Nothing was deleted."
