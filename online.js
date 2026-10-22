/* ============================================================
   Cordis — Inicializador do servidor online (VS Code / terminal)
   1. Verifica/instala dependências automaticamente se faltarem
   2. Cria o banco de dados SQL (data/cordis.sqlite) e sobe o servidor
   3. Abre um túnel HTTPS público e imprime o link para mandar aos amigos
   Atalhos no VS Code: F5 (run) ou Ctrl+Shift+B (task padrão)
   ============================================================ */
'use strict';
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/* 1. Se o usuário ainda não rodou npm install, instala automaticamente */
const wsPath = path.join(__dirname, 'node_modules', 'ws');
const sqlPath = path.join(__dirname, 'node_modules', 'sql.js');
if (!fs.existsSync(wsPath) || !fs.existsSync(sqlPath)) {
  console.log('📦 Instalando dependências do Cordis pela primeira vez (aguarde alguns segundos)...');
  try {
    execSync('npm install --omit=dev', { cwd: __dirname, stdio: 'inherit' });
  } catch (e) {
    console.error('Erro ao instalar dependências:', e.message);
  }
}

const PORT = Number(process.env.PORT || 3000);

/* 2. Inicia o servidor principal (que já cria data/cordis.sqlite ao iniciar) */
require('./server.js');

/* 3. Abre o túnel público online após o servidor subir */
setTimeout(() => {
  console.log('\n============================================================');
  console.log('🚀 CORDIS (DISCORD TOTAL) ONLINE NO VS CODE!');
  console.log('------------------------------------------------------------');
  console.log(`💻 Seu acesso local:        http://localhost:${PORT}`);
  console.log(`🗄️  Painel do Banco SQL:     http://localhost:${PORT}/db`);
  console.log(`📁 Arquivo do Banco criado: data/cordis.sqlite`);
  console.log('------------------------------------------------------------');
  console.log('🌐 Gerando link PÚBLICO ONLINE para seus amigos...');
  console.log('============================================================\n');

  startPublicTunnel(PORT);
}, 1200);

function startPublicTunnel(port) {
  let tunnelResolved = false;

  // Tenta primeiro localhost.run via SSH nativo do Windows/Mac/Linux (sem tela de senha)
  try {
    const ssh = spawn(
      'ssh',
      [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ServerAliveInterval=30',
        '-R', `80:localhost:${port}`,
        'nokey@localhost.run',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const onOutput = (chunk) => {
      const text = chunk.toString();
      // O localhost.run devolve links de ajuda (admin.localhost.run); o endereço
      // real do túnel é algo como https://398245674463db.lhr.life
      const match = text.match(/https:\/\/[a-z0-9]+\.lhr\.life/) ||
                    text.match(/https:\/\/(?!admin)[a-z0-9-]+\.localhost\.run/);
      if (match && !tunnelResolved) {
        tunnelResolved = true;
        printPublicUrl(match[0], 'Túnel Direto HTTPS (sem senha)');
      }
    };

    ssh.stdout.on('data', onOutput);
    ssh.stderr.on('data', onOutput);
    ssh.on('error', () => {
      if (!tunnelResolved) startLocalTunnelFallback(port, () => (tunnelResolved = true));
    });
    ssh.on('exit', () => {
      if (!tunnelResolved) startLocalTunnelFallback(port, () => (tunnelResolved = true));
    });

    // Se em 7 segundos o SSH não tiver devolvido URL, usa o fallback localtunnel
    setTimeout(() => {
      if (!tunnelResolved) {
        try { ssh.kill(); } catch {}
        startLocalTunnelFallback(port, () => (tunnelResolved = true));
      }
    }, 7000);
  } catch {
    startLocalTunnelFallback(port, () => (tunnelResolved = true));
  }
}

async function startLocalTunnelFallback(port, markResolved) {
  try {
    const localtunnel = require('localtunnel');
    const tunnel = await localtunnel({ port });
    markResolved();
    printPublicUrl(tunnel.url, 'LocalTunnel HTTPS');
    tunnel.on('close', () => {
      console.log('⚠️ Túnel online fechado. Reconectando...');
      setTimeout(() => startLocalTunnelFallback(port, () => {}), 2000);
    });
  } catch (e) {
    console.log('ℹ️ Não foi possível abrir o túnel automático.');
    console.log(`   O servidor segue acessível em http://localhost:${port}`);
    console.log('   No VS Code: aba PORTAS -> encaminhe a porta ' + port + ' -> visibilidade PÚBLICA.');
  }
}

function printPublicUrl(url, provider) {
  const line = '═'.repeat(68);
  console.log('\n╔' + line + '╗');
  console.log('║ 🌍 SEU SERVIDOR ESTÁ ONLINE NA INTERNET!');
  console.log('╠' + line + '╣');
  console.log('║ 🔗 Link para mandar aos seus amigos:');
  console.log('║');
  console.log('║    👉  ' + url);
  console.log('║');
  console.log('╠' + line + '╣');
  console.log('║ 🗄️  Ver tabelas do Banco SQL: http://localhost:' + PORT + '/db');
  console.log('║ 📡 Modo de conexão: ' + provider);
  console.log('║ ⏹  Para parar o servidor: aperte Ctrl + C nesta janela');
  console.log('╚' + line + '╝\n');
}
