@echo off
cd /d "C:\Users\dell\Projects\studio5-doc-generator\studio5-doc-generator"
curl -s http://localhost:3000/health >nul 2>&1
if %errorlevel% neq 0 (
  start /b "" "C:\Program Files\nodejs\node.exe" server.js
  timeout /t 1 /nobreak >nul
)
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
  start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app="http://localhost:3000"
) else if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
  start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app="http://localhost:3000"
) else (
  start http://localhost:3000
)