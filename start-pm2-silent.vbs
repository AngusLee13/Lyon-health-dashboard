' PM2 静默启动脚本 — 完全隐藏 cmd 窗口
' 使用方法：双击此 .vbs 文件，或在 Windows 启动时运行它
CreateObject("WScript.Shell").Run "cmd /c cd /d D:\fisrt-cc && pm2 resurrect", 0, False
