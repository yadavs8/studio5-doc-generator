@echo off
rem Starts the Studio5 doc generator on this PC only (http://localhost:3000) and opens it as an app window.
cd /d "%~dp0"
curl -s http://localhost:3000/health >nul 2>&1
if %errorlevel% neq 0 (
  start /b "" node server.js
  timeout /t 2 /nobreak >nul
)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app="http://localhost:3000"
) else if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app="http://localhost:3000"
) else (
  start http://localhost:3000
)
