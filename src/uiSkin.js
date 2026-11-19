// Shared painted-console skin for browser Canvas and the WeChat adapter.
let frameImage = null;
if (typeof Image !== 'undefined') {
  const image = new Image();
  image.onload = () => { frameImage = image; };
  image.src = 'assets/ui_console_frame.png';
}

export const CONSOLE_SKIN = {
  ink: '#f1ecda', muted: '#bcc6b6', surface: '#1d211f', edge: '#879384',
  neutral: '#47554d', primary: '#356b58', danger: '#744339', amber: '#e7bd69',
};

export function drawEnamelPlate(ctx, x, y, w, h, fill = CONSOLE_SKIN.neutral, edge = CONSOLE_SKIN.edge, pressed = false) {
  const c = Math.min(6, w / 5, h / 5);
  ctx.save();
  ctx.beginPath(); ctx.moveTo(x + c, y); ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c); ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h); ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c); ctx.lineTo(x, y + c); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#111715'; ctx.stroke();
  ctx.strokeStyle = edge; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = pressed ? '#0003' : '#fff2'; ctx.fillRect(x + c, y + 2, w - c * 2, 2);
  ctx.fillStyle = '#0005'; ctx.fillRect(x + c, y + h - 4, w - c * 2, 3);
  if (w >= 44 && h >= 44) {
    ctx.fillStyle = '#b0a783'; ctx.fillRect(x + 4, y + 5, 2, 2); ctx.fillRect(x + w - 6, y + h - 7, 2, 2);
  }
  ctx.restore();
}

export function drawConsoleFrame(ctx, x, y, w, h, edge = 12) {
  if (!frameImage || w < 32 || h < 32) {
    drawEnamelPlate(ctx, x, y, w, h, CONSOLE_SKIN.surface); return;
  }
  // Nine-slice keeps screws and bevels proportional on both wide and small panels.
  const sw = frameImage.width, sh = frameImage.height, sx = sw * .12, sy = sh * .12;
  const e = Math.min(edge, w / 4, h / 4), xs = [0, sx, sw - sx, sw], ys = [0, sy, sh - sy, sh];
  const dx = [x, x + e, x + w - e, x + w], dy = [y, y + e, y + h - e, y + h];
  ctx.save(); ctx.imageSmoothingEnabled = true;
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    ctx.drawImage(frameImage, xs[col], ys[row], xs[col + 1] - xs[col], ys[row + 1] - ys[row],
      dx[col], dy[row], dx[col + 1] - dx[col], dy[row + 1] - dy[row]);
  }
  ctx.restore();
}

export function drawConsoleBar(ctx, x, y, w, h, ratio, color) {
  ctx.save(); ctx.fillStyle = '#101714'; ctx.fillRect(x, y, w, h);
  const amount = Math.max(0, Math.min(1, ratio));
  ctx.fillStyle = color; ctx.fillRect(x + 2, y + 2, Math.max(0, (w - 4) * amount), Math.max(1, h - 4));
  ctx.fillStyle = '#ffffff35'; ctx.fillRect(x + 2, y + 2, Math.max(0, (w - 4) * amount), 2);
  ctx.fillStyle = '#10171488';
  for (let mark = 1; mark < 10; mark++) ctx.fillRect(x + w * mark / 10, y + 2, 1, h - 4);
  ctx.strokeStyle = '#7e8a72'; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, w - 1, h - 1);
  ctx.restore();
}
