@echo off
rem Build the Ruffle fork (if needed) and serve the AIR launcher page.
rem
rem   run.bat                 serve on http://127.0.0.1:8000
rem   run.bat --build         rebuild Ruffle, then serve
rem   run.bat --port 9000     use a different port
rem   run.bat --host 0.0.0.0  listen on all interfaces

setlocal
cd /d "%~dp0"

set "BUILD=0"
set "HOST=127.0.0.1"
set "PORT=8000"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--build" (
    set "BUILD=1"
    shift
    goto parse
)
if /i "%~1"=="--host" (
    set "HOST=%~2"
    shift
    shift
    goto parse
)
if /i "%~1"=="--port" (
    set "PORT=%~2"
    shift
    shift
    goto parse
)
echo unknown option: %~1 1>&2
exit /b 1

:parsed
set "RUFFLE_DIR=ruffle-air\web"
set "RUFFLE_DIST=%RUFFLE_DIR%\packages\selfhosted\dist\ruffle.js"

if not exist "%RUFFLE_DIST%" set "BUILD=1"

if "%BUILD%"=="1" (
    call :build
    if errorlevel 1 exit /b 1
)

python tools\serve.py --host %HOST% --port %PORT%
exit /b %errorlevel%

:build
rem Prefer the rustup shims: distro Rust packages usually lack the wasm target.
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

where cargo >nul 2>nul
if errorlevel 1 (
    echo error: cargo not found. Install Rust from https://rustup.rs 1>&2
    exit /b 1
)

set "SYSROOT="
for /f "delims=" %%S in ('rustc --print sysroot 2^>nul') do set "SYSROOT=%%S"
if defined SYSROOT if exist "%SYSROOT%\lib\rustlib\wasm32-unknown-unknown" goto rust_ready

where rustup >nul 2>nul
if errorlevel 1 (
    echo error: Rust target wasm32-unknown-unknown is missing and rustup was not found. 1>&2
    echo        Install it with: rustup target add wasm32-unknown-unknown 1>&2
    exit /b 1
)
echo installing Rust target wasm32-unknown-unknown...
call rustup target add wasm32-unknown-unknown
if errorlevel 1 exit /b 1

:rust_ready
echo building ruffle-core...
pushd "%RUFFLE_DIR%"
call npm run build --workspace=ruffle-core
if errorlevel 1 (
    popd
    exit /b 1
)
echo building ruffle-selfhosted...
call npm run build --workspace=ruffle-selfhosted
if errorlevel 1 (
    popd
    exit /b 1
)
popd
exit /b 0
