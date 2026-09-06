param(
  [Parameter(Mandatory=$true)][string]$AppRoot,
  [Parameter(Mandatory=$true)][string]$JulySource,
  [Parameter(Mandatory=$true)][string]$SkylineSource,
  [switch]$ExpectShippedHeaderFailure,
  [string]$PostgresBin='C:\Program Files\PostgreSQL\17\bin',
  [string]$Chrome="$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$ErrorActionPreference='Stop'
$apiRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$node=(Get-Command node).Source
$runToken=[guid]::NewGuid().ToString('N')
$tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$runRoot=Join-Path $tempRoot "spine-onboarding-proof-$runToken"
$dataRoot=Join-Path $runRoot 'data'
$pgCtl=Join-Path $PostgresBin 'pg_ctl.exe'
$initdb=Join-Path $PostgresBin 'initdb.exe'
$started=$false
$result=1
function Free-Port {
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
  try { $listener.Start(); return ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}
function Assert-OwnedRoot {
  $resolved=(Resolve-Path -LiteralPath $runRoot).Path
  if (-not $resolved.StartsWith($tempRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolved) -ne "spine-onboarding-proof-$runToken" -or
      (Get-Content -Raw -LiteralPath (Join-Path $resolved 'owner.txt')).Trim() -ne $runToken) {
    throw 'Owned local proof directory verification failed.'
  }
}
try {
  foreach($required in @($AppRoot,$JulySource,$SkylineSource,$Chrome,$initdb,$pgCtl)) {
    if(-not(Test-Path -LiteralPath $required)){throw "Required local input unavailable: $required"}
  }
  if(Test-Path -LiteralPath $runRoot){throw 'Proof directory already exists.'}
  New-Item -ItemType Directory -Path $runRoot | Out-Null
  Set-Content -LiteralPath (Join-Path $runRoot 'owner.txt') -Value $runToken
  Assert-OwnedRoot
  Write-Output "PRIVATE_PROOF_ROOT=$runRoot"
  & $initdb -D $dataRoot --username=postgres --auth-local=trust --auth-host=trust --encoding=UTF8 --no-locale *> (Join-Path $runRoot 'initdb.log')
  if($LASTEXITCODE -ne 0){throw 'Owned cluster initialization failed.'}
  $pgPort=Free-Port
  $apiPort=Free-Port
  if($pgPort -eq $apiPort){throw 'Distinct proof ports required.'}
  & $pgCtl -D $dataRoot -l (Join-Path $runRoot 'postgres.log') -o "-h 127.0.0.1 -p $pgPort" -w start
  if($LASTEXITCODE -ne 0){throw 'Owned PostgreSQL start failed.'}
  $started=$true
  $env:PSPINE_OWNED_CLUSTER_ROOT=$runRoot
  $env:PSPINE_OWNED_CLUSTER_TOKEN=$runToken
  $env:E2E_DATABASE_URL="postgresql://postgres@127.0.0.1:$pgPort/postgres"
  $env:E2E_DISPOSABLE_POSTGRES='1'
  $env:E2E_PROOF_MANIFEST=Join-Path $runRoot 'ownership.json'
  $env:E2E_SMS_LOG=Join-Path $runRoot 'sms.log'
  $env:E2E_ANTHROPIC_LOG=Join-Path $runRoot 'anthropic.log'
  $env:E2E_EGRESS_LOG=Join-Path $runRoot 'egress.log'
  $env:E2E_SESSION_LOG=Join-Path $runRoot 'sessions.log'
  $env:E2E_SERVER_APPLICATION_NAME="spine_local_$runToken"
  $env:PORT=[string]$apiPort
  $env:PSPINE_APP_ROOT=(Resolve-Path -LiteralPath $AppRoot).Path
  $env:JULY_SOURCE_PATH=(Resolve-Path -LiteralPath $JulySource).Path
  $env:SKYLINE_SOURCE_PATH=(Resolve-Path -LiteralPath $SkylineSource).Path
  $env:PROOF_OUTPUT_DIR=Join-Path $runRoot 'evidence'
  $env:PROOF_EXPECT_SHIPPED_HEADER_FAILURE=if($ExpectShippedHeaderFailure){'1'}else{'0'}
  $env:CHROME=$Chrome
  $env:PATH=$PostgresBin+';'+$env:PATH
  Remove-Item Env:DATABASE_URL,Env:HARNESS_DATABASE_URL,Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  & $node (Join-Path $PSScriptRoot 'onboarding_review_local.js')
  $result=$LASTEXITCODE
} finally {
  $clusterRunning=$started
  if(Test-Path -LiteralPath $dataRoot){
    Assert-OwnedRoot
    & $pgCtl -D $dataRoot status *> (Join-Path $runRoot 'final-status.log')
    if($LASTEXITCODE -eq 0){$clusterRunning=$true}
    elseif($LASTEXITCODE -ne 3 -and $LASTEXITCODE -ne 4){throw 'Cannot establish owned cluster state; refusing data cleanup.'}
  }
  if($clusterRunning){
    Assert-OwnedRoot
    & $pgCtl -D $dataRoot -w stop -m fast
    if($LASTEXITCODE -ne 0){$result=1; throw 'Could not stop the owned cluster; refusing to delete its data.'}
  }
  if(Test-Path -LiteralPath $dataRoot){
    Assert-OwnedRoot
    $resolvedData=(Resolve-Path -LiteralPath $dataRoot).Path
    if($resolvedData -ne (Join-Path (Resolve-Path -LiteralPath $runRoot).Path 'data')){throw 'Data cleanup escaped owned root.'}
    Remove-Item -LiteralPath $resolvedData -Recurse -Force
  }
  Write-Output "OWNED_CLUSTER_DATA_REMOVED=$(-not(Test-Path -LiteralPath $dataRoot))"
  Write-Output "PRIVATE_EVIDENCE_RETAINED=$runRoot"
}
exit $result
