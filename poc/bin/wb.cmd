@echo off
rem wb: the board from cmd and PowerShell (see wb.mjs). Board terminals set WB_NODE to the runtime that runs it:
rem Node, or the Shellside app's own (ELECTRON_RUN_AS_NODE makes the app act as Node; Node ignores it).
setlocal
set "ELECTRON_RUN_AS_NODE=1"
set "WB_RUN=%WB_NODE%"
if not defined WB_RUN set "WB_RUN=node"
"%WB_RUN%" "%~dp0wb.mjs" %*
exit /b %ERRORLEVEL%
