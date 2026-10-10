@echo off
rem Launch the dashboard in its OWN detached console window so that a
rem parent terminal's Ctrl+C (or being closed) cannot stop it.
start "AKIJ Dashboard" /min cmd /c ""%~dp0run-dashboard.bat""
