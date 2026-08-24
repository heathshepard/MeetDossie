@echo off
REM Wrapper Chrome actually launches for native messaging (Chrome's launcher
REM needs a real executable path; native host manifests have no "args"
REM field to hand node.js a script path directly -- a thin .bat is the
REM standard, documented pattern, see Chrome's own native-messaging-example
REM for Windows). %~dp0 resolves to this file's own directory regardless of
REM Chrome's working directory when it spawns this.
node.exe "%~dp0host.js"
