// Disparo para Windows: abre o sistema em janela própria.
// Não altera o programa: inicia o mesmo servidor (src/server/main.ts) com o
// Node embutido no Electron e mostra o mesmo painel (dist/web) numa janela.
const { app, BrowserWindow, dialog, Menu, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const APP_DIR = path.join(__dirname, '..');
const PREFERRED_PORT = 3333;

let serverProcess = null;
let mainWindow = null;
let port = PREFERRED_PORT;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(start);
}

function freePort(preferred) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => {
      const any = net.createServer();
      any.listen(0, '127.0.0.1', () => {
        const { port: chosen } = any.address();
        any.close(() => resolve(chosen));
      });
    });
    probe.listen(preferred, '127.0.0.1', () => probe.close(() => resolve(preferred)));
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}

async function waitForServer(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (serverProcess && serverProcess.exitCode !== null) return false;
    try {
      const { status } = await get(`http://127.0.0.1:${port}/api/overview`);
      if (status === 200) return true;
    } catch {
      /* ainda iniciando */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function start() {
  Menu.setApplicationMenu(null);
  const dataDir = app.getPath('userData');
  const logDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = fs.createWriteStream(path.join(logDir, 'servidor.log'), { flags: 'a' });

  port = await freePort(PREFERRED_PORT);
  serverProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(APP_DIR, 'src', 'server', 'main.ts')], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DISPARO_PORT: String(port),
      DISPARO_HOST: '127.0.0.1',
      DISPARO_DB_PATH: path.join(dataDir, 'disparo.db'),
    },
    windowsHide: true,
  });
  serverProcess.stdout.pipe(logFile);
  serverProcess.stderr.pipe(logFile);
  serverProcess.on('exit', (code) => {
    if (quitting) return;
    dialog.showErrorBox('Disparo', `O servidor do Disparo parou inesperadamente (código ${code}).\n\nDetalhes em:\n${path.join(logDir, 'servidor.log')}`);
    app.quit();
  });

  if (!(await waitForServer(60_000))) {
    if (!quitting) {
      dialog.showErrorBox('Disparo', `Não foi possível iniciar o Disparo.\n\nDetalhes em:\n${path.join(logDir, 'servidor.log')}`);
    }
    stopServer();
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Disparo',
    backgroundColor: '#0b0f17',
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // Links externos abrem no navegador; o painel fica na janela do programa.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Fechar com disparo em andamento: confirma antes (fechar interrompe os envios).
  mainWindow.on('close', async (event) => {
    if (quitting) return;
    event.preventDefault();
    let running = 0;
    try {
      const { body } = await get(`http://127.0.0.1:${port}/api/overview`);
      running = (JSON.parse(body).activeCampaigns || []).filter((c) => c.status === 'running').length;
    } catch {
      /* servidor indisponível: fecha normalmente */
    }
    if (running > 0) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Fechar mesmo assim', 'Cancelar'],
        defaultId: 1,
        cancelId: 1,
        title: 'Disparo',
        message: `Há ${running} disparo(s) em andamento.`,
        detail: 'Fechar o Disparo interrompe os envios. Os contatos pendentes continuam salvos e seguem quando você abrir de novo e retomar.',
      });
      if (response !== 0) return;
    }
    quitting = true;
    mainWindow.destroy();
  });
}

function stopServer() {
  if (serverProcess && serverProcess.exitCode === null) {
    // No Windows não há SIGTERM real: encerra o processo do servidor.
    serverProcess.kill();
  }
}

app.on('window-all-closed', () => {
  quitting = true;
  stopServer();
  app.quit();
});
app.on('before-quit', () => {
  quitting = true;
  stopServer();
});
