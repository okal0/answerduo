@echo off
setlocal
cd /d "%~dp0"
set "ANSWERDUO_NODE=node"
where node >nul 2>&1
if errorlevel 1 set "ANSWERDUO_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%ANSWERDUO_NODE%" create-admin.ts --reset
if errorlevel 1 goto finish
echo.
echo Updating the deployed admin password through Cloudflare...
set "WRANGLER_SEND_METRICS=false"
set "WRANGLER_LOG_PATH=%CD%\.wrangler\logs"
"%ANSWERDUO_NODE%" scripts/migrate-cloudflare-admin.mjs
if errorlevel 1 (
  echo Cloudflare update failed. The new password is saved locally.
  echo Sign in with Wrangler and run node scripts/migrate-cloudflare-admin.mjs to retry.
) else (
  echo Password updated. Sign in at https://app.answerduo.workers.dev/account
)
:finish
echo.
pause
