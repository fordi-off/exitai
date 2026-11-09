@echo off
rem ExitAI launcher: starts the local server and opens the app window.
rem Closing the window shuts everything down (model unloaded, Ollama and browser stopped).
cd /d "%~dp0"
set EXITAI_AUTOEXIT=1
node server.mjs --app
