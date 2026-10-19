@echo off
echo ========================================================
echo  Allowing WhatsApp Sender (Port 3000) Through Firewall
echo ========================================================
echo.
echo Requesting Windows Administrator Permission...
powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c netsh advfirewall firewall add rule name=\"WhatsApp Sender Port 3000\" dir=in action=allow protocol=TCP localport=3000 & netsh advfirewall firewall add rule name=\"WhatsApp Sender UDP 3001\" dir=in action=allow protocol=UDP localport=3001 & echo Firewall rule added successfully! & timeout /t 3' -Verb RunAs"
echo.
echo If Windows prompted you with UAC, click YES to confirm.
echo Done!
pause
