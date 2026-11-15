const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");

// 单实例：开第二个会抢 localStorage 里的存档，直接聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;

function createWindow() {
  const statePath = path.join(app.getPath("userData"), "win-state.json");
  let saved = {};
  try {
    saved = JSON.parse(require("fs").readFileSync(statePath, "utf8"));
  } catch (e) {
    saved = {};
  }

  mainWindow = new BrowserWindow({
    width: saved.width || 1280,
    height: saved.height || 900,
    x: typeof saved.x === "number" ? saved.x : undefined,
    y: typeof saved.y === "number" ? saved.y : undefined,
    minWidth: 900,
    minHeight: 680,
    backgroundColor: "#f7efe2",
    title: "珍馐水果合成 2048",
    icon: path.join(__dirname, "web", "icon.ico"),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,  // 窗口在后台时也让动画继续跑
    },
  });

  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, "web", "index3d.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // 记住窗口大小与位置，下次打开还原
  const saveState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getBounds();
    try {
      require("fs").writeFileSync(
        statePath,
        JSON.stringify({ width: b.width, height: b.height, x: b.x, y: b.y })
      );
    } catch (e) {
      /* 写不进去就算了，不影响游戏 */
    }
  };
  mainWindow.on("resize", saveState);
  mainWindow.on("move", saveState);
  mainWindow.on("close", saveState);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 页面里的外链一律用系统浏览器打开，不在游戏窗口里跳走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
