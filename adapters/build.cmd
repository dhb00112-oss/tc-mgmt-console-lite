@echo off
setlocal
rem Build MgrJmxBridge into adapters\tc-mgr-jmx.jar. No Teamcenter or SOA
rem libraries are needed: the bridge only uses the JDK JMX API. Bytecode targets
rem Java 11 to match the field runtime. adapters\build is a temporary directory
rem and must not be shipped.

set "ADAPTER_DIR=%~dp0"
set "JAVAC=javac"
set "JAR=jar"
for %%D in ("C:\Amazon Corretto\jdk11.0.32_9" "%JAVA_HOME%") do (
  if exist "%%~D\bin\javac.exe" set "JAVAC=%%~D\bin\javac.exe"
  if exist "%%~D\bin\jar.exe" set "JAR=%%~D\bin\jar.exe"
)

if exist "%ADAPTER_DIR%build" rmdir /s /q "%ADAPTER_DIR%build"
if exist "%ADAPTER_DIR%tc-mgr-jmx.jar" del /q "%ADAPTER_DIR%tc-mgr-jmx.jar"
mkdir "%ADAPTER_DIR%build"

"%JAVAC%" --release 11 -encoding UTF-8 -d "%ADAPTER_DIR%build" "%ADAPTER_DIR%java\MgrJmxBridge.java" || exit /b 1
"%JAR%" --create --file "%ADAPTER_DIR%tc-mgr-jmx.jar" -C "%ADAPTER_DIR%build" . || exit /b 1

echo Built %ADAPTER_DIR%tc-mgr-jmx.jar
endlocal
