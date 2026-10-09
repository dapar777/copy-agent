@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Copy Agent - instalace do VS Code
echo.
echo  ===== Copy Agent - instalace rozsireni do VS Code =====
echo.

set "DIR=%~dp0"
set "VSIX="

if not "%~1"=="" (
    if /i "%~x1"==".vsix" if exist "%~1" set "VSIX=%~f1"
)

if not defined VSIX call :find "%DIR%"
if not defined VSIX call :find "%CD%\"
if not defined VSIX call :find "%USERPROFILE%\Downloads\"
if not defined VSIX call :find "%USERPROFILE%\Desktop\"

if not defined VSIX (
    echo  CHYBA: nenasel jsem zadny soubor *.vsix.
    echo.
    echo  Hledal jsem v:
    echo    - %DIR%
    echo    - %CD%\
    echo    - %USERPROFILE%\Downloads\
    echo    - %USERPROFILE%\Desktop\
    echo.
    echo  Tipy:
    echo    - Pokud jste bat spustili primo z otevreneho ZIPu, nejdriv ZIP cely rozbalte.
    echo    - Soubor musi mit priponu .vsix; prohlizec ho nekdy prejmenuje.
    echo    - Nebo VSIX na tento bat pretahnete mysi, pripadne ho dejte do stejne slozky.
    goto :fail
)
echo  Balicek:  %VSIX%

set "CODE="
for %%C in (code.cmd code) do (
    if not defined CODE (
        for /f "delims=" %%P in ('where %%C 2^>nul') do if not defined CODE set "CODE=%%P"
    )
)
if not defined CODE if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd" set "CODE=%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd"
if not defined CODE if exist "%ProgramFiles%\Microsoft VS Code\bin\code.cmd" set "CODE=%ProgramFiles%\Microsoft VS Code\bin\code.cmd"
if not defined CODE if exist "%ProgramFiles(x86)%\Microsoft VS Code\bin\code.cmd" set "CODE=%ProgramFiles(x86)%\Microsoft VS Code\bin\code.cmd"
if not defined CODE if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd" set "CODE=%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd"
if not defined CODE (
    echo  CHYBA: nenasel jsem VS Code ^(prikaz "code"^).
    echo  Nainstalujte VS Code z https://code.visualstudio.com/ ^(nechte zaskrtnute "Add to PATH"^),
    echo  nebo v paletce prikazu ^(Ctrl+Shift+P^) dejte "Shell Command: Install 'code' command in PATH".
    goto :fail
)
echo  VS Code:  %CODE%
echo.
echo  Instaluji...
call "%CODE%" --install-extension "%VSIX%" --force
if errorlevel 1 (
    echo.
    echo  CHYBA: instalace selhala ^(kod %errorlevel%^). Zavrete VS Code a spustte bat znovu,
    echo  nebo ve VS Code: Extensions ^(Ctrl+Shift+X^) ^> menu "..." ^> "Install from VSIX..." a vyberte
    echo  %VSIX%
    goto :fail
)

set "FOUND="
for /f "delims=" %%E in ('call "%CODE%" --list-extensions 2^>nul') do (
    if /i "%%E"=="dapar.copy-agent" set "FOUND=1"
)
echo.
if defined FOUND (
    echo  HOTOVO: rozsireni dapar.copy-agent je nainstalovane.
) else (
    echo  Instalace probehla, ale v seznamu rozsireni jeste neni videt - po restartu VS Code by melo byt.
)
echo.
echo  Co dal: restartujte VS Code ^(nebo Ctrl+Shift+P ^> "Developer: Reload Window"^).
echo  Panel Copy Agent je v pravem postrannim panelu ^(prepina se v zahlavi vedle Copilot Chatu^); novy ukol: Ctrl+Alt+C.
echo  Agenta v Copilotu ^(Teams^) zalozte podle copilot-agent\NAVOD.md; instrukce pro nej da do schranky
echo  prikaz "Copy Agent: Zkopirovat instrukce pro agenta v Copilotu".
echo.
pause
exit /b 0

:find
set "D=%~1"
if not exist "%D%" exit /b 0
for %%F in ("%D%copy-agent*.vsix") do if exist "%%~fF" set "VSIX=%%~fF"
if not defined VSIX for %%F in ("%D%*.vsix") do if exist "%%~fF" set "VSIX=%%~fF"
exit /b 0

:fail
echo.
pause
exit /b 1
