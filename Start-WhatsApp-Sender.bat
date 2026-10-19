@echo off
title WhatsApp Direct Video & Contacts Dispatcher
cd /d "%~dp0"
echo ======================================================================
echo          WHATSAPP DIRECT VIDEO & CONTACTS DISPATCHER
echo ======================================================================
echo.
echo  [+] Launching local WhatsApp server on http://localhost:3000...
echo  [+] Your browser will open automatically.
echo  [+] Keep this window open while using the application.
echo.
echo ======================================================================
start "" http://localhost:3000
node server.js
pause
