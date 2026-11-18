param([string]$Email = 'answerhelperduo@gmail.com')
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $nodePath = if ($nodeCommand) { $nodeCommand.Source } else {
        Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
    }
    if (!(Test-Path -LiteralPath $nodePath)) { throw 'Install Node.js 24 before setting up the administrator.' }
    Write-Host "Creating administrator $Email"
    $password = Read-Host 'Choose a password (at least 8 characters)' -AsSecureString
    $plainPassword = [System.Net.NetworkCredential]::new('', $password).Password
    if ($plainPassword.Length -lt 8) { throw 'The password must contain at least 8 characters.' }
    @{ email = $Email; password = $plainPassword } | ConvertTo-Json -Compress | & $nodePath create-admin.ts
    if ($LASTEXITCODE -ne 0) { throw 'Administrator setup failed. Read the message above.' }
} finally {
    $plainPassword = $null
    $password = $null
    Pop-Location
}
