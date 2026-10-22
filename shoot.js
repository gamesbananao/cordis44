/* Capturas de tela do Cordis rework */
const { chromium } = require('playwright-core');
const BASE = 'http://localhost:3000';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctxA = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  const ctxB = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();

  // 1) login
  await A.goto(BASE);
  await A.waitForTimeout(700);
  await A.screenshot({ path: 'shots/01-login.png' });

  // 2) estado vazio (nada pré-pronto)
  await A.click('#auth-toggle');
  await A.fill('#auth-user', 'Ana');
  await A.fill('#auth-email', `ana${Date.now()}@cordis.app`);
  await A.fill('#auth-pass', '1234');
  await A.click('#auth-submit');
  await A.waitForSelector('#app');
  await A.waitForTimeout(500);
  await A.screenshot({ path: 'shots/02-vazio.png' });

  // 3) servidor + chat completo
  await A.click('#rail-add');
  await A.click('.cm-item:has-text("Criar meu servidor")');
  await A.fill('#g-name', 'Cordis Dev');
  await A.fill('#g-icon', '🚀');
  await A.click('.modal [data-ok]');
  await A.waitForSelector('#ch-name');
  await A.fill('#ch-name', 'geral');
  await A.click('.modal [data-ok]');
  await A.waitForTimeout(400);
  await A.click('#sidebar-header');
  await A.click('.cm-item:has-text("Criar canal de voz")');
  await A.fill('#ch-name', 'Sala de Voz');
  await A.click('.modal [data-ok]');
  await A.waitForTimeout(400);

  // B entra
  await A.click('#h-invite');
  await A.waitForSelector('#inv-link');
  const code = (await A.$eval('#inv-link', (el) => el.value)).split('invite=')[1];
  await A.keyboard.press('Escape');
  await B.goto(BASE);
  await B.click('#auth-demo');
  await B.waitForSelector('#app');
  await B.click('#rail-add');
  await B.click('.cm-item:has-text("Entrar com convite")');
  await B.fill('#join-code', code);
  await B.click('.modal [data-ok]');
  await B.waitForTimeout(600);
  await B.click('.chan:has-text("geral")');
  await B.waitForTimeout(300);

  // conversa bonita
  await B.fill('#chat-input', 'fala galera, testando o **Cordis** 🚀');
  await B.keyboard.press('Enter');
  await A.waitForTimeout(200);
  await A.fill('#chat-input', 'eaaa! olha só: `markdown`, ~~riscado~~ e ||spoiler|| 😄');
  await A.keyboard.press('Enter');
  await A.waitForTimeout(200);
  await B.fill('#chat-input', 'show!! vou ligar a câmera lá na call 📷');
  await B.keyboard.press('Enter');
  await A.waitForTimeout(300);
  // reação na primeira msg
  await A.locator('.msg').first().hover();
  await A.locator('.msg').first().locator('[data-a="react"]').click();
  await A.waitForSelector('.emoji-pop');
  await A.click('.emoji-grid button >> nth=3');
  await A.waitForTimeout(300);
  await A.screenshot({ path: 'shots/03-chat.png' });

  // 4) chamada com câmera + tela
  await B.click('.chan:has-text("sala-de-voz")');
  await B.waitForSelector('#stage:not(.hidden)');
  await B.click('#call-bar [data-c="cam"]');
  await B.waitForTimeout(800);
  await A.click('.chan:has-text("sala-de-voz")');
  await A.waitForSelector('#stage:not(.hidden)');
  await A.waitForTimeout(1500);
  await A.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 960; c.height = 540;
    const g = c.getContext('2d');
    let t = 0;
    (function draw() {
      t += 1;
      const grad = g.createLinearGradient(0, 0, 960, 540);
      grad.addColorStop(0, '#5865f2'); grad.addColorStop(1, '#eb459e');
      g.fillStyle = grad; g.fillRect(0, 0, 960, 540);
      g.fillStyle = '#fff'; g.font = 'bold 54px sans-serif';
      g.fillText('COMPARTILHANDO TELA', 160, 300);
      g.fillStyle = 'rgba(255,255,255,.35)';
      g.fillRect((t * 6) % 1100 - 140, 380, 140, 24);
      requestAnimationFrame(draw);
    })();
    navigator.mediaDevices.getDisplayMedia = async () => c.captureStream(30);
  });
  await A.click('#call-bar [data-c="screen"]');
  await A.waitForFunction(() => document.querySelector('.video-tile.has-screen'), null, { timeout: 5000 }).catch(() => {});
  await A.waitForTimeout(2500);
  await A.screenshot({ path: 'shots/04-chamada.png' });

  // 5) perfil popout
  await A.click('#call-bar [data-c="hang"]');
  await A.click('.chan:has-text("geral")');
  await A.waitForTimeout(400);
  await A.locator('.msg .m-author').last().click();
  await A.waitForSelector('.profile-pop');
  await A.mouse.move(20, 400);
  await A.waitForTimeout(500);
  await A.screenshot({ path: 'shots/05-perfil.png' });

  await browser.close();
  console.log('capturas salvas em shots/');
})().catch((e) => { console.error(e); process.exit(1); });
